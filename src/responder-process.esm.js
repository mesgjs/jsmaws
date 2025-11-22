/**
 * JSMAWS Responder Process
 * Unprivileged service process for executing applets and handling requests
 * 
 * This process:
 * - Runs with dropped privileges (unprivileged uid/gid)
 * - Hosts responder workers for request handling (managed by pool-manager)
 * - Receives request messages from operator via IPC
 * - Sends response messages back to operator via IPC
 * - Implements tiered response chunking with flow-control
 * - Reports worker capacity in responses for load balancing
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';
import {
	IPCConnection,
	MessageType,
	createResponse,
	validateMessage,
} from './ipc-protocol.esm.js';
import { PoolManager } from './pool-manager.esm.js';

/**
 * Responder worker wrapper
 * Wraps a Web Worker that executes applet code
 */
class ResponderWorker {
	constructor (workerId, workerUrl) {
		this.workerId = workerId;
		this.workerUrl = workerUrl;
		this.worker = null;
		this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
		this.config = null;
	}

	/**
	 * Initialize worker
	 */
	async initialize (config) {
		this.config = config;
		
		// Create Web Worker
		this.worker = new Worker(this.workerUrl, {
			type: 'module',
			deno: {
				permissions: {
					read: true,
					net: false,
					write: false,
					run: false,
					env: false,
				},
			},
		});

		// Handle messages from worker
		this.worker.onmessage = (event) => {
			this.handleWorkerMessage(event.data);
		};

		// Handle worker errors
		this.worker.onerror = (error) => {
			console.error(`[${this.workerId}] Worker error:`, error);
		};

		// Send initial configuration
		this.worker.postMessage({
			type: 'init',
			config: config.toSLID(),
		});

		console.log(`[${this.workerId}] Worker initialized`);
	}

	/**
	 * Handle message from worker
	 */
	handleWorkerMessage (data) {
		const { type, requestId, result, error } = data;

		if (type === 'response') {
			const pending = this.pendingRequests.get(requestId);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pendingRequests.delete(requestId);

				if (error) {
					pending.reject(new Error(error));
				} else {
					pending.resolve(result);
				}
			}
		}
	}

	/**
	 * Execute request in worker
	 */
	async executeRequest (requestId, requestData, reqTimeout) {
		return new Promise((resolve, reject) => {
			// Set timeout
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error('Request timeout'));
			}, reqTimeout * 1000);

			// Store pending request
			this.pendingRequests.set(requestId, { resolve, reject, timeout });

			// Send request to worker
			this.worker.postMessage({
				type: 'request',
				requestId,
				data: requestData,
			});
		});
	}

	/**
	 * Update worker configuration
	 */
	async updateConfig (config) {
		this.config = config;
		this.worker.postMessage({
			type: 'config',
			config: config.toSLID(),
		});
	}

	/**
	 * Terminate worker
	 */
	terminate () {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
	}
}

/**
 * Responder process class
 * Hosts responder workers in a pool for request execution
 */
class ResponderProcess {
	constructor (processId, poolName) {
		this.processId = processId || Deno.env.get('JSMAWS_PID') || `responder-${Date.now()}`;
		this.poolName = poolName || Deno.env.get('JSMAWS_POOL') || 'standard';
		this.config = new NANOS();
		this.ipcConn = null;
		this.isShuttingDown = false;
		this.poolManager = null;
		this.workerUrl = new URL('./responder-worker.esm.js', import.meta.url).href;
		
		// Response chunking configuration
		this.chunkingConfig = {
			maxDirectWrite: 65536, // 64KB
			autoChunkThresh: 10485760, // 10MB
			chunkSize: 65536, // 64KB
			maxWriteBuffer: 1048576, // 1MB (unused with timing-based detection)
			bpWriteTimeThresh: 50, // ms - write time indicating backpressure
		};
		
		// Backpressure detection (based on write timing)
		this.isBackpressured = false;
		this.recentWriteTimes = []; // Track recent write durations
		this.maxRecentWrites = 5;
	}

