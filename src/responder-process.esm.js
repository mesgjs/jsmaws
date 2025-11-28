/**
 * JSMAWS Responder Process
 * Unprivileged service process for executing applets and handling requests
 *
 * This process:
 * - Runs with dropped privileges (unprivileged uid/gid)
 * - Spawns applet workers on-demand to handle requests
 * - Receives request messages from operator via IPC
 * - Sends response messages back to operator via IPC
 * - Implements tiered response chunking with flow-control
 * - Reports capacity and backpressure state for load balancing
 * - Supports streaming, SSE, and WebSocket connections
 *
 * Architecture:
 * - Direct applet spawning (no intermediate wrapper)
 * - One-shot workers for regular requests (security/isolation)
 * - Long-lived workers for streaming/WebSocket connections
 * - Process-level module caching (automatic via Deno)
 * - Process-level backpressure detection and signaling
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';
import {
	MessageType,
	createResponse,
	createFrame,
	createError,
	validateMessage,
} from './ipc-protocol.esm.js';
import { ServiceProcess } from './service-process.esm.js';

/**
 * Responder process class
 * Spawns applet workers on-demand to handle requests
 */
class ResponderProcess extends ServiceProcess {
	constructor (processId, poolName) {
		super('responder', processId);
		this.poolName = poolName || Deno.env.get('JSMAWS_POOL') || 'standard';

		// Track active requests and workers
		this.activeRequests = new Map(); // requestId -> { worker, timeout, isStreaming }
		this.requestCount = 0;
		this.maxConcurrentRequests = 10; // Will be set from pool config

		// Track bidirectional connections
		this.bidiConnections = new Map(); // id → connection state

		// Response chunking configuration
		this.chunkingConfig = {
			maxDirectWrite: 65536, // 64KB
			autoChunkThresh: 10485760, // 10MB
			chunkSize: 65536, // 64KB
			bpWriteTimeThresh: 50, // ms - write time indicating backpressure
		};

		// Backpressure detection (based on write timing)
		this.isBackpressured = false;
		this.recentWriteTimes = []; // Track recent write durations
		this.maxRecentWrites = 5;
	}

	/**
	 * Backpressure-context-aware available workers
	 */
	bpAvailWorkers () {
		return this.isBackpressured ? 0 : (this.maxConcurrentRequests - this.activeRequests.size);
	}

	/**
	 * Handle configuration update from operator
	 */
	async handleConfigUpdate (fields) {
		console.log(`[${this.processId}] Received configuration update`);

		// Configuration instance is already updated by ServiceProcess base class
		// Just need to extract relevant settings

		// Update response chunking configuration from config
		const chunking = this.config.chunking;
		this.chunkingConfig = {
			maxDirectWrite: chunking.maxDirectWrite,
			autoChunkThresh: chunking.autoChunkThresh,
			chunkSize: chunking.chunkSize,
			bpWriteTimeThresh: chunking.bpWriteTimeThresh,
		};

		// Update max concurrent requests from pool config
		const poolConfig = this.config.getPoolConfig(this.poolName);
		if (poolConfig) {
			this.maxConcurrentRequests = poolConfig.at('maxWorkers', 10);
		}

		console.log(`[${this.processId}] Configuration updated`);
	}

	/**
	 * Spawn applet worker for request handling
	 */
	spawnAppletWorker (appletPath) {
		// Determine permissions based on applet path
		const isUrlBased = appletPath.startsWith('https://') || appletPath.startsWith('http://');

		const permissions = {
			read: isUrlBased ? false : [appletPath],
			net: true, // Always allow network for module loading
			write: false,
			run: false,
			env: false,
		};

		// Create Web Worker for applet
		const worker = new Worker(appletPath, {
			type: 'module',
			deno: { permissions },
		});

		return worker;
	}

	/**
		* Get message handlers for responder-specific messages
		*/
	getMessageHandlers () {
		const baseHandlers = super.getMessageHandlers();

		// Add responder-specific handler
		baseHandlers.set(MessageType.WEB_REQUEST, async (id, fields, binaryData) => {
			await this.handleWebRequest(id, fields, binaryData);
		});

		return baseHandlers;
	}

