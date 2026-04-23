/**
 * JSMAWS Operator Process
 * Main operator class for managing the server
 *
 * This is the privileged operator process that:
 * - Binds to HTTP/HTTPS ports (80, 443)
 * - Manages configuration and SSL certificates
 * - Spawns and manages service processes (responders and routers)
 * - Routes requests to appropriate service processes via IPC
 * - Never executes user code directly
 * 
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS, parseSLID } from '@nanos';
import { BufferPool } from '@poly-transport/buffer-pool.esm.js';
import { createSSLManager } from './ssl-manager.esm.js';
import { Router } from './router-worker.esm.js';
import { Configuration } from './configuration.esm.js';
import { createConfigMonitor } from './config-monitor.esm.js';
import { createLogger } from './logger.esm.js';
import { ProcessManager, ProcessType } from './process-manager.esm.js';
import { PoolManager } from './pool-manager.esm.js';
import { RequestContext, RequestState } from './operator-request-state.esm.js';

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';

/**
 * Get default pool configuration when none is provided
 * @returns {Object} Default pools configuration (plain object)
 */
function getDefaultPoolsConfig () {
	return {
		standard: {
			minProcs: 1,
			maxProcs: 20,
			maxWorkers: 4,
			maxReqs: 100,
			reqTimeout: 60,
			conTimeout: 300,
		},
	};
}

/**
 * Server configuration
 */
