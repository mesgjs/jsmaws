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
	createFrame,
	createError,
	createAppletOutput,
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
		if (typeof poolName !== 'string' || !poolName) throw new Error('ResponderProcess missing required pool name');
		this.poolName = poolName;

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
		console.info(`[${this.processId}] Received configuration update`);

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

		console.debug(`[${this.processId}] Configuration updated`);
	}

	/**
	 * Spawn applet worker for request handling
	 * Uses bootstrap module to lock down environment before applet loads
	 */
	spawnAppletWorker (appletPath) {
		// Determine permissions based on applet path
		let readAny = false, keepDeno = false;
		switch (appletPath) {
		case '@static':
			appletPath = './applets/static-content.esm.js';
			readAny = keepDeno = true;
			break;
		}
		const appletURL = new URL(appletPath, import.meta.url);
		const appletHref = appletURL.href;
		const isUrlBased = appletHref.startsWith('https://') || appletHref.startsWith('http://');
		const bootstrapURL = new URL('./applets/bootstrap.esm.js', import.meta.url);

		const readable = [bootstrapURL.pathname];
		if (!isUrlBased) readable.push(appletURL.pathname);

		const permissions = {
			read: readAny || readable,
			net: true, // Always allow network for module loading
			write: false,
			run: false,
			env: false,
		};

		// Create Web Worker with bootstrap module (not applet directly)
		const worker = new Worker(bootstrapURL.href, {
			type: 'module',
			deno: { permissions },
		});

		if (worker) {
			console.debug(`[${this.processId}] Created worker with bootstrap for applet "${appletPath}"`);

			// Send bootstrap message with applet path
			worker.postMessage({
				type: 'bootstrap',
				appletPath: appletHref,
				keepDeno,
			});
		} else {
			console.error(`[${this.processId}] Failed to create worker for applet "${appletPath}"`);
		}

		return worker;
	}

	/**
	 * Get message handlers for responder-specific messages
	 */
	getMessageHandlers () {
		const baseHandlers = super.getMessageHandlers();

		// Add responder-specific handlers
		baseHandlers.set(MessageType.WEB_REQUEST, async (id, fields, binaryData) => {
			await this.handleWebRequest(id, fields, binaryData);
		});

		baseHandlers.set(MessageType.WEB_FRAME, async (id, fields, binaryData) => {
			// Handle incoming bidi frames from operator (client to applet)
			const final = fields.at('final', false);
			await this.handleOperatorBidiFrame(id, binaryData, final);
		});

		return baseHandlers;
	}

	/**
	 * Handle web request from operator
	 */
	async handleWebRequest (id, fields, binaryData) {
		try {
			// Validate required fields
			validateMessage({ fields }, ['method', 'url', 'app', 'pool']);

			// Check if we're at capacity
			if (this.activeRequests.size >= this.maxConcurrentRequests) {
				console.warn(`[${this.processId}] At capacity (${this.activeRequests.size}/${this.maxConcurrentRequests}), returning 503`);
				await this.sendErrorResponse(id, 503, 'Service Unavailable');
				return;
			}

			const method = fields.at('method');
			const url = fields.at('url');           // Complete URL
			const app = fields.at('app');
			const root = fields.at('root'); // Route-specific root (local or global)
			const headers = fields.at('headers') || new NANOS();
			const routeParams = fields.at('routeParams') || new NANOS();  // Renamed from params
			const routeTail = fields.at('routeTail', '');                 // Renamed from tail
			const routeSpec = fields.at('routeSpec');  // Route specification for timeout resolution

			const urlObj = new URL(url);
			console.log(`[${this.processId}] Request: ${method.toUpperCase()} ${urlObj.pathname} -> ${app}`);

			// Spawn applet worker
			const worker = this.spawnAppletWorker(app);

			// Resolve timeout configuration with hierarchy: route > pool > global
			const timeouts = this.config.getTimeoutConfig(this.poolName, routeSpec);
			const { reqTimeout, idleTimeout, conTimeout } = timeouts;

			console.debug(`[${this.processId}] Timeouts: req=${reqTimeout}s, idle=${idleTimeout}s, con=${conTimeout}s`);

			// Set up request timeout
			const timeout = reqTimeout ? setTimeout(() => {
				if (this.activeRequests.has(id)) {
					// Warn? Or debug?
					console.warn(`[${this.processId}] Request ${id} timed out after ${reqTimeout}s`);
					this.cleanupRequest(id);
					this.sendErrorResponse(id, 504, 'Gateway Timeout').catch(console.error);
				}
			}, reqTimeout * 1000) : null;

			// Track active request with timeout configuration and routeSpec
			this.activeRequests.set(id, {
				worker,
				timeout,
				isStreaming: false,
				timeouts: { reqTimeout, idleTimeout, conTimeout },
				routeSpec  // Store for bidi params resolution
			});

			// Handle messages from applet worker
			worker.onmessage = (event) => {
				console.debug(`[${this.processId}] Worker onmessage fired for request ${id}`);
				this.handleAppletMessage(id, event.data);
			};

			// Handle worker errors
			worker.onerror = (error) => {
				console.error(`[${this.processId}] Worker error for request ${id}:`, error);
				this.cleanupRequest(id);
				this.sendErrorResponse(id, 500, 'Internal Server Error');
			};

			// Convert headers and routeParams to plain objects for applet postMessage
			const headersObj = headers?.size ? headers.toObject({ array: true }) : {};
			const routeParamsObj = routeParams?.size ? routeParams.toObject() : {};

			// Check for built-in applets and prepare configuration
			let builtinConfig = null;
			if (app === '@static') {
				const mimeTypes = this.config.mimeTypes || {};
				builtinConfig = {
					root,
					mimeTypes: mimeTypes.toSLID(), // Serialize NANOS to SLID for worker
				};
			}

			// Send request to applet worker
			const requestMsg = {
				type: 'request',
				id,
				method: method.toUpperCase(),
				url,                                    // Complete URL
				headers: headersObj,
				routeParams: routeParamsObj,            // Renamed from params
				routeTail,                              // Renamed from tail
				body: binaryData,
				timeouts: {                             // Pass all timeout values
					request: reqTimeout,
					idle: idleTimeout,
					connection: conTimeout,
				},
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

		console.debug(`[${this.processId}] Received message from applet: type=${type}, id=${id}`);

		// Handle console output from bootstrap
		if (type === 'console') {
			await this.handleAppletConsoleOutput(id, data);
			return;
		}

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
	 * Handle console output from applet (via bootstrap)
	 * Operator has applet path from routing and process ID from IPC handler binding
	 */
	async handleAppletConsoleOutput (id, data) {
		const { level, content } = data;

		// Forward to operator via IPC using proper message creation
		const outputMsg = createAppletOutput(id, { level });
		const binaryData = new TextEncoder().encode(content);

		await this.ipcConn.writeMessage(outputMsg, binaryData);
	}

	/**
	 * Handle error response from applet
	 */
	async handleAppletError (id, data, requestInfo) {
		const { error, stack } = data;
		console.error(`[${this.processId}] Applet error for request ${id}:`, error);
		if (stack) console.error(stack);

		this.cleanupRequest(id);
		await this.sendErrorResponse(id, 500, 'Internal Server Error');
	}

	/**
	 * Handle frame from applet (unified frame protocol)
	 * Note: final defaults to false if omitted - only final: true triggers frame completion
	 */
	async handleFrame (id, data, requestInfo) {
		const { mode, status, headers, data: frameData, final, keepAlive } = data;

		// Clear idle timeout when new frame arrives (processing starts)
		if (requestInfo.idleTimeout) {
			this.clearIdleTimeout(id);
		}

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
			await this.flushFrameBuffer(id, requestInfo, true, keepAlive);

			// Update keepAlive status if specified
			if (keepAlive !== undefined) {
				requestInfo.keepAlive = keepAlive;
			}

			// Cleanup if not keepAlive
			if (!requestInfo.keepAlive) {
				this.cleanupRequest(id);
			} else if (requestInfo.timeouts.idleTimeout > 0) {
				// Restart idle timeout after sending final frame (between frames)
				requestInfo.idleTimeout = this.startIdleTimeout(id, requestInfo.timeouts.idleTimeout);
			}
		}
	}

	/**
	 * Start idle timeout for streaming/bidi connections
	 * Only active between frames, not during request processing
	 */
	startIdleTimeout (id, idleTimeout) {
		if (idleTimeout <= 0) return null;  // Disabled

		return setTimeout(() => {
			const requestInfo = this.activeRequests.get(id);
			if (requestInfo && requestInfo.keepAlive) {
				console.debug(`[${this.processId}] Connection ${id} idle timeout after ${idleTimeout}s`);
				this.cleanupRequest(id);
				this.sendErrorResponse(id, 408, 'Request Timeout').catch(console.error);
			}
		}, idleTimeout * 1000);
	}

	/**
	 * Clear idle timeout (called when new frame arrives)
	 */
	clearIdleTimeout (id) {
		const requestInfo = this.activeRequests.get(id);
		if (requestInfo && requestInfo.idleTimeout) {
			clearTimeout(requestInfo.idleTimeout);
			requestInfo.idleTimeout = null;
		}
	}

	/**
	 * Start connection timeout for streaming/bidi connections
	 */
	startConnectionTimeout (id, conTimeout) {
		if (conTimeout <= 0) return null;  // Disabled

		return setTimeout(() => {
			const requestInfo = this.activeRequests.get(id);
			if (requestInfo && requestInfo.keepAlive) {
				console.debug(`[${this.processId}] Connection ${id} lifetime timeout after ${conTimeout}s`);
				this.cleanupRequest(id);
				this.sendErrorResponse(id, 408, 'Request Timeout').catch(console.error);
			}
		}, conTimeout * 1000);
	}

	/**
	 * Handle first frame (establishes connection)
	 */
	async handleFirstFrame (id, data, requestInfo) {
		const { mode, status, headers, keepAlive, data: frameData, final } = data;

		console.log(`[${this.processId}] First frame: mode=${mode}, status=${status}, final=${final}, keepAlive=${keepAlive}, dataSize=${frameData?.length || 0}`);

		// Determine effective response type
		// mode=response keepAlive=true makes it streaming
		const effectiveType = (mode === 'response' && keepAlive) ? 'stream': mode;

		// Check if pool allows this response type
		const allowedTypes = this.config.getAllowedResponseTypes(this.poolName);
		if (!allowedTypes.has(effectiveType)) {
			console.error(
				`[${this.processId}] Pool "${this.poolName}" does not allow ` +
				`response type "${effectiveType}" (mode=${mode}, keepAlive=${keepAlive})`
			);
			this.cleanupRequest(id);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
			return;
		}

		// Enforce policy: status 101 (bidi upgrade) must not have data
		if (status === 101 && frameData && frameData.length > 0) {
			console.error(`[${this.processId}] Policy violation: status 101 frame must not contain data`);
			this.cleanupRequest(id);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
			return;
		}

		// Store connection state
		requestInfo.mode = mode;
		requestInfo.keepAlive = keepAlive !== undefined ? keepAlive : false;
		requestInfo.frameBuffer = [];
		requestInfo.totalBuffered = 0;

		// Start connection timeout for long-lived connections (runs for entire connection lifetime)
		if (requestInfo.keepAlive && requestInfo.timeouts.conTimeout > 0) {
			requestInfo.connectionTimeout = this.startConnectionTimeout(
				id,
				requestInfo.timeouts.conTimeout
			);
		}

		// Calculate available capacity for operator (backpressure-aware)
		const availableWorkers = this.bpAvailWorkers();

		// Send first frame to operator (unified protocol with capacity info)
		const firstFrameMsg = createFrame(id, {
			mode,
			status,
			headers,
			data: frameData,
			final: final ?? false,
			keepAlive,
			availableWorkers,
			totalWorkers: this.maxConcurrentRequests
		});

		console.debug(`[${this.processId}] Sending first frame to operator...`);
		await this.ipcConn.writeMessage(firstFrameMsg, frameData);
		console.debug(`[${this.processId}] First frame sent successfully`);

		// Handle bidi mode initialization
		if (mode === 'bidi' && status === 101) {
			await this.initializeBidiConnection(id, requestInfo);
			return; // Bidi initialization handles subsequent frames
		}

		// For response/stream modes, if first frame is final and not keepAlive, cleanup
		if (final && !requestInfo.keepAlive) {
			this.cleanupRequest(id);
		} else if (requestInfo.keepAlive && final && requestInfo.timeouts.idleTimeout > 0) {
			// Start idle timeout after sending final frame (between frames)
			requestInfo.idleTimeout = this.startIdleTimeout(id, requestInfo.timeouts.idleTimeout);
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
		// Get bidi parameters from configuration (same as operator will use)
		// routeSpec already contains pool name, so we can pass just routeSpec
		const bidiParams = this.config.getBidiParams({
			routeSpec: requestInfo.routeSpec
		});

		const connState = {
			worker: requestInfo.worker,
			outboundCredits: bidiParams.initialCredits,
			inboundCredits: bidiParams.initialCredits,
			outboundBuffer: [],
			inboundBuffer: [],
			maxBufferSize: bidiParams.maxBufferSize,
			totalBuffered: { outbound: 0, inbound: 0 },
			maxCredits: bidiParams.initialCredits,
			maxBytesPerSecond: bidiParams.maxBytesPerSecond,
			idleTimeout: bidiParams.idleTimeout,
			lastActivity: Date.now()
		};

		this.bidiConnections.set(id, connState);

		// Send protocol parameters to applet (first frame from responder)
		requestInfo.worker.postMessage({
			type: 'frame',
			id,
			mode: 'bidi',
			initialCredits: bidiParams.initialCredits,
			maxChunkSize: bidiParams.maxChunkSize,
			maxBytesPerSecond: bidiParams.maxBytesPerSecond,
			idleTimeout: bidiParams.idleTimeout,
			maxBufferSize: bidiParams.maxBufferSize,
			data: null,
			final: false,
			keepAlive: true
		});

		// NOTE: No longer send params frame to operator
		// The operator will derive the same params from configuration
	}

	/**
	 * Close bidirectional connection
	 */
	closeBidiConnection (id, reason) {
		const conn = this.bidiConnections.get(id);
		if (!conn) return;

		console.debug(`[${this.processId}] Closing bidi connection ${id}: ${reason}`);

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
		if (!conn) {
			// Connection doesn't exist - might have been closed already
			// Clean up active request if it still exists
			if (this.activeRequests.has(id)) {
				console.debug(`[${this.processId}] Cleaning up orphaned request ${id}`);
				this.cleanupRequest(id);
			}
			return;
		}

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

		// Handle connection close from client side
		// When operator detects WebSocket close, it should send a final frame
		if (final) {
			console.debug(`[${this.processId}] Bidi connection ${id} closed by client (final frame received)`);
			this.closeBidiConnection(id, 'Client closed connection');
		}
	}

	/**
	 * Flush frame buffer to operator with chunking optimization
	 */
	async flushFrameBuffer (id, requestInfo, final, keepAlive = undefined) {
		keepAlive = (keepAlive !== undefined) ? { keepAlive } : {};
		if (!requestInfo.frameBuffer || requestInfo.frameBuffer.length === 0) {
			if (final) {
				// Send final frame signal even if no data
				const frameMsg = createFrame(id, { data: null, final: true, ...keepAlive });
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
			const frameMsg = createFrame(id, { data: combined, final, ...keepAlive });
			const startTime = performance.now();
			await this.ipcConn.writeMessage(frameMsg, combined);
			const writeDuration = performance.now() - startTime;
			this.detectBackpressure(writeDuration);
		} else if (totalSize < this.chunkingConfig.autoChunkThresh) {
			// Medium: Direct write with backpressure detection
			const frameMsg = createFrame(id, { data: combined, final, ...keepAlive });
			const startTime = performance.now();
			await this.ipcConn.writeMessage(frameMsg, combined);
			const writeDuration = performance.now() - startTime;
			this.detectBackpressure(writeDuration);
		} else {
			// Large: Send in chunks to operator
			await this.sendInChunks(id, combined, final, keepAlive);
		}
	}

	/**
	 * Send data in chunks to operator
	 */
	async sendInChunks (id, data, final, keepAlive = {}) {
		const { chunkSize } = this.chunkingConfig;
		let offset = 0;

		while (offset < data.length) {
			const end = Math.min(offset + chunkSize, data.length);
			const chunk = data.slice(offset, end);
			const isLast = (end === data.length) && final;

			const frameMsg = createFrame(id, { data: chunk, final: isLast, ...keepAlive });
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
	 * Centralized cleanup for all request-related state
	 */
	cleanupRequest (id) {
		const requestInfo = this.activeRequests.get(id);
		if (requestInfo) {
			clearTimeout(requestInfo.timeout);           // Request timeout
			clearTimeout(requestInfo.idleTimeout);       // Idle timeout
			clearTimeout(requestInfo.connectionTimeout); // Connection timeout
			requestInfo.worker.terminate();
		}

		// Clean up all request-related state
		this.activeRequests.delete(id);
		this.bidiConnections.delete(id);
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
	 * Send error response using unified frame protocol
	 */
	async sendErrorResponse (id, status, message) {
		const errorBody = new TextEncoder().encode(JSON.stringify({ error: message }));

		// Send error as a single frame
		const frameMsg = createFrame(id, {
			mode: 'response',
			status,
			headers: { 'Content-Type': 'application/json' },
			data: errorBody,
			final: true,
			keepAlive: false
		});

		const startTime = performance.now();
		await this.ipcConn.writeMessage(frameMsg, errorBody);
		const writeDuration = performance.now() - startTime;

		// Update backpressure state based on write timing
		this.detectBackpressure(writeDuration);
	}

	/**
	 * Handle health check from operator
	 */
	async handleHealthCheck (id, fields) {
		console.debug(`[${this.processId}] Health check received`);

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
		console.info(`[${this.processId}] Shutdown requested (timeout: ${timeout}s)`);

		this.isShuttingDown = true;

		// Wait for active requests to complete (with timeout)
		const shutdownStart = Date.now();
		while (this.activeRequests.size > 0 && (Date.now() - shutdownStart) < timeout * 1000) {
			console.debug(`[${this.processId}] Waiting for ${this.activeRequests.size} active requests...`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		// Terminate any remaining workers and error-out their connections.
		const tasks = [];
		for (const [id, requestInfo] of this.activeRequests.entries()) {
			console.debug(`[${this.processId}] Terminating worker for request ${id}`);
			clearTimeout(requestInfo.timeout);
			requestInfo.worker.terminate();
			tasks.push(this.sendErrorResponse(id, 503, 'Service Unavailable').catch((e) => {}));
		}
		if (tasks.length) await Promise.all(tasks);
		this.activeRequests.clear();
		this.bidiConnections.clear();

		// Log shutdown complete BEFORE closing IPC (which closes stdout)
		console.info(`[${this.processId}] Shutdown complete`);

		// Close IPC connection (this closes stdout, so no more console.log after this)
		if (this.ipcConn) {
			await this.ipcConn.close();
		}

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
	console.debug(`Responder main pid ${processId} pool ${poolName}`);
	// TODO: poolName is always undefined?!
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