	/**
		* Handle web request from operator
		*/
	async handleWebRequest (id, fields, binaryData) {
		try {
			// Validate required fields
			validateMessage({ fields }, ['method', 'path', 'app', 'pool']);

			// Check if we're at capacity
			if (this.activeRequests.size >= this.maxConcurrentRequests) {
				console.warn(`[${this.processId}] At capacity (${this.activeRequests.size}/${this.maxConcurrentRequests}), returning 503`);
				await this.sendErrorResponse(id, 503, 'Service Unavailable');
				return;
			}

			const method = fields.at('method');
			const path = fields.at('path');
			const app = fields.at('app');
			const root = fields.at('root'); // Route-specific root (local or global)
			const headers = fields.at('headers') || new NANOS();
			const params = fields.at('params') || new NANOS();
			const query = fields.at('query') || new NANOS();
			const tail = fields.at('tail', '');

			console.log(`[${this.processId}] Request: ${method.toUpperCase()} ${path} -> ${app}`);

			// Spawn applet worker
			const worker = this.spawnAppletWorker(app);

			// Get request timeout from pool config
			const poolConfig = this.config.getPoolConfig(this.poolName);
			const reqTimeout = poolConfig?.at('reqTimeout', 30) || 30;

			// Set up timeout
			const timeout = setTimeout(() => {
				if (this.activeRequests.has(id)) {
					console.warn(`[${this.processId}] Request ${id} timed out`);
					worker.terminate();
					this.activeRequests.delete(id);
					this.sendErrorResponse(id, 504, 'Gateway Timeout').catch(console.error);
				}
			}, reqTimeout * 1000);

			// Track active request
			this.activeRequests.set(id, { worker, timeout, isStreaming: false });

			// Handle messages from applet worker
			worker.onmessage = async (event) => {
				await this.handleAppletMessage(id, event.data);
			};

			// Handle worker errors
			worker.onerror = async (error) => {
				console.error(`[${this.processId}] Worker error for request ${id}:`, error);
				clearTimeout(timeout);
				this.activeRequests.delete(id);
				await this.sendErrorResponse(id, 500, 'Internal Server Error');
			};

			// Convert headers and params to plain objects for applet
			const headersObj = headers instanceof NANOS
				? Object.fromEntries(headers.namedEntries())
				: {};

			const paramsObj = params instanceof NANOS
				? Object.fromEntries(params.namedEntries())
				: {};

			const queryObj = query instanceof NANOS
				? Object.fromEntries(query.namedEntries())
				: {};

			// Check for built-in applets and prepare configuration
			let builtinConfig = null;
			if (app === '@static') {
				const mimeTypes = this.config.mimeTypes;
				builtinConfig = {
					root: root || this.config.routing.root, // Use route root or fall back to global
					mimeTypes: mimeTypes.toSLID(), // Serialize NANOS to SLID for worker
				};
			}

			// Send request to applet worker
			const requestMsg = {
				type: 'request',
				id,
				method: method.toUpperCase(),
				path,
				headers: headersObj,
				params: paramsObj,
				query: queryObj,
				tail,
				body: binaryData,
				maxChunkSize: this.chunkingConfig.chunkSize, // Hard security limit
			};

			// Add config for built-in applets only
			if (builtinConfig) {
				requestMsg.config = builtinConfig;
			}

			worker.postMessage(requestMsg);

		} catch (error) {
			console.error(`[${this.processId}] Request handling error:`, error);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
		}
	}

	/**
	 * Handle message from applet worker
	 */
	async handleAppletMessage (id, data) {
		const { type } = data;

		if (type !== 'frame' && type !== 'error') {
			console.warn(`[${this.processId}] Unknown message type: ${type}`);
			return;
		}

		const requestInfo = this.activeRequests.get(id);
		if (!requestInfo) {
			console.warn(`[${this.processId}] Received message for unknown request ${id}`);
			return;
		}

		try {
			if (type === 'error') {
				await this.handleAppletError(id, data, requestInfo);
			} else {
				await this.handleFrame(id, data, requestInfo);
			}
		} catch (error) {
			console.error(`[${this.processId}] Error handling applet message:`, error);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
			this.cleanupRequest(id);
		}
	}

