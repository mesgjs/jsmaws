/**
 * JSMAWS Responder Process
 * Unprivileged sub-process for executing mod-apps and handling requests
 *
 * This process:
 * - Runs with dropped privileges (unprivileged uid/gid)
 * - Spawns mod-app workers on-demand to handle requests
 * - Receives request messages from operator via PipeTransport req-N channels
 * - Sends response messages back to operator via the same req-N channels
 * - Implements tiered response chunking
 * - Reports capacity state for load balancing
 * - Supports streaming, SSE, and WebSocket connections
 *
 * Architecture:
 * - Direct mod-app spawning (no intermediate wrapper)
 * - One-shot workers for regular requests (security/isolation)
 * - Long-lived workers for streaming/WebSocket connections
 * - Process-level module caching (automatic via Deno)
 * - Responder ↔ Mod-App communication via PostMessageTransport (PolyTransport)
 * - Operator ↔ Responder communication via PipeTransport (PolyTransport)
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '@poly-transport/channel.esm.js';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { SubProcess } from './sub-process.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from './request-channel-pool.esm.js';
import { BOOT_CHANNEL_MESSAGE_TYPES } from './apps/bootstrap.esm.js';

const APP_CHANNEL_MESSAGE_TYPES = ['req', 'res', 'res-frame', 'res-error', 'bidi-frame'];

/**
 * Responder process class
 * Spawns mod-app workers on-demand to handle requests
 */
export class ResponderProcess extends SubProcess {
	static WORKER_IDLE_CHECK_INTERVAL = 10000; // 10s

	constructor (processId, poolName) {
		super('responder', processId);
		if (typeof poolName !== 'string' || !poolName) throw new Error('ResponderProcess missing required pool name');
		this.poolName = poolName;

		// Track active requests and workers
		this.activeRequests = new Map(); // requestId -> { worker, transport, reqChannel, timeout, isStreaming }
		this.workerInfo = new Map(); // worker -> workerInfo
		this.workersByApp = new Map(); // appPath -> Array<workerInfo>
		this.channelMap = new Map(); // channel -> requestId
		this.requestCount = 0;
		this.maxConcurrentRequests = 10; // Will be set from pool config

		// Chunk size for PolyTransport (maxChunkBytes)
		// PolyTransport handles chunking; we only need to know the chunk size
		this.chunkingConfig = {
			chunkSize: 65536, // 64KB default; updated from config
		};

		// Drain promise for shutdown (resolved when all requests complete)
		this.drainResolvers = null;
		this.workerIdleCleanupInterval = null;
	}

	/**
	 * Available workers (concurrent request slots remaining)
	 */
	get availWorkers () {
		return this.maxConcurrentRequests - this.activeRequests.size;
	}

	/**
	 * Clean up idle persistent workers that have exceeded the idle timeout.
	 * @param {number} timeoutSeconds - Idle timeout in seconds
	 */
	#cleanupIdlePersistentWorkers (timeoutSeconds) {
		const now = Date.now();
		const timeoutMs = timeoutSeconds * 1000;