	/**
	 * Handle configuration update from operator
	 */
	async handleConfigUpdate (fields) {
		console.log(`[${this.processId}] Received configuration update`);

		// Extract configuration fields
		const pools = fields.at('pools');
		const mimeTypes = fields.at('mimeTypes');
		const routes = fields.at('routes');
		const chunking = fields.at('chunking');

		// Update configuration
		if (pools) this.config.set('pools', pools);
		if (mimeTypes) this.config.set('mimeTypes', mimeTypes);
		if (routes) this.config.set('routes', routes);

		// Update response chunking configuration
		if (chunking) {
			this.chunkingConfig = {
				maxDirectWrite: chunking.at('maxDirectWrite', 65536),
				autoChunkThresh: chunking.at('autoChunkThresh', 10485760),
				chunkSize: chunking.at('chunkSize', 65536),
				maxWriteBuffer: chunking.at('maxWriteBuffer', 1048576),
				bpWriteTimeThresh: chunking.at('bpWriteTimeThresh', 50),
			};
		}

		// Update pool manager if already initialized
		if (this.poolManager) {
			// Get pool config for this responder's pool
			const poolConfig = pools?.at(this.poolName) || {};
			await this.poolManager.updateConfig(poolConfig);

			// Update all workers with new configuration
			for (const item of this.poolManager.items.values()) {
				if (item.item instanceof ResponderWorker) {
					await item.item.updateConfig(this.config);
				}
			}
		}

		console.log(`[${this.processId}] Configuration updated`);
	}

	/**
	 * Handle web request from operator
	 */
	async handleWebRequest (id, fields, binaryData) {
		try {
			// Validate required fields
			validateMessage({ fields }, ['method', 'path', 'app', 'pool']);

			const method = fields.at('method');
			const path = fields.at('path');
			const app = fields.at('app');
			const headers = fields.at('headers') || new NANOS();
			const params = fields.at('params') || new NANOS();
			const tail = fields.at('tail', '');

			console.log(`[${this.processId}] Request: ${method.toUpperCase()} ${path} -> ${app}`);

			// Get available worker from pool
			const poolItem = await this.poolManager.getAvailableItem();

			if (!poolItem) {
				console.warn(`[${this.processId}] No available workers, returning 503`);
				await this.sendErrorResponse(id, 503, 'Service Unavailable');
				return;
			}

			try {
				// Mark worker as busy
				this.poolManager.markItemBusy(poolItem.id);

				// Prepare request data for worker
				const requestData = {
					method,
					path,
					app,
					headers: headers.toSLID(),
					params: params.toSLID(),
					tail,
					body: binaryData,
				};

				// Get request timeout from pool config
				const reqTimeout = this.config.at(['pools', this.poolName, 'reqTimeout'], 30);

				// Execute request in worker
				const result = await poolItem.item.executeRequest(id, requestData, reqTimeout);

				// Mark worker as idle
				await this.poolManager.markItemIdle(poolItem.id);

				// Send response with chunking
				await this.sendResponse(id, result);
			} catch (workerError) {
				// Mark worker as idle on error
				await this.poolManager.markItemIdle(poolItem.id);
				
				console.error(`[${this.processId}] Worker error:`, workerError);
				await this.sendErrorResponse(id, 500, 'Internal Server Error');
			}
		} catch (error) {
			console.error(`[${this.processId}] Request handling error:`, error);
			await this.sendErrorResponse(id, 500, 'Internal Server Error');
		}
	}