	/**
	 * Handle error response from applet
	 */
	async handleAppletError (id, data, requestInfo) {
		const { error, stack } = data;
		console.error(`[${this.processId}] Applet error for request ${id}:`, error);
		if (stack) console.error(stack);

		clearTimeout(requestInfo.timeout);
		this.activeRequests.delete(id);
		requestInfo.worker.terminate();

		await this.sendErrorResponse(id, 500, 'Internal Server Error');
	}

	/**
	 * Handle frame from applet (unified frame protocol)
	 * Note: final defaults to false if omitted - only final: true triggers frame completion
	 */
	async handleFrame (id, data, requestInfo) {
		const { mode, status, headers, data: frameData, final, keepAlive } = data;

		// First frame - establish connection
		if (mode !== undefined) {
			await this.handleFirstFrame(id, data, requestInfo);
			return;
		}

		// Enforce maxChunkSize limit (DoS protection)
		if (frameData && frameData.length > this.chunkingConfig.chunkSize) {
			console.warn(`[${this.processId}] Frame chunk exceeds maxChunkSize (${frameData.length} > ${this.chunkingConfig.chunkSize}), terminating applet`);
			this.cleanupRequest(id);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
			return;
		}

		// Handle based on mode
		if (requestInfo.mode === 'bidi') {
			await this.handleBidiFrame(id, frameData, final, keepAlive, requestInfo);
			return;
		}

		// Handle response/stream modes (accumulate and forward)
		if (frameData) {
			requestInfo.frameBuffer.push(frameData);
			requestInfo.totalBuffered += frameData.length;
		}

		// If accumulated data exceeds autoChunkThresh, start forwarding immediately
		if (requestInfo.totalBuffered >= this.chunkingConfig.autoChunkThresh) {
			await this.flushFrameBuffer(id, requestInfo, false);
		}

		// If final frame message (final is truthy), flush remaining buffer
		// It defaults to false, allowing applets to send multiple chunks without specifying final: false each time
		if (final) {
			await this.flushFrameBuffer(id, requestInfo, true);

			// Update keepAlive status if specified
			if (keepAlive !== undefined) {
				requestInfo.keepAlive = keepAlive;
			}

			// Cleanup if not keepAlive
			if (!requestInfo.keepAlive) {
				clearTimeout(requestInfo.timeout);
				this.activeRequests.delete(id);
				requestInfo.worker.terminate();
			}
		}
	}

	/**
	 * Handle first frame (establishes connection)
	 */
	async handleFirstFrame (id, data, requestInfo) {
		const { mode, status, headers, keepAlive, data: frameData, final } = data;

		// Store connection state
		requestInfo.mode = mode;
		requestInfo.keepAlive = keepAlive !== undefined ? keepAlive : false;
		requestInfo.frameBuffer = [];
		requestInfo.totalBuffered = 0;

		// Send HTTP response headers to operator
		await this.sendResponse(id, { status, headers, body: null });

		// Handle bidi mode initialization
		if (mode === 'bidi' && status === 101) {
			await this.initializeBidiConnection(id, requestInfo);
		}

		// Process any data in first frame
		if (frameData || final) {
			await this.handleFrame(id, { data: frameData, final, keepAlive }, requestInfo);
		}
	}

	/**
	 * Handle bidirectional frame (mode: 'bidi')
	 */
	async handleBidiFrame (id, frameData, final, keepAlive, requestInfo) {
		let conn = this.bidiConnections.get(id);

		// First bidi frame - initialize connection
		if (!conn) {
			await this.initializeBidiConnection(id, requestInfo);
			conn = this.bidiConnections.get(id);
		}

		const chunkSize = frameData?.length || 0;

		// Check if applet has sufficient credits
		if (conn.outboundCredits < chunkSize) {
			// Insufficient credits - buffer the chunk
			conn.outboundBuffer.push({ frameData, final, keepAlive });
			conn.totalBuffered.outbound += chunkSize;

			// Check buffer limit (DoS protection)
			if (conn.totalBuffered.outbound > conn.maxBufferSize) {
				console.warn(`[${this.processId}] Bidi ${id} outbound buffer exceeded, terminating`);
				this.closeBidiConnection(id, 'Buffer overflow');
				return;
			}

			return; // Don't forward yet
		}

		// Consume credits (byte-based)
		conn.outboundCredits -= chunkSize;

		// Forward chunk to operator using unified frame protocol
		const frameMsg = createFrame(id, {
			data: frameData,
			final,
			...(keepAlive !== undefined && { keepAlive })
		});
		await this.ipcConn.writeMessage(frameMsg, frameData);

		// Update last activity
		conn.lastActivity = Date.now();

		// Handle connection close
		if (final && keepAlive === false) {
			this.closeBidiConnection(id, 'Normal closure');
		}
	}

