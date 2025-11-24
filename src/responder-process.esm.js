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
	createChunk,
	createStreamData,
	createStreamClose,
	createWebSocketUpgrade,
	createWebSocketData,
	createWebSocketClose,
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
		this.activeWebSockets = new Map(); // requestId -> worker
		this.requestCount = 0;
		this.maxConcurrentRequests = 10; // Will be set from pool config

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
			const headersObj = {};
			if (headers && typeof headers.toObject === 'function') {
				Object.assign(headersObj, headers.toObject());
			}
			
			const paramsObj = {};
			if (params && typeof params.toObject === 'function') {
				Object.assign(paramsObj, params.toObject());
			}
			
			const queryObj = {};
			if (query && typeof query.toObject === 'function') {
				Object.assign(queryObj, query.toObject());
			}

			// Send request to applet worker
			worker.postMessage({
				type: 'request',
				id,
				method: method.toUpperCase(),
				path,
				headers: headersObj,
				params: paramsObj,
				query: queryObj,
				tail,
				body: binaryData,
			});

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
		const requestInfo = this.activeRequests.get(id);
		
		if (!requestInfo) {
			console.warn(`[${this.processId}] Received message for unknown request ${id}`);
			return;
		}

		try {
			switch (type) {
				case 'response':
					await this.handleAppletResponse(id, data, requestInfo);
					break;
					
				case 'error':
					await this.handleAppletError(id, data, requestInfo);
					break;
					
				case 'chunk':
					await this.handleAppletChunk(id, data, requestInfo);
					break;
					
				case 'stream-data':
					await this.handleAppletStreamData(id, data, requestInfo);
					break;
					
				case 'stream-close':
					await this.handleAppletStreamClose(id, requestInfo);
					break;
					
				case 'ws-upgrade':
					await this.handleAppletWebSocketUpgrade(id, data, requestInfo);
					break;
					
				case 'ws-send':
					await this.handleAppletWebSocketSend(id, data);
					break;
					
				case 'ws-close':
					await this.handleAppletWebSocketClose(id, data, requestInfo);
					break;
					
				default:
					console.warn(`[${this.processId}] Unknown applet message type: ${type}`);
			}
		} catch (error) {
			console.error(`[${this.processId}] Error handling applet message:`, error);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
			this.cleanupRequest(id);
		}
	}

	/**
	 * Handle regular HTTP response from applet
	 */
	async handleAppletResponse (id, data, requestInfo) {
		const { status, statusText, headers, body, chunked, keepAlive } = data;
		
		// If this is a chunked or streaming response, mark as streaming
		if (chunked || keepAlive) {
			requestInfo.isStreaming = true;
			// Don't cleanup yet - more data coming
		} else {
			// Regular response - cleanup after sending
			clearTimeout(requestInfo.timeout);
			this.activeRequests.delete(id);
			requestInfo.worker.terminate();
		}

		// Send response to operator
		await this.sendResponse(id, { status, statusText, headers, body }, !chunked && !keepAlive);
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
	 * Handle chunk from applet (for chunked responses)
	 */
	async handleAppletChunk (id, data, requestInfo) {
		const { data: chunkData, final } = data;
		
		// Send chunk via IPC
		const chunkMsg = createChunk(id, chunkData, final);
		await this.ipcConn.writeMessage(chunkMsg, chunkData);
		
		if (final || chunkData === null) {
			// Last chunk - cleanup
			clearTimeout(requestInfo.timeout);
			this.activeRequests.delete(id);
			requestInfo.worker.terminate();
		}
	}

	/**
	 * Handle streaming data from applet (SSE, etc.)
	 */
	async handleAppletStreamData (id, data) {
		const { data: streamData } = data;
		
		// Send stream data via IPC
		if (streamData) {
			const streamMsg = createStreamData(id, streamData);
			await this.ipcConn.writeMessage(streamMsg, streamData);
		}
	}

	/**
	 * Handle stream close from applet
	 */
	async handleAppletStreamClose (id, requestInfo) {
		// Send stream close via IPC
		const closeMsg = createStreamClose(id);
		await this.ipcConn.writeMessage(closeMsg);
		
		clearTimeout(requestInfo.timeout);
		this.activeRequests.delete(id);
		requestInfo.worker.terminate();
	}

	/**
	 * Handle WebSocket upgrade from applet
	 */
	async handleAppletWebSocketUpgrade (id, data, requestInfo) {
		const { protocol } = data;
		
		// Mark as WebSocket connection (long-lived)
		requestInfo.isStreaming = true;
		this.activeWebSockets.set(id, requestInfo.worker);
		
		// Send WebSocket upgrade via IPC
		const upgradeMsg = createWebSocketUpgrade(id, protocol);
		await this.ipcConn.writeMessage(upgradeMsg);
		
		console.log(`[${this.processId}] WebSocket upgrade for request ${id}, protocol: ${protocol}`);
	}

	/**
	 * Handle WebSocket send from applet
	 */
	async handleAppletWebSocketSend (id, data) {
		const { opcode, data: wsData } = data;
		
		// Send WebSocket data via IPC
		const wsMsg = createWebSocketData(id, opcode, wsData);
		await this.ipcConn.writeMessage(wsMsg, wsData);
		
		console.log(`[${this.processId}] WebSocket send for ${id}, opcode: ${opcode}`);
	}

	/**
	 * Handle WebSocket close from applet
	 */
	async handleAppletWebSocketClose (id, data, requestInfo) {
		const { code, reason } = data;
		
		// Send WebSocket close via IPC
		const closeMsg = createWebSocketClose(id, code, reason);
		await this.ipcConn.writeMessage(closeMsg);
		
		clearTimeout(requestInfo.timeout);
		this.activeRequests.delete(id);
		this.activeWebSockets.delete(id);
		requestInfo.worker.terminate();
		
		console.log(`[${this.processId}] WebSocket close for ${id}, code: ${code}, reason: ${reason}`);
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
		this.activeWebSockets.delete(id);
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
			activeWebSockets: this.activeWebSockets.size,
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
		this.activeWebSockets.clear();

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
	const processId = Deno.env.get('JSMAWS_PID');
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