export class ServerConfig {
	constructor (options = {}) {
		this.httpPort = options.httpPort ?? DEFAULT_HTTP_PORT;
		this.httpsPort = options.httpsPort ?? DEFAULT_HTTPS_PORT;
		this.certFile = options.certFile;
		this.keyFile = options.keyFile;
		this.hostname = options.hostname ?? 'localhost';
		this.acmeChallengeDir = options.acmeChallengeDir;
		this.noSSL = options.noSSL ?? false;
		this.sslCheckIntervalHours = options.sslCheckIntervalHours ?? 1;
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
export class OperatorProcess {
	constructor (config, configPath) {
		this.config = config;
		this.configData = new NANOS(); // Full SLID configuration (NANOS, for legacy compat)
		this.configuration = new Configuration({}); // Configuration instance (plain objects)
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
		this.requestContexts = new Map(); // requestId -> RequestContext
		this.healthCheckInterval = null;
		// Shared buffer pool for all operator-side transports (WebSocketTransports to clients)
		this.bufferPool = new BufferPool({
			sizeClasses: [1024, 4096, 16384, 65536],
			lowWaterMark: 2,
			highWaterMark: 10,
		});
	}

	/**
	 * Remove a completed request context from the requestContexts map.
	 * No-op if the context is not in COMPLETED state.
	 */
	cleanupRequestContext (requestId) {
		const context = this.requestContexts.get(requestId);
		if (context?.state === RequestState.COMPLETED) {
			this.requestContexts.delete(requestId);
			this.logger.debug(`[${requestId}] Context cleaned up`);
		}
	}

	/**
	 * Convert a plain-object headers map to a Headers instance.
	 * Responder sends headers as a plain JSON object (from JSON deserialization).
	 * Multi-valued headers (e.g. Set-Cookie) are represented as arrays.
	 */
	convertHeaders (hdrIn) {
		const hdrOut = new Headers();
		if (!hdrIn) return hdrOut;
		for (const [name, value] of Object.entries(hdrIn)) {
			if (Array.isArray(value)) {
				for (const v of value) hdrOut.append(name, String(v));
			} else {
				hdrOut.set(name, String(value));
			}
		}
		return hdrOut;
	}

	/**
	 * Forward request to service process via PipeTransport using state machine
	 */
	async forwardToServiceProcess (req, route, match, remote) {
		const poolName = route.spec?.pool ?? 'standard';
		const appletPath = match.app || route.app;
		const root = match.root;

		// Get pool manager
		const poolManager = this.poolManagers.get(poolName);
		if (!poolManager) {
			this.logger.error(`Pool not found: ${poolName}`);
			return new Response(
				JSON.stringify({ error: '503 Service Unavailable', message: 'Pool not configured' }),
				{ status: 503, headers: { 'content-type': 'application/json' } }
			);
		}

		// Get available (reserved) process from pool
		const poolItem = await poolManager.serialize(async () => await this.getProcessWithAffinity(poolManager, appletPath)).catch((error) => {
			this.logger.error(`Service process selection error: ${error.message}`);
			return null;
		});

		if (!poolItem) {
			this.logger.warn(`No available process in pool ${poolName}`);
			return new Response(
				JSON.stringify({ error: '503 Service Unavailable', message: 'No available workers' }),
				{ status: 503, headers: { 'content-type': 'application/json' } }
			);
		}

		const process = poolItem.item;
		const routeSpec = route.spec || null;

		// Acquire a req-N channel from the process's channel pool
		const reqChannel = await process.reqChannelPool.acquire();

		// Create context before the try block so the catch block can always call
		// context.releaseReqChannel() without a null check.
		const requestId = `${process.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const context = new RequestContext(
			requestId,
			process,
			poolName,
			routeSpec,
			req,
			appletPath,
			this,  // operator
		);
		context.poolManager = poolManager;
		context.poolItemId = poolItem.id;
		// Store reqChannel now so releaseReqChannel() works even if an error occurs
		// before processReqChannelMessages() is called.
		context.reqChannel = reqChannel;

		try {
			if (appletPath) {
				this.updateAffinity(poolItem, appletPath);
			}

			// Read request body
			const bodyBytes = req.body ? await req.arrayBuffer() : new ArrayBuffer(0);

			// Convert headers to plain object for JSON serialization
			const headersObj = Object.fromEntries(req.headers.entries());

			const url = new URL(req.url);
			this.logger.debug(`Sending ${requestId} to ${process.id} (usage ${poolItem.usageCount}) for ${req.method} ${url.pathname}`);

			// Store context
			this.requestContexts.set(requestId, context);

			// Start processing req-N channel messages (handles res, res-error, res-frame, bidi-frame, con-*)
			context.processReqChannelMessages(reqChannel);

			// Build request payload
			const requestPayload = JSON.stringify({
				id: requestId,
				method: req.method,
				url: req.url,
				app: appletPath,
				root,
				pool: poolName,
				headers: headersObj,
				body: bodyBytes.byteLength > 0 ? Array.from(new Uint8Array(bodyBytes)) : null,
				remote,
				routeParams: match.params || {},
				routeTail: match.tail || '',
				routeSpec: route.spec || null,
			});

			// Send request via req-N channel
			await reqChannel.write('req', requestPayload);

			// Return Response promise that will be resolved by state machine.
			// Note: the req-N channel is released by context.releaseReqChannel() when
			// the state machine reaches COMPLETED (EOS for streaming, WS close for bidi).
			const response = await context.responsePromise.promise;

			// Note: decrementItemUsage() is called by the state machine when connections actually close:
			// - Streaming responses: in handleResFrame() when end-of-stream arrives
			// - Bidi connections: in wsTransport 'stopped' event handler
			// This ensures processes are only marked idle after connections fully complete,
			// preventing premature recycling of processes with active streaming/bidi connections.

			return response;

		} catch (error) {
			this.logger.error(`Request error with ${process.id}: ${error.message}`);
			// Release the req-N channel on error (state machine won't do it)
			context.releaseReqChannel();
			// Mark idle on error
			await poolItem.decrementUsage();
			return new Response(
				JSON.stringify({ error: '502 Bad Gateway', message: 'Service process error' }),
				{
					status: 502,
					headers: { 'content-type': 'application/json' },
				}
			);
		}
	}

	/**
	 * Get process with affinity preference
	 */
	async getProcessWithAffinity (poolManager, appletPath) {
		const affinitySet = appletPath && this.affinityMap.get(appletPath);
		const item = await poolManager.getAvailableItem(affinitySet);
		if (item) this.logger.debug(`available: ${item.id} (usage ${item.usageCount})`);
		else this.logger.debug('nothing available');
		return item;
	}

	/**
	 * Handle ACME challenge requests for Let's Encrypt
	 */
	async handleAcmeChallenge (pathname) {
		try {
			const token = pathname.substring(ACME_CHALLENGE_PREFIX.length);
			const challengePath = `${this.config.acmeChallengeDir}/${token}`;

			const content = await Deno.readTextFile(challengePath);
			return new Response(content, {
				status: 200,
				headers: {
					'content-type': 'text/plain',
				},
			});
		} catch (error) {
			this.logger.error(`ACME challenge failed: ${error.message}`);
			return new Response('Not Found', { status: 404 });
		}
	}

	/**
	 * Handle configuration update from config monitor
	 */
	async handleConfigUpdate (newConfig) {
		this.logger.info('Configuration updated; reloading...');
		this.configData = newConfig; // Keep NANOS for legacy compat

		// Update Configuration instance (converts NANOS to plain objects)
		this.configuration.updateConfig(newConfig);

		// Apply default pool config only if pools section is absent (null/undefined).
		// An explicitly empty pools object ({}) is respected as-is (no pools configured).
		if (this.configuration.config.pools == null) {
			this.logger.warn('No pools configured in reload, using defaults');
			this.configuration.config.pools = getDefaultPoolsConfig();
			this.configuration._pools = null; // Invalidate cache
		}

		// Update server config
		this.config = ServerConfig.fromNANOS(newConfig);

		// Update router configuration
		if (this.router) {
			this.router.updateConfig();
			this.logger.debug(`Router updated with ${this.router.routes.length} route(s)`);
		}

		// Update process pools
		await this.updateProcessPools();

		// Broadcast config update to all service processes via their control channels
		if (this.processManager) {
			await this.processManager.broadcastConfigUpdate();
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
	 * Handle HTTPS requests
	 */
	async handleHttpsRequest (req) {
		const startTime = Date.now();
		const url = new URL(req.url);
		const remote = req.headers.get('x-forwarded-for') || '127.0.0.1';

		try {
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
							const duration = (Date.now() - startTime) / 1000;
							this.logger.logRequest(req.method, url.pathname, status, 0, duration, remote);

							return new Response(null, {
								status,
								headers: { 'Location': route.href },
							});
						}

						const body = JSON.stringify({
							error: `${status} ${route.response}`,
							path: url.pathname,
						});
						const duration = (Date.now() - startTime) / 1000;
						this.logger.logRequest(req.method, url.pathname, status, body.length, duration, remote);

						return new Response(body, {
							status,
							headers: { 'content-type': 'application/json' },
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
				headers: { 'content-type': 'application/json' },
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
				headers: { 'content-type': 'application/json' },
			});
		}
	}

	/**
	 * Initialize logger
	 */
	initializeLogger () {
		const loggingConfig = this.configuration.logging;
		this.logger = createLogger({
			target: loggingConfig.destination ?? 'console',
			level: loggingConfig.level ?? 'info',
			format: loggingConfig.format ?? 'apache',
			component: 'operator',
		});
	}

	/**
	 * Initialize process manager
	 */
	initializeProcessManager () {
		this.processManager = new ProcessManager(this.configuration, this.logger);
	}

	/**
	 * Initialize service process pools
	 */
	async initializeProcessPools () {
		// Check raw config to distinguish "not configured" (undefined) from "explicitly empty" ({})
		const rawPools = this.configuration.config.pools;
		let poolsConfig;
		if (rawPools == null) {
			// Pools not configured at all — use defaults
			this.logger.warn('No pools configured, using defaults');
			poolsConfig = getDefaultPoolsConfig();
			this.configuration.config.pools = poolsConfig;
			this.configuration._pools = null; // Invalidate cache
		} else {
			// Pools explicitly configured (even if empty)
			poolsConfig = rawPools;
		}

		// Create PoolManager for each pool
		for (const [poolName, poolConfig] of Object.entries(poolsConfig)) {
			if (poolName === '@router') {
				const fsRouting = this.configuration.routing.fsRouting;
				if (fsRouting) {
					this.logger.info(`Initializing router pool '${poolName}' (filesystem routing)`);
				}
			} else {
				this.logger.info(`Initializing pool '${poolName}' with PoolManager`);

				const itemFactory = async (itemId) => {
					return await this.processManager.createProcess(
						itemId,
						ProcessType.RESPONDER,
						poolName,
						poolConfig
					);
				};

				const poolManager = new PoolManager(poolName, poolConfig, itemFactory, this.logger);
				await poolManager.initialize();

				this.poolManagers.set(poolName, poolManager);
			}
		}
	}

	/**
	 * Initialize router with current configuration
	 */
	initializeRouter () {
		// this.configuration is already initialized in constructor and updated via handleConfigUpdate
		// Just create the router with the current configuration
		this.router = new Router(this.configuration);
		this.logger.debug(`Router initialized with ${this.router.routes.length} route(s)`);
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
			if (this.httpsServer) {
				await this.httpsServer.shutdown();
				this.logger.info('Previous HTTPS server stopped');
			}

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
	 * Gracefully shutdown the operator process
	 */
	async shutdown (stopTime = null) {
		if (this.isShuttingDown) {
			return;
		}
		this.isShuttingDown = true;

		stopTime ??= this.configuration.config.shutdownDelay ?? 30;
		this.logger.info(`Shutting down JSMAWS operator process (${stopTime}s)...`);

		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}

		if (this.configMonitor) {
			this.configMonitor.stopMonitoring();
		}

		if (this.sslManager) {
			this.sslManager.stopMonitoring();
		}

		const tasks = []; // Async shutdown-tasks

		if (this.httpServer) {
			tasks.push(this.httpServer.shutdown().then(() => this.logger.info('HTTP server stopped')));
		}

		if (this.httpsServer) {
			tasks.push(this.httpsServer.shutdown().then(() => this.logger.info('HTTPS server stopped')));
		}

		if (this.poolManagers) {
			for (const [poolName, poolManager] of this.poolManagers) {
				this.logger.info(`Shutting down pool: ${poolName}`);
				tasks.push(poolManager.shutdown(stopTime));
			}
		}

		if (this.processManager) {
			tasks.push(this.processManager.shutdown(stopTime));
		}

		if (tasks.length) {
			const wrapUpPromise = Promise.withResolvers();
			wrapUpPromise.promise.then((completed) => {
				if (!completed) this.logger.info('Operator shutdown timed out');
			});
			const wrapUpTimer = setTimeout(wrapUpPromise.resolve, (stopTime + 2) * 1000);
			await Promise.race([Promise.all(tasks), wrapUpPromise.promise]);
			wrapUpPromise.resolve(true);
			clearTimeout(wrapUpTimer);
		}

		// Stop buffer pool (operator process is exiting)
		if (this.bufferPool) {
			this.bufferPool.stop();
		}

		this.logger.info('JSMAWS operator process shutdown complete');
		await this.logger.close();
	}

	/**
	 * Start the operator process
	 */
	async start () {
		this.logger.info('Starting JSMAWS operator process...');

		this.validatePrivilegeConfiguration();
		this.initializeRouter();
		this.initializeProcessManager();
		await this.initializeProcessPools();
		await this.startHttpServer();

		if (!this.config.noSSL) {
			if (this.config.certFile && this.config.keyFile) {
				await this.startHttpsServer();
			} else {
				throw new Error('SSL certificates required (certFile and keyFile must be configured, or use noSSL=@t)');
			}
		}

		if (!this.config.noSSL && this.config.certFile && this.config.keyFile) {
			this.sslManager = createSSLManager(
				this.config,
				() => this.reloadHttpsServer()
			);
			await this.sslManager.startMonitoring();
		}

		if (this.configPath) {
			this.configMonitor = createConfigMonitor(
				this.configPath,
				(newConfig) => this.handleConfigUpdate(newConfig)
			);
			await this.configMonitor.startMonitoring();
		}

		this.startHealthCheckMonitoring();

		this.logger.info('JSMAWS operator process started successfully');
	}

	/**
	 * Start health check monitoring
	 */
	startHealthCheckMonitoring () {
		const intervalSeconds = this.configuration.config.healthCheckInterval ?? 60;

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
	 * Start the HTTP server (for redirects and ACME challenges)
	 */
	startHttpServer () {
		const handler = (req) => this.handleHttpRequest(req);

		this.httpServer = Deno.serve({
			port: this.config.httpPort,
			hostname: this.config.hostname,
			onListen: ({ hostname, port }) => {
				this.logger.info(`HTTP server listening on http://${hostname}:${port}`);
			},
		}, handler);
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
		} catch (error) {
			this.logger.error(`Failed to start HTTPS server: ${error.message}`);
			if (!this.config.noSSL) {
				throw error;
			}
		}
	}

	/**
	 * Update affinity tracking
	 */
	updateAffinity (item, appletPath) {
		if (!appletPath) return;

		if (!this.affinityMap.has(appletPath)) {
			this.affinityMap.set(appletPath, new Set());
		}
		const appletMap = this.affinityMap.get(appletPath);
		if (!appletMap.has(item.id)) {
			appletMap.add(item.id);
			//console.debug(`Adding affinity ${item.id} for ${appletPath}`);
			item.onShutdown(() => {
				//console.debug(`Removing affinity ${item.id} for ${appletPath}`);
				appletMap.delete(item.id);
			});
		}
	}

	/**
	 * Update process pools based on new configuration
	 */
	async updateProcessPools () {
		this.logger.info('Updating process pools');
		const newPoolsConfig = this.configuration.pools;

		const stopTime = this.configuration.config.shutdownDelay ?? 30;
		const newPoolNames = new Set(Object.keys(newPoolsConfig));
		const oldPoolNames = new Set(this.poolManagers.keys());

		// Identify pools to remove, reconfigure, and add
		const poolsToRemove = new Set();
		const poolsToReconfig = new Set();
		const poolsToAdd = new Set();

		for (const poolName of oldPoolNames) {
			if (poolName === '@router') continue;

			if (!newPoolNames.has(poolName)) {
				poolsToRemove.add(poolName);
			} else {
				poolsToReconfig.add(poolName);
			}
		}

		for (const poolName of newPoolNames) {
			if (poolName === '@router') continue;

			if (!oldPoolNames.has(poolName)) {
				poolsToAdd.add(poolName);
			}
		}

		// Phase 1: Reconfigure existing pools
		for (const poolName of poolsToReconfig) {
			const poolManager = this.poolManagers.get(poolName);
			const newPoolConfig = newPoolsConfig[poolName];

			try {
				poolManager.updateConfig(newPoolConfig);
				this.logger.info(`Pool '${poolName}' reconfigured`);
			} catch (error) {
				this.logger.error(`Failed to reconfigure pool '${poolName}': ${error.message}`);
			}
		}

		// Phase 2: Create new pools (parallel)
		const addPromises = [];
		for (const poolName of poolsToAdd) {
			this.logger.info(`Creating new pool: ${poolName}`);
			const poolConfig = newPoolsConfig[poolName];

			const addPromise = (async () => {
				try {
					const itemFactory = async (itemId) => {
						return await this.processManager.createProcess(
							itemId,
							ProcessType.RESPONDER,
							poolName,
							poolConfig
						);
					};

					const poolManager = new PoolManager(poolName, poolConfig, itemFactory, this.logger);
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

		await Promise.all(addPromises);

		// Phase 3: Shutdown removed pools (parallel)
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
					} catch (error) {
						this.logger.error(`Error shutting down pool '${poolName}': ${error.message}`);
					}
				})();

				removePromises.push(removePromise);
			}
		}

		// Wait for shutdowns with timeout
		const shutdownTimeout = (stopTime + 5) * 1000;
		const timeoutPromise = Promise.withResolvers();
		const timer = setTimeout(timeoutPromise.resolve, shutdownTimeout);

		await Promise.race([
			Promise.all(removePromises),
			timeoutPromise.promise
		]);
		clearTimeout(timer);

		this.logger.info(
			`Pool update summary: ${poolsToAdd.size} added, ` +
			`${poolsToReconfig.size} reconfigured, ` +
			`${completedShutdowns}/${poolsToRemove.size} completed shutdown`
		);
	}

	/**
	 * Validate uid/gid configuration
	 */
	validatePrivilegeConfiguration () {
		const isRoot = Deno.uid() === 0;
		const uid = this.configuration.config.uid;
		const gid = this.configuration.config.gid;

		if (isRoot) {
			if (!uid || !gid) {
				const message = 'Fatal: uid and gid must be configured when running as root. Service processes require privilege dropping for security.';
				this.logger.error(message);
				throw new Error(message);
			}
			this.logger.info(`Privilege dropping configured: uid=${uid}, gid=${gid}`);
		} else {
			if (uid || gid) {
				this.logger.warn(`Warning: uid/gid configuration present (uid=${uid}, gid=${gid}), but will not be set (operator is not running as root).`);
			}
		}
	}
}