	/**
	 * Initialize bidirectional connection
	 */
	async initializeBidiConnection (id, requestInfo) {
		const maxChunkSize = this.chunkingConfig.chunkSize;
		const bidiConfig = this.config.bidiFlowControl || {};
		const initialCredits = (bidiConfig.initialCredits || 10) * maxChunkSize;

		const connState = {
			worker: requestInfo.worker,
			outboundCredits: initialCredits,
			inboundCredits: initialCredits,
			outboundBuffer: [],
			inboundBuffer: [],
			maxBufferSize: bidiConfig.maxBufferSize || 1048576,
			totalBuffered: { outbound: 0, inbound: 0 },
			maxCredits: initialCredits,
			maxBytesPerSecond: bidiConfig.maxBytesPerSecond || 10485760,
			idleTimeout: bidiConfig.idleTimeout || 60,
			lastActivity: Date.now()
		};

		this.bidiConnections.set(id, connState);

		// Send protocol parameters to applet (first frame from responder)
		requestInfo.worker.postMessage({
			type: 'frame',
			id,
			mode: 'bidi',
			initialCredits,
			maxChunkSize,
			maxBytesPerSecond: connState.maxBytesPerSecond,
			idleTimeout: connState.idleTimeout,
			maxBufferSize: connState.maxBufferSize,
			data: null,
			final: false,
			keepAlive: true
		});

		// Send protocol parameters to operator (via IPC) - second frame after status 101
		const frameMsg = createFrame(id, {
			final: false,
			keepAlive: true,
			initialCredits,
			maxChunkSize,
			maxBytesPerSecond: connState.maxBytesPerSecond,
			idleTimeout: connState.idleTimeout,
			maxBufferSize: connState.maxBufferSize
		});
		await this.ipcConn.writeMessage(frameMsg);
	}

	/**
	 * Close bidirectional connection
	 */
	closeBidiConnection (id, reason) {
		const conn = this.bidiConnections.get(id);
		if (!conn) return;

		console.log(`[${this.processId}] Closing bidi connection ${id}: ${reason}`);

		// Terminate worker
		conn.worker.terminate();

		// Cleanup
		this.bidiConnections.delete(id);
		this.activeRequests.delete(id);
	}

	/**
	 * Handle inbound frame from operator (client → applet)
	 */
	async handleOperatorBidiFrame (id, frameData, final) {
		const conn = this.bidiConnections.get(id);
		if (!conn) return;

		const chunkSize = frameData?.length || 0;

		// Check if client has sufficient credits to send to applet
		if (conn.inboundCredits < chunkSize) {
			// Insufficient credits - buffer the chunk
			conn.inboundBuffer.push({ frameData, final });
			conn.totalBuffered.inbound += chunkSize;

			// Check buffer limit
			if (conn.totalBuffered.inbound > conn.maxBufferSize) {
				console.warn(`[${this.processId}] Bidi ${id} inbound buffer exceeded, terminating`);
				this.closeBidiConnection(id, 'Buffer overflow');
				return;
			}

			return;
		}

		// Consume credits (byte-based)
		conn.inboundCredits -= chunkSize;

		// Forward to applet
		conn.worker.postMessage({
			type: 'frame',
			id,
			mode: 'bidi',
			data: frameData,
			final,
			keepAlive: true
		});

		// Applet implicitly grants credits by processing chunk
		// Grant credits back when applet finishes processing
		conn.inboundCredits = Math.min(
			conn.inboundCredits + chunkSize,
			conn.maxCredits
		);

		// Update last activity
		conn.lastActivity = Date.now();
	}