		for (const [app, workers] of this.workersByApp.entries()) {
			const activeWorkers = [];

			for (const w of workers) {
				if (w.status === 'idle' && (now - w.lastUsed) >= timeoutMs) {
					console.debug(`[${this.processId}] Terminating idle persistent worker for "${app}" (idle for ${Math.round((now - w.lastUsed) / 1000)}s)`);
					w.worker.terminate();
					w.transport.stop({ disconnected: true }).catch(() => {});
				} else {
					activeWorkers.push(w);
				}
			}
			if (activeWorkers.length === 0) {
				this.workersByApp.delete(app);
			} else {
				this.workersByApp.set(app, activeWorkers);
			}
		}
	}

	/**
	 * Cleanup request resources.
	 * Clears timeouts, terminates the worker, and initiates a disconnected
	 * transport stop.  The 'stopped' event listener (set up in
	 * #setupWorkerTerminationHandler) is responsible for sending a 503 error
	 * response (if no response was started) and removing the entry from
	 * activeRequests.
	 *
	 * Idempotent: guarded by requestInfo.cleaningUp.
	 */
	cleanupRequest (id) {
		const requestInfo = this.activeRequests.get(id);

		if (!requestInfo || requestInfo.cleaningUp) return;
		requestInfo.cleaningUp = true;

		clearTimeout(requestInfo.timeout);           // Request timeout
		clearTimeout(requestInfo.idleTimeout);       // Idle timeout
		clearTimeout(requestInfo.connectionTimeout); // Connection timeout

		const workerInfo = requestInfo.workerInfo;
		if (workerInfo) {
			workerInfo.worker?.terminate();

			// Disconnected stop triggers the 'stopped' event, which handles
			// the 503 response (if needed) and removes the entry from activeRequests.
			workerInfo.transport?.stop({ disconnected: true }).catch(() => {});
		}
	}

	/**
	 * Handle configuration update from operator.
	 * Called after this.config has been updated by the SubProcess base class.
	 */
	async handleConfigUpdate () {
		console.debug(`[${this.processId}] Received configuration update`);

		// Update chunk size from config (PolyTransport handles chunking; we only need maxChunkBytes)
		this.chunkingConfig = {
			chunkSize: this.config.chunkSize,
		};

		// Update max concurrent requests from pool config
		const poolConfig = this.config.getPoolConfig(this.poolName);

		if (poolConfig) {
			this.maxConcurrentRequests = poolConfig.maxWorkers ?? 10;
		} else {
			console.warn(`[${this.processId}] Pool config not found for '${this.poolName}', keeping default ${this.maxConcurrentRequests}`);
		}

		// Start or stop persistent worker idle cleanup timer as needed
		const workerIdleTimeout = this.config.getWorkerIdleTimeout(this.poolName);

		if (workerIdleTimeout > 0 && !this.workerIdleCleanupInterval) {
			this.workerIdleCleanupInterval = setInterval(() => {
				this.#cleanupIdlePersistentWorkers(workerIdleTimeout);
			}, ResponderProcess.WORKER_IDLE_CHECK_INTERVAL); // Check every 10 seconds
		} else if (this.workerIdleCleanupInterval && !workerIdleTimeout) {
			clearInterval(this.workerIdleCleanupInterval);
			this.workerIdleCleanupInterval = null;
		}

		console.debug(`[${this.processId}] Configuration updated`);

		// Send capacity update so the operator knows we are ready to accept requests.
		// This also serves as a "ready" signal after the initial config-update.
		await this.sendCapacityUpdate(this.availWorkers, this.maxConcurrentRequests);
	}

	/**
	 * Handle health check from operator.
	 * @param {object} msg - PolyTransport message (from control channel)
	 */
	async handleHealthCheck (msg) {
		console.debug(`[${this.processId}] Health check received`);

		// Send health response via control channel
		const availableWorkers = this.availWorkers;

		await this.controlChannel.write('health-response', JSON.stringify({
			status: 'ok',
			availableWorkers,
			totalWorkers: this.maxConcurrentRequests,
			activeRequests: this.activeRequests.size,
			uptime: Math.floor(performance.now() / 1000),
		}));

		// Also send capacity update
		await this.sendCapacityUpdate(availableWorkers, this.maxConcurrentRequests);
	}

	/**
	 * Handle an accepted req-N channel.
	 * Sets up message types and starts the request read loop.
	 * @param {object} reqChannel - PolyTransport channel
	 */
	async handleReqChannel (reqChannel) {
		if (reqChannel.state !== Channel.STATE_OPEN) return;
		await reqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);

		// Loop 1: 'req' messages (dechunked by default — full message reassembly)
		// 'req' payload is JSON text; decode via VirtualBuffer.decode()
		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: 'req' });

				if (!msg) break;
				await msg.process(async () => {
					await this.#onWebRequest(reqChannel, msg.data.decode());
				});
			}
		})();

		// Loop 2: 'bidi-frame' relay (dechunk: false — forward chunks verbatim)
		// bidi-frame carries NestedTransport byte-stream traffic; chunks must not be
		// reassembled before forwarding to the mod-app's app channel.
		(async () => {
			// console.log('*** hndReqCh (res client -> app) bidi-relay ready');
			let requestId = null; // Unknown until channel is assigned

			while (true) {
				const msg = await reqChannel.read({ only: 'bidi-frame', dechunk: false });

				if (!msg) break;
				// console.log('*** Res Cli->App bidi relay', msg.dataSize);
				requestId ??= this.channelMap.get(reqChannel);
				await msg.process(async () => {
					await this.#onOperatorBidiFrame(requestId, msg.data);
				});
			}
		})();
	}

	/**
	 * Handle request completion for persistent or one-shot workers.
	 * @param {string|number} id - Request ID
	 */
	async #handleRequestCompletion (id) {
		const requestInfo = this.activeRequests.get(id);

		if (!requestInfo) return;

		// Clear request timeout
		clearTimeout(requestInfo.timeout);

		const workerInfo = requestInfo.workerInfo;

		if (workerInfo && workerInfo.isPersistent) {
			// Check maxWorkerReqs recycling
			const maxWorkerReqs = this.config.getMaxWorkerReqs(this.poolName);
			const shouldRecycle = maxWorkerReqs > 0 && workerInfo.reqCount >= maxWorkerReqs;

			if (shouldRecycle) {
				console.debug(`[${this.processId}] Recycling persistent worker (reached maxWorkerReqs: ${maxWorkerReqs})`);
				this.cleanupRequest(id);
			} else {
				// Mark as resetting so it won't be selected for new requests while resetting
				workerInfo.status = 'resetting';
				workerInfo.activeRequest = null;

				// Close and reopen appChannel, and reassign message types
				if (workerInfo.appChannel) {
					await workerInfo.appChannel.close().catch(() => {});
				}

				try {
					const appChannel = await workerInfo.transport.requestChannel('app');
					await appChannel.addMessageTypes(APP_CHANNEL_MESSAGE_TYPES);
					workerInfo.appChannel = appChannel;
					workerInfo.status = 'idle';
					workerInfo.lastUsed = Date.now();
				} catch (err) {
					console.error(`[${this.processId}] Failed to reset appChannel for persistent worker:`, err);
					this.cleanupRequest(id);
					return;
				}

				// Remove from active requests so capacity is updated, but do NOT terminate worker
				this.activeRequests.delete(id);
			}
		} else {
			// One-shot worker: cleanup immediately
			this.cleanupRequest(id);
		}
	}

	/**
	 * Handle shutdown request from operator.
	 * @param {object} msg - PolyTransport message
	 */
	async handleShutdown (msg) {
		const { deadline, spread } = this.shutdownMesgDeadline(msg);

		msg?.done();

		const remainingMs = Math.max(0, deadline - Date.now());
		const remainingSec = Math.ceil(remainingMs / 1000);

		console.info(`[${this.processId}] Shutdown requested (${remainingSec}s)`);

		const modAppDeadline = deadline - (spread ?? 0) * 1000;

		this.isShuttingDown = true;

		// Clear persistent worker idle cleanup timer
		if (this.workerIdleCleanupInterval) {
			clearInterval(this.workerIdleCleanupInterval);
			this.workerIdleCleanupInterval = null;
		}

		// Phase 1: Terminate idle workers and notify busy ones of impending shutdown
		for (const [worker, workerInfo] of this.workerInfo.entries()) {
			if (workerInfo.status === 'idle') {
				console.debug(`[${this.processId}] Terminating idle persistent worker for "${workerInfo.app}" during shutdown`);
				workerInfo.worker.terminate();
				workerInfo.transport.stop({ disconnected: true }).catch(() => {});
			} else if (workerInfo.status === 'busy' && workerInfo.bootstrapChannel) {
				await workerInfo.bootstrapChannel.write('shutdown', JSON.stringify({ deadline: modAppDeadline }))
					.catch(() => {});
			}
		}
		this.workersByApp.clear();

		// Phase 2: wait for active requests to drain (with timeout)
		if (this.activeRequests.size > 0) {
			// Set up periodic reporting
			const reportInterval = setInterval(() => {
				if (this.activeRequests.size > 0) {
					console.debug(`[${this.processId}] Waiting for ${this.activeRequests.size} active request(s)...`);
				}
			}, 1000);

			// Create drain promise (resolved by #onAppTransportStopped when all requests complete)
			this.drainResolvers = Promise.withResolvers();

			const drainPromise = this.drainResolvers.promise;

			// Create deadline promise
			const deadlinePromise = new Promise((resolve) => {
				const remaining = Math.max(0, modAppDeadline - Date.now());

				setTimeout(resolve, remaining);
			});

			// Wait for all requests to complete OR deadline to be reached
			await Promise.race([drainPromise, deadlinePromise]);
			clearInterval(reportInterval);
		}

		// Phase 3: hard-terminate any workers still running after the deadline.
		// stop({ disconnected: true }) overrides the in-progress graceful stop
		// and triggers the 'stopped' event, which handles 503 + state cleanup.
		// Collect the disconnected-stop promises so we can await them below.
		const stopPromises = [];

		for (const [worker, workerInfo] of this.workerInfo.entries()) {
			console.debug(`[${this.processId}] Hard-terminating worker for "${workerInfo.app}"`);
			workerInfo.worker?.terminate();
			if (workerInfo.transport) {
				stopPromises.push(workerInfo.transport.stop({ disconnected: true }).catch(() => {}));
			}
		}

		// Phase 4: await all stop promises — ensures every 'stopped' event and
		// its handler (503 response + activeRequests cleanup) has completed
		// before we tear down the operator transport.
		await Promise.all(stopPromises);

		// Log shutdown complete BEFORE stopping transport
		console.info(`[${this.processId}] Shutdown complete`);

		// Stop operator transport (graceful drain)
		if (this.transport) {
			await this.transport.stop();
		}

		console.debug(`[${this.processId}] Exiting`);
		Deno.exit(0);
	}

	/**
	 * Handle error response ('res-error' message) from mod-app.
	 * @param {string|number} id - Request ID
	 * @param {string} errorJson - JSON-encoded error
	 * @param {object} requestInfo - Active request info
	 */
	async #onAppResError (id, errorJson, requestInfo) {
		let errorData;

		try {
			errorData = JSON.parse(errorJson);
		} catch (_) {
			errorData = { error: errorJson };
		}
		console.error(`[${this.processId}] Mod-app error for request ${id}:`, errorData.error);
		if (errorData.stack) console.error(errorData.stack);

		// Send error first (sets responseStarted), then abort the worker.
		await this.#sendErrorResponse(requestInfo.reqChannel, id, 500, 'Internal Server Error');
		this.cleanupRequest(id);
	}

	/**
	 * Handle response metadata ('res' message) from mod-app.
	 * Sends the response metadata to the operator via the req-N channel.
	 * @param {string|number} id - Request ID
	 * @param {string} resJson - JSON-encoded response metadata
	 * @param {object} requestInfo - Active request info
	 */
	async #onAppResMeta (id, resJson, requestInfo) {
		const { status, headers, mode, keepAlive } = JSON.parse(resJson);

		console.debug(`[${this.processId}] Response metadata: status=${status}, mode=${mode}, keepAlive=${keepAlive}`);

		// Determine effective response type
		const effectiveType = (mode === 'response' && keepAlive) ? 'stream' : (mode || 'response');

		// Check if pool allows this response type
		const allowedTypes = this.config.getAllowedResponseTypes(this.poolName);

		if (!allowedTypes.has(effectiveType)) {
			console.error(
				`[${this.processId}] Pool "${this.poolName}" does not allow ` +
				`response type "${effectiveType}" (mode=${mode}, keepAlive=${keepAlive})`
			);
			// Send error first (sets responseStarted), then abort the worker.
			await this.#sendErrorResponse(requestInfo.reqChannel, id, 500, 'Internal Server Error');
			this.cleanupRequest(id);
			return;
		}

		if (status === 101) {
			// Bidi upgrade — initialize bidi connection
			requestInfo.mode = 'bidi';
			requestInfo.keepAlive = true;
		} else {
			requestInfo.mode = mode || 'response';
			requestInfo.keepAlive = keepAlive ?? false;
		}

		// Start connection timeout for long-lived connections
		if (requestInfo.keepAlive && requestInfo.timeouts.conTimeout > 0) {
			requestInfo.connectionTimeout = this.#startConnectionTimeout(
				id,
				requestInfo.timeouts.conTimeout
			);
		}

		// Send response metadata to operator via req-N channel
		const availableWorkers = this.availWorkers;
		const resPayload = JSON.stringify({
			id,
			mode: requestInfo.mode,
			status,
			headers,
			keepAlive: requestInfo.keepAlive,
			availableWorkers,
			totalWorkers: this.maxConcurrentRequests,
		});

		// console.debug(`[${this.processId}] Sending response metadata to operator...`);
		requestInfo.responseStarted = true;
		await requestInfo.reqChannel.write('res', resPayload);
		// console.debug(`[${this.processId}] Response metadata sent successfully`);
	}

	/**
	 * General worker-termination handler.
	 * Attached to the mod-app PostMessageTransport 'stopped' event.
	 * Sends a 503 error response if no response was started, then removes
	 * the request from activeRequests.
	 *
	 * This is the single, authoritative cleanup path for all cases where a
	 * mod-app transport stops (graceful completion, timeout abort, shutdown
	 * hard-terminate, or unexpected worker exit).
	 *
	 * @param {object} worker - The Web Worker instance
	 */
	#onAppTransportStopped (worker) {
	 const workerInfo = this.workerInfo.get(worker);

	 if (!workerInfo) return; // Already cleaned up

	 const { app, isPersistent, activeRequest } = workerInfo;

	 // Clean up active request if there is one
	 if (activeRequest) {
		const activeRequestId = activeRequest.id;
	 	const requestInfo = this.activeRequests.get(activeRequestId);

	 	if (requestInfo) {
	 		const { reqChannel, responseStarted, timeout, idleTimeout, connectionTimeout } = requestInfo;

	 		// Clear all timers (request, idle, connection timeouts)
	 		clearTimeout(timeout);
	 		clearTimeout(idleTimeout);
	 		clearTimeout(connectionTimeout);

	 		if (!responseStarted) {
	 			this.#sendErrorResponse(reqChannel, activeRequestId, 503, 'Service Unavailable').catch(() => {});
	 		}

	 		this.channelMap.delete(reqChannel);
	 		this.activeRequests.delete(activeRequestId);
	 	}
	 }

	 // Remove from workerInfo Map
	 this.workerInfo.delete(worker);

	 // Also remove from persistent workers registry if present
	 if (isPersistent) {
	 	const workers = this.workersByApp.get(app);
	 	if (workers) {
	 		const index = workers.findIndex((w) => w.worker === worker);

	 		if (index !== -1) {
	 			const lastWorker = workers.pop();

	 			if (index !== workers.length) workers[index] = lastWorker;
	 			console.debug(`[${this.processId}] Removed persistent worker for "${app}" from registry (transport stopped)`);
	 		}
	 		if (workers.length === 0) {
	 			this.workersByApp.delete(app);
	 		}
	 	}
	 }

	 // Resolve drain promise if all requests are complete (for shutdown)
	 if (this.drainResolvers && this.activeRequests.size === 0) {
	 	this.drainResolvers.resolve();
	 }
	}

	/**
	 * Handle inbound bidi-frame from operator (client → mod-app).
	 * Forwards to the mod-app's app channel.
	 * @param {object} reqChannel - The req-N channel the frame arrived on
	 * @param {Uint8Array|undefined} frameData - Frame data
	 */
	async #onOperatorBidiFrame (requestId, frameData) {
		const requestInfo = this.activeRequests.get(requestId);

		if (!requestInfo) {
			console.warn(`[${this.processId}] Bidi frame for unknown/closed request ${requestId}`);
			return;
		}

		const { mode, workerInfo } = requestInfo;
		const appChannel = workerInfo?.appChannel;

		if (mode !== 'bidi') {
			console.warn(`[${this.processId}] Bidi frame for non-bidi request ${requestId}`);
			return;
		}

		if (!appChannel) {
			console.warn(`[${this.processId}] No app channel for bidi request ${requestId}`);
			return;
		}

		// Forward to mod-app's app channel (dechunk: false relay)
		await appChannel.write('bidi-frame', frameData, { eom: false });
	}

	/**
	 * Log startup information after configuration is loaded.
	 */
	async onStarted () {
		console.debug(`[${this.processId}] Pool: ${this.poolName}, max concurrent: ${this.maxConcurrentRequests}`);
	}

	/**
	 * Handle web request from operator (via req-N channel).
	 * @param {object} reqChannel - The req-N channel the request arrived on
	 * @param {string} requestJson - JSON-encoded request
	 */
	async #onWebRequest (reqChannel, requestJson) {
		let requestData;
		try {
			requestData = JSON.parse(requestJson);
		} catch (err) {
			console.error(`[${this.processId}] Invalid request JSON:`, err);
			await this.#sendErrorResponse(reqChannel, null, 400, 'Bad Request');
			return;
		}

		const { id, method, url, app, root, headers, routeParams, routeTail, routeSpec, body, identity } = requestData;

		try {
			// Check if we're at capacity
			if (this.activeRequests.size >= this.maxConcurrentRequests) {
				console.debug(`[${this.processId}] At capacity (${this.activeRequests.size}/${this.maxConcurrentRequests}), returning 503`);
				await this.#sendErrorResponse(reqChannel, id, 503, 'Service Unavailable');
				return;
			}

			const urlObj = new URL(url);

			console.debug(`[${this.processId}] Request: ${method?.toUpperCase()} ${urlObj.pathname} -> ${app}`);

			// Resolve timeout configuration with hierarchy: route > pool > global
			const timeouts = this.config.getTimeoutConfig(this.poolName, routeSpec);
			const { reqTimeout, idleTimeout, conTimeout } = timeouts;

			console.debug(`[${this.processId}] Timeouts: req=${reqTimeout}s, idle=${idleTimeout}s, con=${conTimeout}s`);

			// Determine request mode from headers (bidi = WebSocket upgrade)
			const upgradeHeader = headers?.['upgrade'];
			const mode = (upgradeHeader?.toLowerCase() === 'websocket') ? 'bidi' : 'response';

			// Compute effective appEnv for this request (global → pool → route merge)
			const appEnv = this.config.getEffectiveAppEnv(routeSpec, this.poolName);

			const isPersistent = this.config.isPersistent(this.poolName, routeSpec);

			let workerInfo;

			if (isPersistent) {
				const existingWorkers = this.workersByApp.get(app), workers = existingWorkers || [];

				workerInfo = workers.find((w) => w.status === 'idle');

				if (workerInfo) {
					workerInfo.status = 'busy';
					workerInfo.reqCount++;
					workerInfo.lastUsed = Date.now();
					console.debug(`[${this.processId}] Reusing idle persistent worker for "${app}" (reqCount: ${workerInfo.reqCount})`);
				} else {
					// Spawn new persistent worker
					workerInfo = await this.#spawnAppWorker(app, mode, appEnv, true);
					workerInfo.reqCount = 1;

					if (!existingWorkers) {
						this.workersByApp.set(app, workers);
					}
					workers.push(workerInfo);
					console.debug(`[${this.processId}] Spawned new persistent worker for "${app}"`);
				}
			} else {
				// One-shot worker
				workerInfo = await this.#spawnAppWorker(app, mode, appEnv, false);
				workerInfo.reqCount = 1;
			}

			const { worker, transport, appChannel } = workerInfo;

			// Set up request timeout: send error first (sets responseStarted), then abort.
			const timeout = reqTimeout ? setTimeout(() => {
				if (this.activeRequests.has(id)) {
					console.warn(`[${this.processId}] Request ${id} timed out after ${reqTimeout}s`);
					this.#sendErrorResponse(reqChannel, id, 504, 'Gateway Timeout').catch(console.error); // should use logger, not console directly
					this.cleanupRequest(id);
				}
			}, reqTimeout * 1000) : null;

			// Track active request
			const reqInfo = {
				id,
				reqChannel,
				responseStarted: false,
				timeout,
				timeouts: { reqTimeout, idleTimeout, conTimeout },
				routeSpec,
				isStreaming: false,
				workerInfo,
			};

			workerInfo.activeRequest = reqInfo;

			this.activeRequests.set(id, reqInfo);
			this.channelMap.set(reqChannel, id);

			// Handle worker errors: send 500 (sets responseStarted), then abort.
			// The transport 'stopped' handler will not send a duplicate 503 because
			// responseStarted is already true by the time the stopped event fires.
			worker.onerror = (error) => {
				console.error(`[${this.processId}] Worker error for request ${id}:`, error);
				this.#sendErrorResponse(reqChannel, id, 500, 'Internal Server Error').catch(() => {});
				this.cleanupRequest(id);
			};

			// Check for built-in mod-apps and prepare configuration
			let builtinConfig = null;
			if (app === '@static') {
				builtinConfig = {
					root,
					mimeTypes: this.config.mimeTypes || {}, // Plain object, JSON-serializable
				};
			}

			// Build request payload
			const requestPayload = {
				method: method?.toUpperCase(),
				url,
				headers: headers || {},
				routeParams: routeParams || {},
				routeTail: routeTail || '',
				body,
				identity: identity ?? null,
				timeouts: {
					request: reqTimeout,
					idle: idleTimeout,
					connection: conTimeout,
				},
				maxChunkSize: this.chunkingConfig.chunkSize,
			};

			// Add config for built-in mod-apps only
			if (builtinConfig) {
				requestPayload.config = builtinConfig;
			}

			// Send request to mod-app via the 'app' channel
			await appChannel.write('req', JSON.stringify(requestPayload));

			this.#processAppResponse(id, appChannel);

		} catch (error) {
			console.error(`[${this.processId}] Request handling error:`, error);
			await this.#sendErrorResponse(reqChannel, id, 500, 'Internal Server Error');
		}
	}

	/**
	 * Start reading response metadata and body from the mod-app channel,
	 * and relay to the operator via req-N channel.
	 * @param {string|number} id - Request ID
	 * @param {object} appChannel - The 'app' channel from PostMessageTransport
	 */
	#processAppResponse (id, appChannel) {
		const requestInfo = this.activeRequests.get(id);

		if (!requestInfo) return;

		const { reqChannel, mode } = requestInfo;

		// Loop 1: response metadata (dechunked — each read() returns one complete message)
		// 'res' carries HTTP response status + headers (sent once, before any res-frame chunks)
		// 'res-error' carries error response (sent instead of res + res-frame)
		(async () => {
			while (true) {
				const msg = await appChannel.read({ only: ['res', 'res-error'] });

				if (!msg) break;
				await msg.process(async () => {
					const info = this.activeRequests.get(id);

					if (!info) return;
					switch (msg.messageType) {
					case 'res':
						await this.#onAppResMeta(id, msg.text, info);
						break;
					case 'res-error':
						await this.#onAppResError(id, msg.text, info);
						break;
					}
				});
			}
		})();

		// Loop 2: response body chunks (dechunk: false — relay verbatim without reassembly)
		// res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
		// Mod-apps use PostMessageTransport (object stream, no auto text encoding), so
		// string writes set msg.text (not msg.data). Use msg.data ?? msg.text to handle both.
		(async () => {
			while (true) {
				const msg = await appChannel.read({ only: 'res-frame', dechunk: false });

				if (!msg) break;

				let done = false;

				await msg.process(async () => {
					const info = this.activeRequests.get(id);

					if (!info) return;

					const frameData = msg.data ?? msg.text;

					if (frameData === undefined && msg.eom) {
						done = true; // zero-data + eom:true = end-of-stream signal
					} else {
						const reqChannel = info.reqChannel;

						await reqChannel.write('res-frame', frameData, { eom: msg.eom ?? false });
					}
				});
				if (done) {
					await this.#sendEndOfStream(id);
					await this.#handleRequestCompletion(id);
					break;
				}
			}
		})();

		// Loop 3: bidi relay
		(async () => {
			while (true) {
				const msg = await appChannel.read({ only: 'bidi-frame', dechunk: false });

				if (!msg) break;
				await msg.process(async () => {
					// console.log('*** Res App->Cli bidi relay', msg.dataSize);
					// Forward bidi-frame to operator via req-N channel
					await reqChannel.write('bidi-frame', msg.data, { eom: false });
				});
			}
		})();
	}

	/**
	 * Send end-of-stream signal to operator (zero-data final res-frame).
	 * @param {string|number} id - Request ID
	 */
	async #sendEndOfStream (id) {
		const requestInfo = this.activeRequests.get(id);

		if (!requestInfo) return;

		// Send zero-data res-frame with eom:true = end-of-stream signal
		const reqChannel = requestInfo.reqChannel;

		await reqChannel.write('res-frame', null, { ifOpen: true });

		// For non-keepAlive requests: the bootstrap stops the transport after the
		// mod-app entry point returns, so the 'stopped' event will handle cleanup.
		// For keepAlive requests: start the idle timeout between frames.
		if (requestInfo.keepAlive && requestInfo.timeouts.idleTimeout > 0) {
			requestInfo.idleTimeout = this.#startIdleTimeout(id, requestInfo.timeouts.idleTimeout);
		}
	}

	/**
	 * Send error response to operator via req-N channel.
	 * Sets responseStarted on the requestInfo (if found) so that the transport
	 * 'stopped' handler does not send a duplicate 503.
	 * @param {object} reqChannel - The req-N channel to write to
	 * @param {string|number|null} id - Request ID (may be null for early errors)
	 * @param {number} status - HTTP status code
	 * @param {string} message - Error message
	 */
	async #sendErrorResponse (reqChannel, id, status, message) {
		if (!reqChannel) return;

		const requestInfo = id != null ? this.activeRequests.get(id) : null;

		if (requestInfo) requestInfo.responseStarted = true;
		await reqChannel.write('res-error', JSON.stringify({ id, status, error: message }));
	}

	/**
	 * Spawn mod-app worker and establish PostMessageTransport.
	 * Returns { worker, transport, appChannel, c2cChannel }.
	 * The caller is responsible for setting up the bootstrap channel and
	 * forwarding C2C output.
	 *
	 * @param {string} appPath - Mod-app path or built-in alias (e.g. '@static')
	 * @param {string} mode - Request mode ('response', 'stream', 'bidi')
	 * @param {Object} [appEnv] - Resolved appEnv to inject into the mod-app worker
	 * @returns {Promise<{ worker, transport, bootstrapChannel, appChannel }>}
	 */
	async #spawnAppWorker (appPath, mode, appEnv, persistent = false) {
		// Determine permissions based on mod-app path
		let readAny = false, keepDeno = false;
		switch (appPath) {
		case '@static':
			appPath = './apps/static-content.esm.js';
			readAny = keepDeno = true;
			break;
		}
		const appURL = new URL(appPath, import.meta.url);
		const appHref = appURL.href;
		const isUrlBased = appHref.startsWith('https://') || appHref.startsWith('http://');
		const bootstrapURL = new URL('./apps/bootstrap.esm.js', import.meta.url);
		const readable = [bootstrapURL.pathname];

		if (!isUrlBased) readable.push(appURL.pathname);

		const permissions = {
			read: readAny || readable,
			net: true, // Always allow network for module loading
			import: true,
			write: false,
			run: false,
			env: false,
		};

		// Create Web Worker with bootstrap module
		const worker = new Worker(bootstrapURL.href, {
			type: 'module',
			deno: { permissions },
		});

		console.debug(`[${this.processId}] Created worker with bootstrap for mod-app "${appPath}"`);

		// Establish PostMessageTransport with the worker
		const c2cSymbol = Symbol('c2c');
		const transport = new PostMessageTransport({
			gateway: worker,
			c2cSymbol,
			maxChunkBytes: this.chunkingConfig.chunkSize,
			bufferPool: this._bufferPool, // Use shared buffer pool from SubProcess base class
		});

		// Accept all channels (responder initiates)
		transport.addEventListener('newChannel', (event) => {
			event.accept();
		});

		await transport.start();

		// Get the C2C channel (mod-app console output)
		const c2cChannel = transport.getChannel(c2cSymbol);

		// Send setup instructions to bootstrap via the private 'bootstrap' channel
		const bootstrapChannel = await transport.requestChannel('bootstrap');

		await bootstrapChannel.addMessageTypes(BOOT_CHANNEL_MESSAGE_TYPES);

		const setupData = { appPath: appHref, mode, keepDeno, persistent };

		if (appEnv && Object.keys(appEnv).length > 0) {
			setupData.appEnv = appEnv;
		}
		await bootstrapChannel.write('setup', JSON.stringify(setupData));

		// Set up the mod-app communication channel
		const appChannel = await transport.requestChannel('app');

		await appChannel.addMessageTypes(APP_CHANNEL_MESSAGE_TYPES);

		// Start forwarding mod-app C2C console output to operator via the req-N channel
		this.#startC2CForwarding(worker, c2cChannel);

		const workerInfo = {
			app: appPath,
			worker,
			transport,
			c2cChannel,
			appChannel,
			bootstrapChannel,
			isPersistent: persistent,
			status: 'busy',
			reqCount: 0,
			lastUsed: Date.now(),
			activeRequest: null,
		};

		this.workerInfo.set(worker, workerInfo);

		// Register the stopped listener exactly once for the worker's lifetime
		transport.addEventListener('stopped', () => this.#onAppTransportStopped(worker));

		return workerInfo;
	}

	/**
		* Start forwarding mod-app C2C console output to operator via the req-N channel.
		* C2C bare names (trace/debug/info/warn/error) are forwarded with 'con-' prefix
		* to avoid collision with other message types on the req-N channel.
		* @param {object} worker - The Web Worker instance
		* @param {object} c2cChannel - The C2C channel from the mod-app's PostMessageTransport
		*/
	#startC2CForwarding (worker, c2cChannel) {
		(async () => {
			while (true) {
				const msg = await c2cChannel.read({ decode: true });

				if (!msg) break;
				await msg.process(() => {
					const workerInfo = this.workerInfo.get(worker);
					const info = workerInfo?.activeRequest;

					if (!info) return; // No active request for this worker right now

					// Forward with 'con-' prefix: 'trace' → 'con-trace', etc.
					// Console messages may have no data — forward null in that case.
					const text = msg.text ?? null;

					info.reqChannel.write(`con-${msg.messageType}`, text).catch((err) => {
						console.warn(`[${this.processId}] Failed to forward con-${msg.messageType}:`, err);
					});
				});
			}
		})();
	}

	/**
	 * Start connection timeout for streaming/bidi connections.
	 */
	#startConnectionTimeout (id, conTimeout) {
		if (conTimeout <= 0) return null;  // Disabled

		return setTimeout(() => {
			const requestInfo = this.activeRequests.get(id);

			if (requestInfo && requestInfo.keepAlive) {
				console.debug(`[${this.processId}] Connection ${id} lifetime timeout after ${conTimeout}s`);
				this.#sendErrorResponse(requestInfo.reqChannel, id, 408, 'Request Timeout').catch(console.error);
				this.cleanupRequest(id);
			}
		}, conTimeout * 1000);
	}

	/**
	 * Start idle timeout for streaming/bidi connections.
	 * Only active between frames, not during request processing.
	 */
	#startIdleTimeout (id, idleTimeout) {
		if (idleTimeout <= 0) return null;  // Disabled

		return setTimeout(() => {
			const requestInfo = this.activeRequests.get(id);

			if (requestInfo && requestInfo.keepAlive) {
				console.debug(`[${this.processId}] Connection ${id} idle timeout after ${idleTimeout}s`);
				this.#sendErrorResponse(requestInfo.reqChannel, id, 408, 'Request Timeout').catch(console.error);
				this.cleanupRequest(id);
			}
		}, idleTimeout * 1000);
	}
}

/**
 * Main entry point
 */
async function main () {
	const processId = Deno.env.get('JSMAWS_PID'); // process id string
	const poolName = Deno.env.get('JSMAWS_POOL');

	Deno.stderr.writeSync(new TextEncoder().encode(
		`Responder main pid ${processId} pool ${poolName}\n`
	));
	await SubProcess.run(ResponderProcess, processId, poolName);
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}
