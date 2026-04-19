/**
 * JSMAWS Responder Process
 * Unprivileged service process for executing applets and handling requests
 *
 * This process:
 * - Runs with dropped privileges (unprivileged uid/gid)
 * - Spawns applet workers on-demand to handle requests
 * - Receives request messages from operator via PipeTransport req-N channels
 * - Sends response messages back to operator via the same req-N channels
 * - Implements tiered response chunking
 * - Reports capacity state for load balancing
 * - Supports streaming, SSE, and WebSocket connections
 *
 * Architecture:
 * - Direct applet spawning (no intermediate wrapper)
 * - One-shot workers for regular requests (security/isolation)
 * - Long-lived workers for streaming/WebSocket connections
 * - Process-level module caching (automatic via Deno)
 * - Responder ↔ Applet communication via PostMessageTransport (PolyTransport)
 * - Operator ↔ Responder communication via PipeTransport (PolyTransport)
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { ServiceProcess } from './service-process.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from './request-channel-pool.esm.js';

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
		this.activeRequests = new Map(); // requestId -> { worker, transport, timeout, isStreaming }
		this.requestCount = 0;
		this.maxConcurrentRequests = 10; // Will be set from pool config

		// Chunk size for PolyTransport (maxChunkBytes)
		// PolyTransport handles chunking; we only need to know the chunk size
		this.chunkingConfig = {
			chunkSize: 65536, // 64KB default; updated from config
		};
	}

	/**
	 * Available workers (concurrent request slots remaining)
	 */
	get availWorkers () {
		return this.maxConcurrentRequests - this.activeRequests.size;
	}

	/**
	 * Cleanup request resources.
	 * Centralized cleanup for all request-related state.
	 */
	cleanupRequest (id) {
		const requestInfo = this.activeRequests.get(id);
		if (requestInfo) {
			clearTimeout(requestInfo.timeout);           // Request timeout
			clearTimeout(requestInfo.idleTimeout);       // Idle timeout
			clearTimeout(requestInfo.connectionTimeout); // Connection timeout
			// Stop the PostMessageTransport (terminates worker)
			requestInfo.transport?.stop({ discard: true }).catch(() => {});
			requestInfo.worker?.terminate();
		}

		// Clean up all request-related state
		this.activeRequests.delete(id);
	}

	/**
	 * Handle configuration update from operator.
	 * @param {string} configJson - JSON-encoded configuration
	 */
	async handleConfigUpdate (configJson) {
		console.info(`[${this.processId}] Received configuration update`);

		// Configuration instance is already updated by ServiceProcess base class
		// Just need to extract relevant settings

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
		await reqChannel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);

		// Loop 1: 'req' messages (dechunked by default — full message reassembly)
		// 'req' payload is JSON text; decode via VirtualBuffer.decode()
		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: 'req' });
				if (!msg) break;
				await msg.process(async () => {
					await this.#handleWebRequest(reqChannel, msg.data.decode());
				});
			}
		})();

		// Loop 2: 'bidi-frame' relay (dechunk: false — forward chunks verbatim)
		// bidi-frame carries NestedTransport byte-stream traffic; chunks must not be
		// reassembled before forwarding to the applet's bidi channel.
		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: 'bidi-frame', dechunk: false });
				if (!msg) break;
				await msg.process(async () => {
					await this.#handleOperatorBidiFrame(reqChannel, msg.data);
				});
			}
		})();
	}

	/**
	 * Handle shutdown request from operator.
	 * @param {object} msg - PolyTransport message (may be null for signal-triggered shutdown)
	 */
	async handleShutdown (msg) {
		const timeout = msg ? (JSON.parse(msg.text ?? '{}').timeout ?? 30) : 30;
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
			requestInfo.transport?.stop({ discard: true }).catch(() => {});
			requestInfo.worker?.terminate();
			if (requestInfo.reqChannel) {
				tasks.push(
					this.#sendErrorResponse(requestInfo.reqChannel, id, 503, 'Service Unavailable').catch(() => {})
				);
			}
		}
		if (tasks.length) await Promise.all(tasks);
		this.activeRequests.clear();

		// Log shutdown complete BEFORE stopping transport (which closes stdout)
		console.info(`[${this.processId}] Shutdown complete`);

		// Stop transport (graceful drain)
		if (this.transport) {
			await this.transport.stop();
		}

		Deno.exit(0);
	}

	/**
	 * Log startup information after configuration is loaded.
	 */
	async onStarted () {
		console.log(`[${this.processId}] Pool: ${this.poolName}, max concurrent: ${this.maxConcurrentRequests}`);
	}

	/**
	 * Handle inbound bidi-frame from operator (client → applet).
	 * Forwards to the applet's bidi channel.
	 * @param {object} reqChannel - The req-N channel the frame arrived on
	 * @param {Uint8Array|undefined} frameData - Frame data
	 */
	async #handleOperatorBidiFrame (reqChannel, frameData) {
		// Find the active request associated with this req-N channel
		// We look up by reqChannel reference
		let requestInfo = null;
		for (const info of this.activeRequests.values()) {
			if (info.reqChannel === reqChannel) {
				requestInfo = info;
				break;
			}
		}

		if (!requestInfo) {
			console.debug(`[${this.processId}] Bidi frame for unknown/closed request on ${reqChannel.name}`);
			return;
		}

		const { appletBidiChannel } = requestInfo;
		if (!appletBidiChannel) {
			console.warn(`[${this.processId}] Bidi frame for non-bidi request on ${reqChannel.name}`);
			return;
		}

		// Forward to applet's bidi channel (dechunk: false relay)
		await appletBidiChannel.write('bidi-frame', frameData, { eom: false });
	}

	/**
	 * Handle response metadata ('res' message) from applet.
	 * Sends the response metadata to the operator via the req-N channel.
	 * @param {string|number} id - Request ID
	 * @param {string} resJson - JSON-encoded response metadata
	 * @param {object} requestInfo - Active request info
	 */
	async #handleAppletResponseMetadata (id, resJson, requestInfo) {
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
			this.cleanupRequest(id);
			await this.#sendErrorResponse(requestInfo.reqChannel, id, 500, 'Internal Server Error');
			return;
		}

		// Enforce policy: status 101 (bidi upgrade) must not have data
		if (status === 101) {
			// Bidi upgrade — initialize bidi connection
			requestInfo.mode = 'bidi';
			requestInfo.keepAlive = true;
		} else {
			requestInfo.mode = mode || 'response';
			requestInfo.keepAlive = keepAlive !== undefined ? keepAlive : false;
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

		console.debug(`[${this.processId}] Sending response metadata to operator...`);
		await requestInfo.reqChannel.write('res', resPayload);
		console.debug(`[${this.processId}] Response metadata sent successfully`);
	}

	/**
	 * Handle error response ('res-error' message) from applet.
	 * @param {string|number} id - Request ID
	 * @param {string} errorJson - JSON-encoded error
	 * @param {object} requestInfo - Active request info
	 */
	async #handleAppletResError (id, errorJson, requestInfo) {
		let errorData;
		try {
			errorData = JSON.parse(errorJson);
		} catch (_) {
			errorData = { error: errorJson };
		}
		console.error(`[${this.processId}] Applet error for request ${id}:`, errorData.error);
		if (errorData.stack) console.error(errorData.stack);

		this.cleanupRequest(id);
		await this.#sendErrorResponse(requestInfo.reqChannel, id, 500, 'Internal Server Error');
	}

	/**
	 * Handle web request from operator (via req-N channel).
	 * @param {object} reqChannel - The req-N channel the request arrived on
	 * @param {string} requestJson - JSON-encoded request
	 */
	async #handleWebRequest (reqChannel, requestJson) {
		let requestData;
		try {
			requestData = JSON.parse(requestJson);
		} catch (err) {
			console.error(`[${this.processId}] Invalid request JSON:`, err);
			await this.#sendErrorResponse(reqChannel, null, 400, 'Bad Request');
			return;
		}

		const { id, method, url, app, root, headers, routeParams, routeTail, routeSpec, body } = requestData;

		try {
			// Check if we're at capacity
			if (this.activeRequests.size >= this.maxConcurrentRequests) {
				console.warn(`[${this.processId}] At capacity (${this.activeRequests.size}/${this.maxConcurrentRequests}), returning 503`);
				await this.#sendErrorResponse(reqChannel, id, 503, 'Service Unavailable');
				return;
			}

			const urlObj = new URL(url);
			console.log(`[${this.processId}] Request: ${method?.toUpperCase()} ${urlObj.pathname} -> ${app}`);

			// Resolve timeout configuration with hierarchy: route > pool > global
			const timeouts = this.config.getTimeoutConfig(this.poolName, routeSpec);
			const { reqTimeout, idleTimeout, conTimeout } = timeouts;

			console.debug(`[${this.processId}] Timeouts: req=${reqTimeout}s, idle=${idleTimeout}s, con=${conTimeout}s`);

			// Determine request mode from headers (bidi = WebSocket upgrade)
			const upgradeHeader = headers?.['upgrade'];
			const mode = (upgradeHeader?.toLowerCase() === 'websocket') ? 'bidi' : 'response';

			// Spawn applet worker and establish PostMessageTransport
			const { worker, transport, c2cChannel, appletChannel, appletBidiChannel } =
				await this.#spawnAppletWorker(app, mode);

			// Set up request timeout
			const timeout = reqTimeout ? setTimeout(() => {
				if (this.activeRequests.has(id)) {
					console.warn(`[${this.processId}] Request ${id} timed out after ${reqTimeout}s`);
					this.cleanupRequest(id);
					this.#sendErrorResponse(reqChannel, id, 504, 'Gateway Timeout').catch(console.error);
				}
			}, reqTimeout * 1000) : null;

			// Track active request
			this.activeRequests.set(id, {
				reqChannel,
				worker,
				transport,
				appletChannel,
				appletBidiChannel,
				timeout,
				isStreaming: false,
				timeouts: { reqTimeout, idleTimeout, conTimeout },
				routeSpec,
				mode,
			});

			// Forward applet C2C console output to operator via the req-N channel
			// (con-* message types, not the C2C channel — associates output with the request)
			this.#startC2CForwarding(id, c2cChannel, reqChannel);

			// Handle worker errors
			worker.onerror = (error) => {
				console.error(`[${this.processId}] Worker error for request ${id}:`, error);
				this.cleanupRequest(id);
				this.#sendErrorResponse(reqChannel, id, 500, 'Internal Server Error');
			};

			// Check for built-in applets and prepare configuration
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
				timeouts: {
					request: reqTimeout,
					idle: idleTimeout,
					connection: conTimeout,
				},
				maxChunkSize: this.chunkingConfig.chunkSize,
			};

			// Add config for built-in applets only
			if (builtinConfig) {
				requestPayload.config = builtinConfig;
			}

			// Send request to applet via the 'applet' channel
			await appletChannel.write('req', JSON.stringify(requestPayload));

			// Start reading response from applet
			this.#startAppletResponseReading(id, appletChannel, appletBidiChannel);

		} catch (error) {
			console.error(`[${this.processId}] Request handling error:`, error);
			await this.#sendErrorResponse(reqChannel, id, 500, 'Internal Server Error');
		}
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

		if (!requestInfo.keepAlive) {
			this.cleanupRequest(id);
		} else if (requestInfo.keepAlive && requestInfo.timeouts.idleTimeout > 0) {
			requestInfo.idleTimeout = this.#startIdleTimeout(id, requestInfo.timeouts.idleTimeout);
		}
	}

	/**
	 * Send error response to operator via req-N channel.
	 * @param {object} reqChannel - The req-N channel to write to
	 * @param {string|number|null} id - Request ID (may be null for early errors)
	 * @param {number} status - HTTP status code
	 * @param {string} message - Error message
	 */
	async #sendErrorResponse (reqChannel, id, status, message) {
		if (!reqChannel) return;
		await reqChannel.write('res-error', JSON.stringify({ id, status, error: message }));
	}

	/**
	 * Spawn applet worker and establish PostMessageTransport.
	 * Returns { worker, transport, appletChannel, c2cChannel }.
	 * The caller is responsible for setting up the bootstrap channel and
	 * forwarding C2C output.
	 *
	 * @param {string} appletPath - Applet path or built-in alias (e.g. '@static')
	 * @param {string} mode - Request mode ('response', 'stream', 'bidi')
	 * @returns {Promise<{ worker, transport, bootstrapChannel, appletChannel, appletBidiChannel }>}
	 */
	async #spawnAppletWorker (appletPath, mode) {
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

		// Create Web Worker with bootstrap module
		const worker = new Worker(bootstrapURL.href, {
			type: 'module',
			deno: { permissions },
		});

		console.debug(`[${this.processId}] Created worker with bootstrap for applet "${appletPath}"`);

		// Establish PostMessageTransport with the worker
		const c2cSymbol = Symbol('c2c');
		const transport = new PostMessageTransport({
			gateway: worker,
			c2cSymbol,
			maxChunkBytes: this.chunkingConfig.chunkSize,
		});

		// Accept all channels (responder initiates)
		transport.addEventListener('newChannel', (event) => {
			event.accept();
		});

		await transport.start();

		// Get the C2C channel (applet console output)
		const c2cChannel = transport.getChannel(c2cSymbol);

		// Send setup instructions to bootstrap via the private 'bootstrap' channel
		const bootstrapChannel = await transport.requestChannel('bootstrap');
		await bootstrapChannel.addMessageTypes(['setup']);
		await bootstrapChannel.write('setup', JSON.stringify({
			appletPath: appletHref,
			mode,
			keepDeno,
		}));

		// Set up the applet communication channel
		const appletChannel = await transport.requestChannel('applet');
		await appletChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

		// For bidi requests: set up the bidi relay channel
		let appletBidiChannel = null;
		if (mode === 'bidi') {
			appletBidiChannel = await transport.requestChannel('bidi');
			await appletBidiChannel.addMessageTypes(['bidi-frame']);
		}

		return { worker, transport, c2cChannel, appletChannel, appletBidiChannel };
	}

	/**
	 * Start forwarding applet C2C console output to operator via the req-N channel.
	 * C2C bare names (trace/debug/info/warn/error) are forwarded with 'con-' prefix
	 * to avoid collision with other message types on the req-N channel.
	 * @param {string|number} id - Request ID
	 * @param {object} c2cChannel - The C2C channel from the applet's PostMessageTransport
	 * @param {object} reqChannel - The req-N channel to forward to
	 */
	#startC2CForwarding (id, c2cChannel, reqChannel) {
		(async () => {
			while (true) {
				const msg = await c2cChannel.read({ decode: true });
				if (!msg) break;
				await msg.process(() => {
					if (!this.activeRequests.has(id)) return; // Request already cleaned up
					// Forward with 'con-' prefix: 'trace' → 'con-trace', etc.
					// Console messages may have no data — forward null in that case.
					const text = msg.text ?? null;
					reqChannel.write(`con-${msg.messageType}`, text).catch((err) => {
						console.warn(`[${this.processId}] Failed to forward con-${msg.messageType}:`, err);
					});
				});
			}
		})();
	}

	/**
	 * Start relaying bidi-frame messages from the applet to the operator.
	 * Runs concurrently with the response reading loops.
	 * @param {string|number} id - Request ID
	 * @param {object} appletBidiChannel - The 'bidi' channel from PostMessageTransport
	 * @param {object} reqChannel - The req-N channel to forward to
	 */
	#startBidiRelayFromApplet (id, appletBidiChannel, reqChannel) {
		(async () => {
			while (true) {
				const msg = await appletBidiChannel.read({ only: 'bidi-frame', dechunk: false });
				if (!msg) break;
				await msg.process(async () => {
					if (!this.activeRequests.has(id)) return;
					// Forward bidi-frame to operator via req-N channel
					await reqChannel.write('bidi-frame', msg.data, { eom: false });
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
				this.cleanupRequest(id);
				this.#sendErrorResponse(requestInfo.reqChannel, id, 408, 'Request Timeout').catch(console.error);
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
				this.cleanupRequest(id);
				this.#sendErrorResponse(requestInfo.reqChannel, id, 408, 'Request Timeout').catch(console.error);
			}
		}, idleTimeout * 1000);
	}

	/**
	 * Start reading response metadata and body from the applet channel,
	 * and relay to the operator via req-N channel.
	 * @param {string|number} id - Request ID
	 * @param {object} appletChannel - The 'applet' channel from PostMessageTransport
	 * @param {object|null} appletBidiChannel - The 'bidi' channel (bidi mode only)
	 */
	#startAppletResponseReading (id, appletChannel, appletBidiChannel) {
		const requestInfo = this.activeRequests.get(id);
		if (!requestInfo) return;
		const { reqChannel } = requestInfo;

		// Loop 1: response metadata (dechunked — each read() returns one complete message)
		// 'res' carries HTTP response status + headers (sent once, before any res-frame chunks)
		// 'res-error' carries error response (sent instead of res + res-frame)
		(async () => {
			while (true) {
				const msg = await appletChannel.read({ only: ['res', 'res-error'] });
				if (!msg) break;
				await msg.process(async () => {
					const info = this.activeRequests.get(id);
					if (!info) return;
					switch (msg.messageType) {
					case 'res':
						await this.#handleAppletResponseMetadata(id, msg.text, info);
						break;
					case 'res-error':
						await this.#handleAppletResError(id, msg.text, info);
						break;
					}
				});
			}
		})();

		// Loop 2: response body chunks (dechunk: false — relay verbatim without reassembly)
		// res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
		// Applets use PostMessageTransport (object stream, no auto text encoding), so
		// string writes set msg.text (not msg.data). Use msg.data ?? msg.text to handle both.
		(async () => {
			while (true) {
				const msg = await appletChannel.read({ only: 'res-frame', dechunk: false });
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
					break;
				}
			}
		})();

		// Loop 3: bidi relay (bidi mode only, dechunk: false)
		if (appletBidiChannel) {
			this.#startBidiRelayFromApplet(id, appletBidiChannel, reqChannel);
		}
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