	/**
	 * Flush frame buffer to operator with chunking optimization
	 */
	async flushFrameBuffer (id, requestInfo, final) {
		if (!requestInfo.frameBuffer || requestInfo.frameBuffer.length === 0) {
			if (final) {
				// Send final frame signal even if no data
				const frameMsg = createFrame(id, { data: null, final: true });
				await this.ipcConn.writeMessage(frameMsg);
			}
			return;
		}

		// Concatenate accumulated frame chunks
		const totalSize = requestInfo.totalBuffered;
		const combined = new Uint8Array(totalSize);
		let offset = 0;

		for (const chunk of requestInfo.frameBuffer) {
			combined.set(chunk, offset);
			offset += chunk.length;
		}

		// Clear buffer
		requestInfo.frameBuffer = [];
		requestInfo.totalBuffered = 0;

		// Apply responder's chunking logic to forward to operator
		if (totalSize < this.chunkingConfig.maxDirectWrite) {
			// Small: Direct write
			const frameMsg = createFrame(id, { data: combined, final });
			const startTime = performance.now();
			await this.ipcConn.writeMessage(frameMsg, combined);
			const writeDuration = performance.now() - startTime;
			this.detectBackpressure(writeDuration);
		} else if (totalSize < this.chunkingConfig.autoChunkThresh) {
			// Medium: Direct write with backpressure detection
			const frameMsg = createFrame(id, { data: combined, final });
			const startTime = performance.now();
			await this.ipcConn.writeMessage(frameMsg, combined);
			const writeDuration = performance.now() - startTime;
			this.detectBackpressure(writeDuration);
		} else {
			// Large: Send in chunks to operator
			await this.sendInChunks(id, combined, final);
		}
	}

	/**
	 * Send data in chunks to operator
	 */
	async sendInChunks (id, data, final) {
		const { chunkSize } = this.chunkingConfig;
		let offset = 0;

		while (offset < data.length) {
			const end = Math.min(offset + chunkSize, data.length);
			const chunk = data.slice(offset, end);
			const isLast = (end === data.length) && final;

			const frameMsg = createFrame(id, { data: chunk, final: isLast });
			const startTime = performance.now();
			await this.ipcConn.writeMessage(frameMsg, chunk);
			const writeDuration = performance.now() - startTime;

			this.detectBackpressure(writeDuration);

			offset = end;

			// Yield to event loop
			await new Promise(resolve => setTimeout(resolve, 0));
		}
	}

	/**
	 * Cleanup request resources
	 */
	cleanupRequest (id) {
		const requestInfo = this.activeRequests.get(id);
		if (requestInfo) {
			clearTimeout(requestInfo.timeout);
			requestInfo.worker.terminate();
			this.activeRequests.delete(id);
		}
	}

	/**
	 * Send response with tiered chunking
	 */
	async sendResponse (id, result) {
		const { status, headers, body } = result;
		const bodySize = body ? body.length : 0;

		// Calculate available capacity
		// Report backpressure state at process level
		const availableWorkers = this.bpAvailWorkers();

		// Create response message
		const response = createResponse(
			id,
			status,
			headers,
			bodySize,
			availableWorkers,
			this.maxConcurrentRequests,
			0 // No queue in this architecture
		);

		// Tier 1: Small responses (< maxDirectWrite)
		if (bodySize < this.chunkingConfig.maxDirectWrite) {
			const startTime = performance.now();
			await this.ipcConn.writeMessage(response, body);
			const writeDuration = performance.now() - startTime;

			// Update backpressure state based on write timing
			this.detectBackpressure(writeDuration);
			return;
		}

		// Tier 2/3: Larger responses with flow-control
		await this.respondWithFlowControl(response, body);
	}

	/**
	 * Detect backpressure based on write timing
	 * Similar to Node.js streams pattern - slow writes indicate backpressure
	 */
	detectBackpressure (writeDuration) {
		// Track recent write times
		this.recentWriteTimes.push(writeDuration);
		if (this.recentWriteTimes.length > this.maxRecentWrites) {
			this.recentWriteTimes.shift();
		}

		// Calculate average write time
		const avgWriteTime = this.recentWriteTimes.reduce((a, b) => a + b, 0) / this.recentWriteTimes.length;

		// If average write time exceeds threshold, we're experiencing backpressure
		// (Unix pipe buffers are typically 64KB, should write quickly if not full)
		this.isBackpressured = avgWriteTime > this.chunkingConfig.bpWriteTimeThresh;
	}