	/**
	 * Send response with tiered chunking
	 */
	async sendResponse (id, result) {
		const { status, headers, body } = result;
		const bodySize = body ? body.length : 0;

		// Get worker metrics for capacity reporting
		const metrics = this.poolManager.getMetrics();
		const workersAvailable = this.isBackpressured ? 0 : metrics.availableItems;

		// Create response message
		const response = createResponse(
			id,
			status,
			headers,
			bodySize,
			workersAvailable,
			metrics.totalItems,
			metrics.queuedRequests
		);

		// Tier 1: Small responses (< maxDirectWrite)
		if (bodySize < this.chunkingConfig.maxDirectWrite) {
			await this.ipcConn.writeMessage(response, body);
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
			
			// Detect backpressure based on write timing
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
			
			// Detect backpressure based on write timing
			this.detectBackpressure(writeDuration);

			// If backpressured, wait briefly before next chunk
			if (this.isBackpressured) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			offset = end;

			// Yield to event loop to process other requests
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}

	/**
	 * Send error response
	 */
	// A *LOT* of this looks like boilerplate. If that's an accurate assessment, let's do it right and create a base class.
	async sendErrorResponse (id, status, message) {
		const metrics = this.poolManager.getMetrics();
		const workersAvailable = this.isBackpressured ? 0 : metrics.availableItems;

		const errorBody = new TextEncoder().encode(JSON.stringify({ error: message }));
		const response = createResponse(
			id,
			status,
			{ 'Content-Type': 'application/json' },
			errorBody.length,
			workersAvailable,
			metrics.totalItems,
			metrics.queuedRequests
		);

		await this.ipcConn.writeMessage(response, errorBody);
	}

	/**
	 * Handle health check from operator
	 */
	async handleHealthCheck (id, fields) {
		console.log(`[${this.processId}] Health check received`);

		// Get worker stats from pool manager
		const metrics = this.poolManager.getMetrics();
		const workersAvailable = this.isBackpressured ? 0 : metrics.availableItems;

		// Create health check response
		const response = new NANOS(MessageType.HEALTH_CHECK, { id });
		response.setOpts({ transform: true });
		response.push([{
			timestamp: fields.at('timestamp'),
			status: 'ok',
			workersAvailable,
			workersTotal: metrics.totalItems,
			requestsQueued: metrics.queuedRequests,
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

		// Shutdown pool manager
		if (this.poolManager) {
			await this.poolManager.shutdown(timeout);
		}

		// Close IPC connection
		if (this.ipcConn) {
			await this.ipcConn.close();
		}

		console.log(`[${this.processId}] Shutdown complete`);
		Deno.exit(0);
	}

	/**
	 * Process incoming IPC messages
	 */
	async processMessages () {
		while (!this.isShuttingDown) {
			try {
				const result = await this.ipcConn.readMessage();

				if (!result) {
					// Connection closed
					console.log(`[${this.processId}] IPC connection closed`);
					break;
				}

				const { message, binaryData } = result;

				// Handle message based on type
				switch (message.type) {
					case MessageType.CONFIG_UPDATE:
						await this.handleConfigUpdate(message.fields);
						break;

					case MessageType.WEB_REQUEST:
						await this.handleWebRequest(message.id, message.fields, binaryData);
						break;

					case MessageType.HEALTH_CHECK:
						await this.handleHealthCheck(message.id, message.fields);
						break;

					case MessageType.SHUTDOWN:
						await this.handleShutdown(message.fields);
						break;

					default:
						console.warn(`[${this.processId}] Unknown message type: ${message.type}`);
				}
			} catch (error) {
				if (this.isShuttingDown) {
					break;
				}
				console.error(`[${this.processId}] Message processing error:`, error);
			}
		}
	}

	/**
	 * Start the responder process
	 */
	async start () {
		console.log(`[${this.processId}] Starting responder process (pool: ${this.poolName})...`);

		// Create IPC connection using stdin/stdout
		this.ipcConn = new IPCConnection({
			read: (buffer) => Deno.stdin.read(buffer),
			write: (data) => Deno.stdout.write(data),
			close: () => {
				Deno.stdin.close();
				Deno.stdout.close();
			},
		});

		console.log(`[${this.processId}] IPC connection established`);

		// Wait for initial configuration from operator
		console.log(`[${this.processId}] Waiting for initial configuration...`);
		const result = await this.ipcConn.readMessage();

		if (!result || result.message.type !== MessageType.CONFIG_UPDATE) {
			throw new Error('Expected initial configuration message');
		}

		// Handle initial configuration
		await this.handleConfigUpdate(result.message.fields);

		// Initialize pool manager with responder worker factory
		const poolConfig = this.config.at(['pools', this.poolName]) || {
			minProcs: 1,
			maxProcs: 10,
			scaling: 'dynamic',
			minWorkers: 1,
			maxWorkers: 4,
			maxReqs: 100,
			idleTimeout: 300,
			reqTimeout: 30,
		};

		const workerFactory = async (itemId) => {
			const worker = new ResponderWorker(itemId, this.workerUrl);
			await worker.initialize(this.config);
			return { item: worker, isWorker: true };
		};

		this.poolManager = new PoolManager(this.poolName, poolConfig, workerFactory);
		await this.poolManager.initialize();

		console.log(`[${this.processId}] Responder process started successfully`);

		// Process incoming messages
		await this.processMessages();
	}
}

/**
 * Main entry point
 */
async function main () {
	const processId = Deno.env.get('JSMAWS_PID');
	const poolName = Deno.env.get('JSMAWS_POOL');
	const responderProcess = new ResponderProcess(processId, poolName);

	// Handle shutdown signals
	const shutdownHandler = async () => {
		await responderProcess.handleShutdown(new NANOS());
	};

	Deno.addSignalListener('SIGINT', shutdownHandler);
	Deno.addSignalListener('SIGTERM', shutdownHandler);

	// Start the responder process
	await responderProcess.start();
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing
export { ResponderProcess, ResponderWorker };
