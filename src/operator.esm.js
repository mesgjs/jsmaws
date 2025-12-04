/**
 * JavaScript Multi-Applet Web Server (JSMAWS)
 * Operator process (privileged)
 *
 * This is the privileged operator process that:
 * - Binds to HTTP/HTTPS ports (80, 443)
 * - Manages configuration and SSL certificates
 * - Spawns and manages service processes (responders and routers)
 * - Routes requests to appropriate service processes via IPC
 * - Never executes user code directly
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS, parseSLID } from './vendor.esm.js';
import { createSSLManager } from './ssl-manager.esm.js';
import { Router } from './router-worker.esm.js';
import { Configuration } from './configuration.esm.js';
import { createConfigMonitor } from './config-monitor.esm.js';
import { createLogger } from './logger.esm.js';
import { ProcessManager, ProcessType } from './process-manager.esm.js';
import { PoolManager } from './pool-manager.esm.js';
import {
	createRequest,
	createFrame,
	MessageType,
} from './ipc-protocol.esm.js';

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
const DEFAULT_CONFIG_FILE = 'jsmaws.slid';

/**
 * Load configuration from a SLID file
 * @param {string} configPath Path to the SLID configuration file
 * @returns {Promise<NANOS>} Parsed configuration
 */
async function loadConfig (configPath) {
	const configText = await Deno.readTextFile(configPath);
	const config = parseSLID(configText);
	return config;
}

/**
 * Get default pool configuration when none is provided
 * @returns {NANOS} Default pools configuration
 */
function getDefaultPoolsConfig () {
	return parseSLID(`[(
		standard=[
			minProcs=1
			maxProcs=20
			scaling=dynamic
			minWorkers=1
			maxWorkers=4
			maxReqs=100
			reqTimeout=60
			conTimeout=300
		]
	)]`);
}

/**
 * Server configuration
 */
class ServerConfig {
	constructor (options = {}) {
		this.httpPort = options.httpPort || DEFAULT_HTTP_PORT;
		this.httpsPort = options.httpsPort || DEFAULT_HTTPS_PORT;
		this.certFile = options.certFile;
		this.keyFile = options.keyFile;
		this.hostname = options.hostname || 'localhost';
		this.acmeChallengeDir = options.acmeChallengeDir;
		this.noSSL = options.noSSL || false;
		this.sslCheckIntervalHours = options.sslCheckIntervalHours || 1;
	}

	/**
	 * Create ServerConfig from a NANOS configuration object
	 * @param {NANOS} config NANOS configuration object from SLID file
	 * @returns {ServerConfig}
	 */
	static fromNANOS (config) {
		return new ServerConfig(config.toObject());
	}
}

/**
 * Main operator class (privileged process)
 */
class OperatorProcess {
	constructor (config, configPath = DEFAULT_CONFIG_FILE) {
		this.config = config;
		this.configData = new NANOS(); // Full SLID configuration
		this.configuration = null; // Configuration instance for router
		this.configPath = configPath;
		this.httpServer = null;
		this.httpsServer = null;
		this.sslManager = null;
		this.router = null;
		this.configMonitor = null;
		this.processManager = null;
		this.poolManagers = new Map(); // poolName -> PoolManager
		this.affinityMap = new Map(); // appletPath -> Set<processIds>
		this.logger = null;
		this.isShuttingDown = false;
		this.isReloading = false;
		this.bidiConnections = new Map(); // requestId -> bidirectional connection state
		this.healthCheckInterval = null;
	}

	/**
	 * Initialize logger
	 */
	initializeLogger () {
		const loggingConfig = this.configData.at('logging') || new NANOS();
		this.logger = createLogger({
			target: loggingConfig.at('target', 'console'),
			level: loggingConfig.at('level', 'info'),
			format: loggingConfig.at('format', 'apache'),
			component: 'operator',
		});
	}

	/**
	 * Initialize process manager
	 */
	initializeProcessManager () {
		this.processManager = new ProcessManager(this.configData, this.logger);
	}

	/**
	 * Start the HTTP server (for redirects and ACME challenges)
	 */
	async startHttpServer () {
		const handler = (req) => this.handleHttpRequest(req);

		this.httpServer = Deno.serve({
			port: this.config.httpPort,
			hostname: this.config.hostname,
			onListen: ({ hostname, port }) => {
				this.logger.info(`HTTP server listening on http://${hostname}:${port}`);
			},
		}, handler);

		// this.logger.info(`HTTP server started on port ${this.config.httpPort}`);
	}

	/**
	 * Start the HTTPS server (for secure requests)
	 */
	async startHttpsServer () {
		if (this.config.noSSL) {
			this.logger.warn('HTTPS server disabled (noSSL mode)');
			return;
		}

		if (!this.config.certFile || !this.config.keyFile) {
			const message = 'SSL certificates not configured (use noSSL mode for http-only operation)';
			this.logger.error(message);
			throw new Error(message);
		}

		try {
			const cert = await Deno.readTextFile(this.config.certFile);
			const key = await Deno.readTextFile(this.config.keyFile);

			const handler = (req) => this.handleHttpsRequest(req);

			this.httpsServer = Deno.serve({
				port: this.config.httpsPort,
				hostname: this.config.hostname,
				cert,
				key,
				onListen: ({ hostname, port }) => {
					this.logger.info(`HTTPS server listening on https://${hostname}:${port}`);
				},
			}, handler);

			// this.logger.info(`HTTPS server started on port ${this.config.httpsPort}`);
		} catch (error) {
			this.logger.error(`Failed to start HTTPS server: ${error.message}`);
			if (!this.config.noSSL) {
				throw error;
			}
		}
	}