	/**
	 * Respond with flow-control (backpressure detection or chunking)
	 */
	async respondWithFlowControl (response, body) {
		const bodySize = body.length;
		const { autoChunkThresh, chunkSize } = this.chunkingConfig;

		// Tier 2: Medium responses (maxDirectWrite - autoChunkThresh)
		// Write directly but monitor timing for backpressure detection
		if (bodySize < autoChunkThresh) {
			const startTime = performance.now();
			await this.ipcConn.writeMessage(response, body);
			const writeDuration = performance.now() - startTime;

			// Update backpressure state based on write timing
			this.detectBackpressure(writeDuration);

			return;
		}

		// Tier 3: Large responses (>= autoChunkThresh)
		// Stream in chunks with event loop yielding
		await this.ipcConn.writeMessage(response, null);

		let offset = 0;
		while (offset < bodySize) {
			const end = Math.min(offset + chunkSize, bodySize);
			const chunk = body.slice(offset, end);

			// Time the write operation
			const startTime = performance.now();
			await this.ipcConn.conn.write(chunk);
			const writeDuration = performance.now() - startTime;

			// Update backpressure state based on write timing
			this.detectBackpressure(writeDuration);

			offset = end;

			// Yield to event loop to process other requests
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	/**
	 * Send error response
	 */
	async sendErrorResponse (id, status, message) {
		// Report backpressure state at process level
		const availableWorkers = this.bpAvailWorkers();

		const errorBody = new TextEncoder().encode(JSON.stringify({ error: message }));
		const response = createResponse(
			id,
			status,
			{ 'Content-Type': 'application/json' },
			errorBody.length,
			availableWorkers,
			this.maxConcurrentRequests,
			0 // No queue in this architecture
		);

		const startTime = performance.now();
		await this.ipcConn.writeMessage(response, errorBody);
		const writeDuration = performance.now() - startTime;

		// Update backpressure state based on write timing
		this.detectBackpressure(writeDuration);
	}

	/**
	 * Handle health check from operator
	 */
	async handleHealthCheck (id, fields) {
		console.log(`[${this.processId}] Health check received`);

		// Report backpressure state at process level
		const availableWorkers = this.bpAvailWorkers();

		// Create health check response
		const response = new NANOS(MessageType.HEALTH_CHECK, { id });
		response.setOpts({ transform: true });
		response.push([{
			timestamp: fields.at('timestamp'),
			status: 'ok',
			availableWorkers,
			totalWorkers: this.maxConcurrentRequests,
			requestsQueued: 0, // No queue in this architecture
			activeRequests: this.activeRequests.size,
			activeBidiConns: this.bidiConnections.size,
			uptime: Math.floor(performance.now() / 1000),
			backpressured: this.isBackpressured,
		}]);

		await this.ipcConn.writeMessage(response);
	}

	/**
	 * Handle shutdown request from operator
	 */
	async handleShutdown (fields) {
		const timeout = fields.at('timeout', 30);
		console.log(`[${this.processId}] Shutdown requested (timeout: ${timeout}s)`);

		this.isShuttingDown = true;

		// Wait for active requests to complete (with timeout)
		const shutdownStart = Date.now();
		while (this.activeRequests.size > 0 && (Date.now() - shutdownStart) < timeout * 1000) {
			console.log(`[${this.processId}] Waiting for ${this.activeRequests.size} active requests...`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		// Terminate any remaining workers
		for (const [id, requestInfo] of this.activeRequests.entries()) {
			console.log(`[${this.processId}] Terminating worker for request ${id}`);
			clearTimeout(requestInfo.timeout);
			requestInfo.worker.terminate();
		}
		this.activeRequests.clear();
		this.bidiConnections.clear();

		// Close IPC connection
		if (this.ipcConn) {
			await this.ipcConn.close();
		}

		console.log(`[${this.processId}] Shutdown complete`);
		Deno.exit(0);
	}

	/**
		* Log startup information after configuration is loaded
		*/
	async onStarted () {
		console.log(`[${this.processId}] Pool: ${this.poolName}, max concurrent: ${this.maxConcurrentRequests}`);
	}
}

/**
 * Main entry point
 */
async function main () {
	const processId = Deno.env.get('JSMAWS_PID'); // process id string
	const poolName = Deno.env.get('JSMAWS_POOL');
	await ServiceProcess.run(ResponderProcess, processId, poolName);
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing
export { ResponderProcess };