	/**
	 * Handle HTTP requests (redirects, ACME challenges, or direct handling in noSSL mode)
	 */
	async handleHttpRequest (req) {
		const url = new URL(req.url);

		// Check if this is an ACME challenge request
		if (url.pathname.startsWith(ACME_CHALLENGE_PREFIX) && this.config.acmeChallengeDir) {
			return await this.handleAcmeChallenge(url.pathname);
		}

		// In noSSL mode, handle requests directly instead of redirecting
		if (this.config.noSSL) {
			// Nothing to synchronize here (e.g. try/catch/finally), so skip await + overhead
			return this.handleHttpsRequest(req);
		}

		// Redirect all other HTTP requests to HTTPS
		const httpsUrl = `https://${url.hostname}${url.pathname}${url.search}`;
		return new Response(null, {
			status: 301,
			headers: {
				'Location': httpsUrl,
			},
		});
	}

	/**
	 * Handle ACME challenge requests for Let's Encrypt
	 */
	async handleAcmeChallenge (pathname) {
		try {
			// Extract the challenge token from the path
			const token = pathname.substring(ACME_CHALLENGE_PREFIX.length);
			const challengePath = `${this.config.acmeChallengeDir}/${token}`;

			// Read and return the challenge file
			const content = await Deno.readTextFile(challengePath);
			return new Response(content, {
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
				},
			});
		} catch (error) {
			this.logger.error(`ACME challenge failed: ${error.message}`);
			return new Response('Not Found', { status: 404 });
		}
	}

	/**
	 * Initialize router with current configuration
	 */
	initializeRouter () {
		this.configuration = new Configuration(this.configData);
		this.router = new Router(this.configuration);
		this.logger.debug(`Router initialized with ${this.router.routes.length} route(s)`);
	}

	/**
	 * Handle configuration update from config monitor
	 */
	async handleConfigUpdate (newConfig) {
		this.logger.info('Configuration updated; reloading...');
		this.configData = newConfig;

		// Apply default pool config if pools section is missing
		let poolsConfig = this.configData.at('pools');
		if (!poolsConfig || !(poolsConfig instanceof NANOS)) {
			this.logger.warn('No pools configured in reload, using defaults');
			poolsConfig = getDefaultPoolsConfig();
			this.configData.set('pools', poolsConfig);
		}

		// Update server config
		this.config = ServerConfig.fromNANOS(newConfig);

		// Update router configuration
		if (this.configuration && this.router) {
			this.configuration.updateConfig(newConfig);
			this.router.updateConfig();
			this.logger.debug(`Router updated with ${this.router.routes.length} route(s)`);
		}

		// Update process pools (shutdown old, create new, reconfigure existing)
		await this.updateProcessPools();

		// Send config update to all remaining service processes
		if (this.processManager) {
			for (const [processId, proc] of this.processManager.processes) {
				try {
					await this.processManager.sendConfigUpdate(proc);
					this.logger.debug(`Config update sent to ${processId}`);
				} catch (error) {
					this.logger.error(`Failed to send config update to ${processId}: ${error.message}`);
				}
			}
		}
	}

	/**
	 * Update process pools based on new configuration
	 * Strategy: Reconfig existing first, add new in parallel, shutdown removed in parallel
	 *
	 * This approach:
	 * 1. Updates existing pools immediately (PoolManager.updateConfig handles scaling)
	 * 2. Spins up new pools in parallel (fast startup)
	 * 3. Shuts down removed pools in parallel with timeout tracking
	 */
	async updateProcessPools () {
		this.logger.info('Updating process pools');
		const newPoolsConfig = this.configData.at('pools');
		if (!newPoolsConfig || !(newPoolsConfig instanceof NANOS)) {
			this.logger.error('updateProcessPools called but no pools config available');
			return;
		}

		const stopTime = this.configData.at('shutdownDelay', 30);
		const newPoolNames = new Set(newPoolsConfig.keys());
		const oldPoolNames = new Set(this.poolManagers.keys());

		// Identify pools to remove, reconfigure, and add
		const poolsToRemove = new Set();
		const poolsToReconfig = new Set();
		const poolsToAdd = new Set();

		for (const poolName of oldPoolNames) {
			if (poolName === '@router') continue; // Skip router pool (handled separately)

			if (!newPoolNames.has(poolName)) {
				poolsToRemove.add(poolName);
			} else {
				poolsToReconfig.add(poolName);
			}
		}

		for (const poolName of newPoolNames) {
			if (poolName === '@router') continue; // Skip router pool

			if (!oldPoolNames.has(poolName)) {
				poolsToAdd.add(poolName);
			}
		}

		// Phase 1: Reconfigure existing pools (synchronous, fast)
		for (const poolName of poolsToReconfig) {
			const poolManager = this.poolManagers.get(poolName);
			const newPoolConfig = newPoolsConfig.at(poolName);

			try {
				// Convert NANOS to plain object for PoolManager
				const configObj = newPoolConfig instanceof NANOS ? newPoolConfig.toObject() : newPoolConfig;
				poolManager.updateConfig(configObj);
				this.logger.info(`Pool '${poolName}' reconfigured`);
			} catch (error) {
				this.logger.error(`Failed to reconfigure pool '${poolName}': ${error.message}`);
			}
		}

		// Phase 2: Create new pools (parallel)
		const addPromises = [];
		for (const poolName of poolsToAdd) {
			this.logger.info(`Creating new pool: ${poolName}`);
			const poolConfig = newPoolsConfig.at(poolName);

			const addPromise = (async () => {
				try {
					// Convert NANOS to plain object for PoolManager
					const configObj = poolConfig instanceof NANOS ? poolConfig.toObject() : poolConfig;

					// Create item factory for this pool
					const itemFactory = async (itemId) => {
						return await this.processManager.createProcess(
							itemId,
							ProcessType.RESPONDER,
							poolName,
							poolConfig
						);
					};

					// Create and initialize PoolManager
					const poolManager = new PoolManager(poolName, configObj, itemFactory, this.logger);
					await poolManager.initialize();

					this.poolManagers.set(poolName, poolManager);
					return { poolName, success: true };
				} catch (error) {
					this.logger.error(`Failed to create pool '${poolName}': ${error.message}`);
					return { poolName, success: false };
				}
			})();

			addPromises.push(addPromise);
		}

		// Wait for all new pools to be created
		await Promise.all(addPromises);

		// Phase 3: Shutdown removed pools (parallel with timeout tracking)
		const removePromises = [];
		let completedShutdowns = 0;
		for (const poolName of poolsToRemove) {
			this.logger.info(`Shutting down removed pool: ${poolName}`);
			const poolManager = this.poolManagers.get(poolName);

			if (poolManager) {
				const removePromise = (async () => {
					try {
						await poolManager.shutdown(stopTime);
						this.poolManagers.delete(poolName);
						++completedShutdowns;

						// Clean up affinity map entries for this pool
						for (const [appletPath, itemIds] of this.affinityMap.entries()) {
							for (const itemId of itemIds) {
								if (itemId.startsWith(`${poolName}-`)) {
									itemIds.delete(itemId);
								}
							}
							if (itemIds.size === 0) {
								this.affinityMap.delete(appletPath);
							}
						}
					} catch (error) {
						this.logger.error(`Error shutting down pool '${poolName}': ${error.message}`);
					}
				})();

				removePromises.push(removePromise);
			}
		}

		// Wait for shutdowns with timeout (stopTime + 5s grace period)
		const shutdownTimeout = (stopTime + 5) * 1000;
		const timeoutPromise = Promise.withResolvers();
		const timer = setTimeout(timeoutPromise.resolve, shutdownTimeout);

		const shutdownResults = await Promise.race([
			Promise.all(removePromises),
			timeoutPromise.promise
		]);
		clearTimeout(timer); // In case timeout didn't already fire

		// Log summary
		this.logger.info(
			`Pool update summary: ${poolsToAdd.size} added, ` +
			`${poolsToReconfig.size} reconfigured, ` +
			`${completedShutdowns}/${poolsToRemove.size} completed shutdown`
		);
	}

	/**
	 * Handle HTTPS requests.
	 * Returns a Response.
	 */
	async handleHttpsRequest (req) {
		const startTime = Date.now();
		const url = new URL(req.url);
		const remote = req.headers.get('x-forwarded-for') || '127.0.0.1';

		try {
			// Use router to find matching route
			if (this.router) {
				const routeMatch = await this.router.findRoute(url.pathname, req.method);

				if (routeMatch) {
					const { route, match } = routeMatch;

					// Handle response codes (redirects, 404, etc.)
					if (route.response) {
						const status = typeof route.response === 'string'
							? parseInt(route.response.split(' ')[0])
							: route.response;

						if (route.href) {
							// Redirect response
							const duration = (Date.now() - startTime) / 1000;
							this.logger.logRequest(req.method, url.pathname, status, 0, duration, remote);

							return new Response(null, {
								status,
								headers: {
									'Location': route.href,
								},
							});
						}

						// Error response
						const body = JSON.stringify({
							error: `${status} ${route.response}`,
							path: url.pathname,
						});
						const duration = (Date.now() - startTime) / 1000;
						this.logger.logRequest(req.method, url.pathname, status, body.length, duration, remote);

						return new Response(body, {
							status,
							headers: {
								'Content-Type': 'application/json',
							},
						});
					}

					// Route matched - forward to service process
					const response = await this.forwardToServiceProcess(req, route, match, remote);

					const duration = (Date.now() - startTime) / 1000;
					const bytes = parseInt(response.headers.get('content-length') || '0');
					this.logger.logRequest(req.method, url.pathname, response.status, bytes, duration, remote);

					return response;
				}
			}

			// No route matched - return 404
			const body = JSON.stringify({
				error: '404 Not Found',
				path: url.pathname,
			});
			const duration = (Date.now() - startTime) / 1000;
			this.logger.logRequest(req.method, url.pathname, 404, body.length, duration, remote);

			return new Response(body, {
				status: 404,
				headers: {
					'Content-Type': 'application/json',
				},
			});
		} catch (error) {
			this.logger.error(`Request handling error: ${error.message}`);

			const body = JSON.stringify({
				error: '500 Internal Server Error',
				message: error.message,
			});
			const duration = (Date.now() - startTime) / 1000;
			this.logger.logRequest(req.method, url.pathname, 500, body.length, duration, remote);

			return new Response(body, {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
				},
			});
		}
	}

	/**
	 * Forward request to service process via IPC.
	 * Returns a Response.
	 */
	async forwardToServiceProcess (req, route, match, remote) {
		// Determine pool name from route (default to 'standard')
		const poolName = route.spec.at('pool', 'standard');
		const appletPath = match.app || route.app;

		// Get pool manager
		const poolManager = this.poolManagers.get(poolName);
		if (!poolManager) {
			this.logger.error(`Pool not found: ${poolName}`);
			return new Response(
				JSON.stringify({ error: '503 Service Unavailable', message: 'Pool not configured' }),
				{ status: 503, headers: { 'Content-Type': 'application/json' } }
			);
		}

		// Get available process from pool (with affinity preference)
		const poolItem = await this.getProcessWithAffinity(poolManager, appletPath);

		if (!poolItem) {
			this.logger.warn(`No available process in pool ${poolName}`);
			return new Response(
				JSON.stringify({ error: '503 Service Unavailable', message: 'No available workers' }),
				{ status: 503, headers: { 'Content-Type': 'application/json' } }
			);
		}

		const process = poolItem.item;

		// Mark as busy
		poolManager.markItemBusy(poolItem.id);

		// Capture route spec in closure scope (not on process object to avoid race conditions)
		const routeSpec = route.spec || null;

		try {
			// Update affinity
			if (appletPath) {
				this.updateAffinity(poolItem.id, appletPath);
			}

			// Read request body
			const bodyBytes = req.body ? await req.arrayBuffer() : new ArrayBuffer(0);
			const bodySize = bodyBytes.byteLength;

			// Convert headers to NANOS format
			const headersNanos = new NANOS().fromEntries(req.headers.entries());

			// Create IPC request message with complete URL and route spec
			const requestMsg = createRequest({
				method: req.method,
				url: req.url,                    // Complete URL
				app: appletPath,
				pool: poolName,
				headers: headersNanos,
				bodySize,
				remote,
				routeParams: match.params || {},
				routeTail: match.tail || '',
				routeSpec: route.spec || null,   // Add route spec for timeout resolution
			});

			// Send request to process using stream handler
			const url = new URL(req.url);
			this.logger.debug(`Sending WEB_REQUEST to ${process.id} for ${req.method} ${url.pathname}`);

			// Get timeout configuration for initial request
			const timeouts = this.configuration.getTimeoutConfig(poolName, routeSpec);
			const reqTimeout = timeouts.reqTimeout * 1000;

			// Create promise to capture first frame
			const firstFramePromise = new Promise((resolve, reject) => {
				let firstFrame = null;
				let firstData = null;

				// Register stream handler for this request
				process.ipcConn.setRequestHandler(
					requestMsg.at('id'),
					async (message, binaryData) => {
						// Handle error
						if (message instanceof Error) {
							reject(message);
							return;
						}

						// Capture first frame and resolve
						if (!firstFrame) {
							firstFrame = message;
							firstData = binaryData;
							// Clear this handler immediately - handleResponseStream will register a new one
							process.ipcConn.clearRequestHandler(requestMsg.at('id'));
							resolve({ message: firstFrame, binaryData: firstData });
						}
					},
					reqTimeout
				);
			});

			// Send request
			await process.ipcConn.writeMessage(requestMsg, new Uint8Array(bodyBytes));

			// Wait for first frame
			this.logger.debug('Sent; waiting for first frame...');
			const { message, binaryData } = await firstFramePromise;

			// Handle frame message (unified protocol)
			if (message.type === MessageType.WEB_FRAME) {
				return await this.handleFrameResponse(message.id, message, binaryData, process, req, poolName, routeSpec);
			} else {
				throw new Error(`Unexpected message type: ${message.type}`);
			}
		} catch (error) {
			this.logger.error(`IPC communication error with ${process.id}: ${error.message}`);
			return new Response(
				JSON.stringify({ error: '502 Bad Gateway', message: 'Service process error' }),
				{
					status: 502,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		} finally {
			// Mark as idle (triggers recycling check)
			await poolManager.markItemIdle(poolItem.id);
		}
	}

	/**
	 * Get process with affinity preference
	 * @param {PoolManager} poolManager Pool manager to get process from
	 * @param {string} appletPath Applet path for affinity
	 * @returns {Promise<PoolItem|null>} Pool item or null if none available
	 */
	async getProcessWithAffinity (poolManager, appletPath) {
		// Strategy 1: Find process with affinity
		if (appletPath) {
			const affinitySet = this.affinityMap.get(appletPath);
			if (affinitySet) {
				for (const itemId of affinitySet) {
					const item = poolManager.items.get(itemId);
					if (item && item.isAvailable()) {
						return item;
					}
				}
			}
		}

		// Strategy 2: Get any available process
		return await poolManager.getAvailableItem();
	}

	/**
	 * Update affinity tracking
	 * @param {string} itemId Pool item ID
	 * @param {string} appletPath Applet path
	 */
	updateAffinity (itemId, appletPath) {
		if (!appletPath) return;

		if (!this.affinityMap.has(appletPath)) {
			this.affinityMap.set(appletPath, new Set());
		}
		this.affinityMap.get(appletPath).add(itemId);
	}

	/**
	 * Convert NANOS-format headers to Headers
	 */
	convertHeaders (hdrIn) {
		const hdrOut = new Headers();
		if (hdrIn instanceof NANOS) {
			for (const [name, content] of hdrIn.entries()) {
				if (typeof content?.values === 'function') {
					// Multi-valued, e.g. Set-Cookie
					for (const content1 of content.values()) hdrOut.append(name, content1);
				} else hdrOut.set(name, content);
			}
		}
		return hdrOut;
	}

	/**
	 * Handle frame response (unified protocol)
	 */
	async handleFrameResponse (requestId, firstFrame, firstData, process, req, poolName, routeSpec) {
		const mode = firstFrame.fields.at('mode');
		const status = firstFrame.fields.at('status', 200);
		const headers = this.convertHeaders(firstFrame.fields.at('headers'));
		const keepAlive = firstFrame.fields.at('keepAlive', false);
		const final = firstFrame.fields.at('final', false);

		// Handle bidirectional upgrade
		if (mode === 'bidi' && status === 101) {
			return await this.handleBidiUpgrade(requestId, firstFrame, process, req, poolName, routeSpec);
		}

		// Handle response/stream modes
		if (mode === 'response' || mode === 'stream') {
			return await this.handleResponseStream(requestId, status, headers, keepAlive, final, firstData, process, poolName, routeSpec);
		}

		// Unknown mode
		throw new Error(`Unknown frame mode: ${mode}`);
	}

	/**
	 * Handle response or stream mode frames
	 */
	async handleResponseStream (requestId, status, headers, keepAlive, firstFinal, firstData, process, poolName, routeSpec) {
		// Create readable stream to handle frame messages
		const stream = new ReadableStream({
			start: async (controller) => {
				try {
					// Send first frame data if present
					if (firstData && firstData.length > 0) {
						controller.enqueue(firstData);
					}

					// If first frame is final and not keepAlive, close immediately
					if (firstFinal && !keepAlive) {
						controller.close();
						process.ipcConn.clearRequestHandler(requestId);
						return;
					}

					// Update stream handler to process subsequent frames
					// (handler was already registered in forwardToServiceProcess)
					// We need to replace it with one that feeds the controller
					process.ipcConn.clearRequestHandler(requestId);

					// Get timeout configuration from route/pool hierarchy (captured in closure)
					const streamTimeouts = this.configuration.getTimeoutConfig(poolName, routeSpec);
					const streamConTimeout = streamTimeouts.conTimeout * 1000;

					process.ipcConn.setRequestHandler(
						requestId,
						async (message, binaryData) => {
							// Handle error
							if (message instanceof Error) {
								controller.error(message);
								return;
							}

							if (message.type !== MessageType.WEB_FRAME) {
								controller.error(new Error(`Expected WEB_FRAME, got ${message.type}`));
								return;
							}

							// Send frame data chunk if present
							if (binaryData && binaryData.length > 0) {
								controller.enqueue(binaryData);
							}

							// Check if final chunk
							const final = message.fields.at('final', false);
							if (final) {
								const frameKeepAlive = message.fields.at('keepAlive', keepAlive);
								if (!frameKeepAlive) {
									// Last frame - close stream
									controller.close();
								}
								// Otherwise, more frames coming later (streaming mode)
							}
						},
						streamConTimeout
					);
				} catch (error) {
					controller.error(error);
				}
			},
		});

		return new Response(stream, {
			status,
			headers,
		});
	}

	/**
	 * Handle bidirectional connection upgrade (transport-agnostic)
	 */
	async handleBidiUpgrade (requestId, firstFrame, process, req, poolName, routeSpec) {
		try {
			// Get timeout configuration for bidi upgrade (from parameters, not process object)
			const timeouts = this.configuration.getTimeoutConfig(poolName, routeSpec);
			const reqTimeout = timeouts.reqTimeout * 1000;

			// Wait for protocol parameters from next frame (sent by responder after status 101)
			const paramsPromise = new Promise((resolve, reject) => {
				let gotParams = false;

				// Update stream handler to capture protocol parameters
				process.ipcConn.clearRequestHandler(requestId);
				process.ipcConn.setRequestHandler(
					requestId,
					async (message, binaryData) => {
						if (message instanceof Error) {
							reject(message);
							return;
						}

						if (!gotParams) {
							gotParams = true;
							resolve(message);
						}
					},
					reqTimeout
				);
			});

			const paramsMsg = await paramsPromise;

			if (paramsMsg.type !== MessageType.WEB_FRAME) {
				throw new Error(`Expected WEB_FRAME with protocol params, got ${paramsMsg.type}`);
			}

			// Extract protocol parameters (transport-independent)
			const initialCredits = paramsMsg.fields.at('initialCredits', 655360);
			const maxChunkSize = paramsMsg.fields.at('maxChunkSize', 65536);
			const maxBytesPerSecond = paramsMsg.fields.at('maxBytesPerSecond', 10485760);
			const idleTimeout = paramsMsg.fields.at('idleTimeout', 60);
			const maxBufferSize = paramsMsg.fields.at('maxBufferSize', 1048576);

			// Determine transport type from request headers
			const upgradeHeader = req.headers.get('upgrade');

			if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
				// WebSocket transport
				return await this.handleWebSocketUpgrade(
					requestId, process, req,
					initialCredits, maxChunkSize, maxBytesPerSecond, idleTimeout, maxBufferSize
				);
			}

			// Future: Add other bidirectional transports here
			// else if (upgradeHeader && upgradeHeader.toLowerCase() === 'h2') {
			//   return await this.handleHTTP2Upgrade(...);
			// }

			// Unsupported transport
			throw new Error(`Unsupported bidirectional transport: ${upgradeHeader || 'none'}`);

		} catch (error) {
			this.logger.error(`Bidi upgrade error: ${error.message}`);
			return new Response('Bidirectional upgrade failed', {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	}

	/**
	 * Handle WebSocket-specific upgrade (transport-specific helper)
	 */
	async handleWebSocketUpgrade (requestId, process, req, initialCredits, maxChunkSize, maxBytesPerSecond, idleTimeout, maxBufferSize) {
		// Verify WebSocket upgrade headers
		const connectionHeader = req.headers.get('connection');
		if (!connectionHeader || !connectionHeader.toLowerCase().includes('upgrade')) {
			this.logger.error(`WebSocket upgrade but Connection header missing upgrade`);
			return new Response('Bad Request: Invalid Connection header', {
				status: 400,
				headers: { 'Content-Type': 'text/plain' },
			});
		}

		// Upgrade to WebSocket
		const { socket, response } = Deno.upgradeWebSocket(req);

		// Track connection state
		const connState = {
			socket,
			process,
			requestId,
			outboundCredits: initialCredits,
			inboundCredits: initialCredits,
			maxCredits: initialCredits,
			maxChunkSize,
			maxBytesPerSecond,
			idleTimeout,
			maxBufferSize,
			lastActivity: Date.now(),
		};

		this.bidiConnections.set(requestId, connState);

		// Handle WebSocket messages from client
		socket.onmessage = async (event) => {
			try {
				await this.handleClientBidiMessage(requestId, event.data, connState);
			} catch (error) {
				this.logger.error(`Bidi client message error: ${error.message}`);
				socket.close(1011, 'Internal error');
				this.bidiConnections.delete(requestId);
			}
		};

		// Handle WebSocket close from client
		socket.onclose = () => {
			this.logger.debug(`Bidi connection ${requestId} closed by client`);
			this.bidiConnections.delete(requestId);
		};

		// Handle WebSocket errors
		socket.onerror = (error) => {
			this.logger.error(`Bidi connection ${requestId} error: ${error}`);
			this.bidiConnections.delete(requestId);
		};

		// Start reading frames from responder process
		this.readBidiFrames(requestId, connState, poolName, routeSpec);

		return response;
	}

	/**
	 * Handle client message in bidirectional connection
	 */
	async handleClientBidiMessage (requestId, data, connState) {
		// Convert WebSocket message to Uint8Array
		let frameData;
		if (typeof data === 'string') {
			frameData = new TextEncoder().encode(data);
		} else if (data instanceof ArrayBuffer) {
			frameData = new Uint8Array(data);
		} else if (data instanceof Uint8Array) {
			frameData = data;
		} else {
			this.logger.warn(`Unexpected WebSocket data type: ${typeof data}`);
			return;
		}

		const chunkSize = frameData.length;

		// Check credits (flow control)
		if (connState.inboundCredits < chunkSize) {
			this.logger.warn(`Client ${requestId} exceeded inbound credits`);
			connState.socket.close(1008, 'Flow control violation');
			this.bidiConnections.delete(requestId);
			return;
		}

		// Consume credits
		connState.inboundCredits -= chunkSize;

		// Forward to responder process via IPC using frame protocol
		const frameMsg = createFrame(requestId, {
			data: frameData,
			final: false
		});
		await connState.process.ipcConn.writeMessage(frameMsg, frameData);

		// Implicit credit grant (applet processes the data)
		connState.inboundCredits = Math.min(
			connState.inboundCredits + chunkSize,
			connState.maxCredits
		);

		// Update activity timestamp
		connState.lastActivity = Date.now();
	}

	/**
	 * Read bidirectional frames from responder process using stream handler
	 */
	async readBidiFrames (requestId, connState, poolName, routeSpec) {
		// Get timeout configuration for bidi connection (from parameters, not process object)
		const timeouts = this.configuration.getTimeoutConfig(poolName, routeSpec);
		const bidiConTimeout = timeouts.conTimeout * 1000;

		// Replace stream handler to process bidi frames
		connState.process.ipcConn.clearRequestHandler(requestId);
		connState.process.ipcConn.setRequestHandler(
			requestId,
			async (message, binaryData) => {
				try {
					// Handle error
					if (message instanceof Error) {
						this.logger.error(`Bidi frame error for ${requestId}: ${message.message}`);
						if (this.bidiConnections.has(requestId)) {
							connState.socket.close(1011, 'Internal error');
							this.bidiConnections.delete(requestId);
						}
						return;
					}

					if (message.type !== MessageType.WEB_FRAME) {
						this.logger.warn(`Expected WEB_FRAME for bidi ${requestId}, got ${message.type}`);
						return;
					}

					const mode = message.fields.at('mode');
					if (mode && mode !== 'bidi') {
						this.logger.warn(`Expected mode='bidi' for ${requestId}, got ${mode}`);
						return;
					}

					const final = message.fields.at('final', false);
					const keepAlive = message.fields.at('keepAlive', true);

					// Send data to WebSocket client
					if (binaryData && binaryData.length > 0) {
						const chunkSize = binaryData.length;

						// Check credits
						if (connState.outboundCredits < chunkSize) {
							this.logger.warn(`Responder ${requestId} exceeded outbound credits`);
							connState.socket.close(1008, 'Flow control violation');
							this.bidiConnections.delete(requestId);
							return;
						}

						// Consume credits
						connState.outboundCredits -= chunkSize;

						// Send to client
						connState.socket.send(binaryData);

						// Implicit credit grant
						connState.outboundCredits = Math.min(
							connState.outboundCredits + chunkSize,
							connState.maxCredits
						);
					}

					// Handle connection close
					if (final && !keepAlive) {
						connState.socket.close(1000, 'Normal closure');
						this.bidiConnections.delete(requestId);
					}

					// Update activity timestamp
					connState.lastActivity = Date.now();
				} catch (error) {
					this.logger.error(`Bidi frame handler error for ${requestId}: ${error.message}`);
					if (this.bidiConnections.has(requestId)) {
						connState.socket.close(1011, 'Internal error');
						this.bidiConnections.delete(requestId);
					}
				}
			},
			bidiConTimeout
		);
	}

	/**
	 * Initialize service process pools
	 */
	async initializeProcessPools () {
		let poolsConfig = this.configData.at('pools');
		if (!poolsConfig || !(poolsConfig instanceof NANOS)) {
			this.logger.warn('No pools configured, using defaults');
			poolsConfig = getDefaultPoolsConfig();
			// Store back in config for consistency
			this.configData.set('pools', poolsConfig);
		}

		// Create PoolManager for each pool
		for (const [poolName, poolConfig] of poolsConfig.entries()) {
			if (poolName === '@router') {
				// Router pool - only spawn if fsRouting is enabled
				const fsRouting = this.configData.at('fsRouting', false);
				if (fsRouting) {
					this.logger.info(`Initializing router pool '${poolName}' (filesystem routing)`);
					// Router pool uses PoolManager (already implemented in router-process)
					// This is handled separately by router-process.esm.js
					// For now, we don't create a PoolManager here since router processes
					// manage their own worker pools internally
				}
			} else {
				// Responder pool - create PoolManager
				this.logger.info(`Initializing pool '${poolName}' with PoolManager`);

				// Convert NANOS to plain object for PoolManager
				const configObj = poolConfig instanceof NANOS ? poolConfig.toObject() : poolConfig;

				// Create item factory for this pool
				const itemFactory = async (itemId) => {
					return await this.processManager.createProcess(
						itemId,
						ProcessType.RESPONDER,
						poolName,
						poolConfig
					);
				};

				// Create and initialize PoolManager
				const poolManager = new PoolManager(poolName, configObj, itemFactory, this.logger);
				await poolManager.initialize();

				this.poolManagers.set(poolName, poolManager);
			}
		}
	}

	/**
	 * Start health check monitoring
	 */
	startHealthCheckMonitoring () {
		const intervalSeconds = this.configData.at('healthCheckInterval', 60);

		this.healthCheckInterval = setInterval(async () => {
			try {
				await this.processManager.healthCheck();
			} catch (error) {
				this.logger.error(`Health check error: ${error.message}`);
			}
		}, intervalSeconds * 1000);

		this.logger.info(`Health check monitoring started (interval: ${intervalSeconds}s)`);
	}

	/**
	 * Validate uid/gid configuration based on current user privileges
	 */
	validatePrivilegeConfiguration () {
		const isRoot = Deno.uid() === 0;
		const uid = this.configData.at('uid');
		const gid = this.configData.at('gid');

		if (isRoot) {
			// Running as root - uid/gid are REQUIRED
			if (!uid || !gid) {
				const message = 'Fatal: uid and gid must be configured when running as root. Service processes require privilege dropping for security.';
				this.logger.error(message);
				throw new Error(message);
			}
			this.logger.info(`Privilege dropping configured: uid=${uid}, gid=${gid}`);
		} else {
			// Not running as root - uid/gid should NOT be present
			if (uid || gid) {
				this.logger.warn(`Warning: uid/gid configuration present (uid=${uid}, gid=${gid}), but will not be set (operator is not running as root).`);
			}
		}
	}

	/**
	 * Reload HTTPS server with updated certificates
	 */
	async reloadHttpsServer () {
		if (this.isReloading) {
			this.logger.warn('Server reload already in progress');
			return;
		}

		this.isReloading = true;
		this.logger.info('Reloading HTTPS server with updated certificates...');

		try {
			// Shutdown existing HTTPS server
			if (this.httpsServer) {
				await this.httpsServer.shutdown();
				this.logger.info('Previous HTTPS server stopped');
			}

			// Start new HTTPS server with updated certificates
			await this.startHttpsServer();
			this.logger.info('HTTPS server reloaded successfully');
		} catch (error) {
			this.logger.error(`Failed to reload HTTPS server: ${error.message}`);
			throw error;
		} finally {
			this.isReloading = false;
		}
	}

	/**
	 * Start the operator process
	 */
	async start () {
		this.logger.info('Starting JSMAWS operator process...');

		// Validate uid/gid configuration based on current user
		this.validatePrivilegeConfiguration();

		// Initialize router with current configuration
		this.initializeRouter();

		// Initialize process manager
		this.initializeProcessManager();

		// Initialize service process pools
		await this.initializeProcessPools();

		// Start HTTP server (always runs for redirects and ACME)
		await this.startHttpServer();

		// Start HTTPS server if certificates are available
		if (!this.config.noSSL) {
			if (this.config.certFile && this.config.keyFile) {
				await this.startHttpsServer();
			} else {
				throw new Error('SSL certificates required (certFile and keyFile must be configured, or use noSSL=@t)');
			}
		}

		// Start SSL certificate monitoring
		if (!this.config.noSSL && this.config.certFile && this.config.keyFile) {
			this.sslManager = createSSLManager(
				this.config,
				() => this.reloadHttpsServer()
			);
			await this.sslManager.startMonitoring();
		}

		// Start configuration file monitoring
		this.configMonitor = createConfigMonitor(
			this.configPath,
			(newConfig) => this.handleConfigUpdate(newConfig)
		);
		await this.configMonitor.startMonitoring();

		// Start health check monitoring
		this.startHealthCheckMonitoring();

		this.logger.info('JSMAWS operator process started successfully');
	}

	/**
	 * Gracefully shutdown the operator process
	 */
	async shutdown () {
		if (this.isShuttingDown) {
			return;
		}

		const stopTime = this.configData.at('shutdownDelay', 30);

		this.isShuttingDown = true;
		this.logger.info('Shutting down JSMAWS operator process...');

		// Stop health check monitoring
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}

		// Stop configuration monitoring
		if (this.configMonitor) {
			this.configMonitor.stopMonitoring();
		}

		// Stop SSL monitoring
		if (this.sslManager) {
			this.sslManager.stopMonitoring();
		}

		const tasks = [];

		// Shutdown HTTP server
		if (this.httpServer) {
			tasks.push(this.httpServer.shutdown().then(() => this.logger.info('HTTP server stopped')));
		}

		// Shutdown HTTPS server
		if (this.httpsServer) {
			tasks.push(this.httpsServer.shutdown().then(() => this.logger.info('HTTPS server stopped')));
		}

		// Shutdown all pool managers
		if (this.poolManagers) {
			for (const [poolName, poolManager] of this.poolManagers) {
				this.logger.info(`Shutting down pool: ${poolName}`);
				tasks.push(poolManager.shutdown(stopTime));
			}
		}

		// Shutdown any remaining processes not in pools
		if (this.processManager) {
			tasks.push(this.processManager.shutdown(stopTime));
		}

		// Allow for graceful shutdown, but give it a hard limit before simply exiting
		if (tasks.length) {
			const timeout = new Promise((resolve) => setTimeout(resolve, (stopTime + 5) * 1000));
			await Promise.race([Promise.all(tasks), timeout]);
		}

		// Close logger
		if (this.logger) {
			await this.logger.close();
		}

		this.logger.info('JSMAWS operator process shutdown complete');
	}
}

/**
 * Main entry point
 */
async function main () {
	// Parse command line arguments
	const args = Deno.args;
	const configFile = args[0] || DEFAULT_CONFIG_FILE;

	// Load configuration from SLID file
	console.log(`Loading configuration from: ${configFile}`);
	const configData = await loadConfig(configFile);
	const config = ServerConfig.fromNANOS(configData);

	console.log('Operator configuration:');
	console.log(`  HTTP Port: ${config.httpPort}`);
	console.log(`  HTTPS Port: ${config.httpsPort}`);
	console.log(`  Hostname: ${config.hostname}`);
	console.log(`  SSL Mode: ${config.noSSL ? 'disabled' : 'enabled'}`);
	console.log(`  Cert File: ${config.certFile || '(not configured)'}`);
	console.log(`  Key File: ${config.keyFile || '(not configured)'}`);
	console.log(`  SSL Check Interval: ${config.sslCheckIntervalHours} hour(s)`);
	console.log(`  ACME Challenge Dir: ${config.acmeChallengeDir || '(not configured)'}`);

	// Create and start operator
	const operator = new OperatorProcess(config, configFile);
	operator.configData = configData; // Store full config
	operator.initializeLogger();

	// Handle shutdown signals
	const shutdownHandler = async () => {
		await operator.shutdown();
		Deno.exit(0);
	};

	Deno.addSignalListener('SIGINT', shutdownHandler);
	Deno.addSignalListener('SIGTERM', shutdownHandler);

	// Start the operator
	await operator.start();
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing and module usage
export { OperatorProcess, ServerConfig, loadConfig };
