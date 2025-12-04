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
import {
	RequestContext,
	createRequestHandler,
	cleanupRequestContext,
} from './operator-request-state.esm.js';

const DEFAULT_HTTP_PORT = 80;
const DEFAULT_HTTPS_PORT = 443;
const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';

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
export class ServerConfig {
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
export class OperatorProcess {
	constructor (config, configPath) {
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
		this.requestContexts = new Map(); // requestId -> RequestContext
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

		// Update process pools
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
			const newPoolConfig = newPoolsConfig.at(poolName);

			try {
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
					const configObj = poolConfig instanceof NANOS ? poolConfig.toObject() : poolConfig;

					const itemFactory = async (itemId) => {
						return await this.processManager.createProcess(
							itemId,
							ProcessType.RESPONDER,
							poolName,
							poolConfig
						);
					};

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

						// Clean up affinity map entries
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
							headers: { 'Content-Type': 'application/json' },
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
				headers: { 'Content-Type': 'application/json' },
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
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	/**
	 * Forward request to service process via IPC using state machine
	 */
	async forwardToServiceProcess (req, route, match, remote) {
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

		// Get available process from pool
		const poolItem = await this.getProcessWithAffinity(poolManager, appletPath);

		if (!poolItem) {
			this.logger.warn(`No available process in pool ${poolName}`);
			return new Response(
				JSON.stringify({ error: '503 Service Unavailable', message: 'No available workers' }),
				{ status: 503, headers: { 'Content-Type': 'application/json' } }
			);
		}

		const process = poolItem.item;
		poolManager.markItemBusy(poolItem.id);

		const routeSpec = route.spec || null;

		try {
			if (appletPath) {
				this.updateAffinity(poolItem.id, appletPath);
			}

			// Read request body
			const bodyBytes = req.body ? await req.arrayBuffer() : new ArrayBuffer(0);
			const bodySize = bodyBytes.byteLength;

			// Convert headers to NANOS format
			const headersNanos = new NANOS().fromEntries(req.headers.entries());

			// Create IPC request message
			const requestMsg = createRequest({
				method: req.method,
				url: req.url,
				app: appletPath,
				pool: poolName,
				headers: headersNanos,
				bodySize,
				remote,
				routeParams: match.params || {},
				routeTail: match.tail || '',
				routeSpec: route.spec || null,
			});

			const requestId = requestMsg.at('id');
			
			const url = new URL(req.url);
			this.logger.debug(`Sending WEB_REQUEST to ${process.id} for ${req.method} ${url.pathname}`);

			// Get timeout configuration
			const timeouts = this.configuration.getTimeoutConfig(poolName, routeSpec);
			const reqTimeout = timeouts.reqTimeout * 1000;

			// Create context with initial state
			const context = new RequestContext(
				requestId,
				process,
				poolName,
				routeSpec,
				req
			);
			
			// Store context
			this.requestContexts.set(requestId, context);
			
			// Register SINGLE handler (never cleared until completion)
			process.ipcConn.setRequestHandler(
				requestId,
				createRequestHandler(context, this),
				reqTimeout
			);

			// Send request
			await process.ipcConn.writeMessage(requestMsg, new Uint8Array(bodyBytes));

			// Return Response promise that will be resolved by state machine
			return await context.responsePromise.promise;
			
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
			await poolManager.markItemIdle(poolItem.id);
		}
	}

	/**
	 * Get process with affinity preference
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
	 * Cleanup completed request context
	 */
	cleanupRequestContext (requestId) {
		cleanupRequestContext(requestId, this.requestContexts, this.logger);
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

		// Forward to responder process via IPC
		const frameMsg = createFrame(requestId, {
			data: frameData,
			final: false
		});
		await connState.process.ipcConn.writeMessage(frameMsg, frameData);

		// Implicit credit grant
		connState.inboundCredits = Math.min(
			connState.inboundCredits + chunkSize,
			connState.maxCredits
		);

		// Update activity timestamp
		connState.lastActivity = Date.now();
	}

	/**
	 * Initialize service process pools
	 */
	async initializeProcessPools () {
		let poolsConfig = this.configData.at('pools');
		if (!poolsConfig || !(poolsConfig instanceof NANOS)) {
			this.logger.warn('No pools configured, using defaults');
			poolsConfig = getDefaultPoolsConfig();
			this.configData.set('pools', poolsConfig);
		}

		// Create PoolManager for each pool
		for (const [poolName, poolConfig] of poolsConfig.entries()) {
			if (poolName === '@router') {
				const fsRouting = this.configData.at('fsRouting', false);
				if (fsRouting) {
					this.logger.info(`Initializing router pool '${poolName}' (filesystem routing)`);
				}
			} else {
				this.logger.info(`Initializing pool '${poolName}' with PoolManager`);

				const configObj = poolConfig instanceof NANOS ? poolConfig.toObject() : poolConfig;

				const itemFactory = async (itemId) => {
					return await this.processManager.createProcess(
						itemId,
						ProcessType.RESPONDER,
						poolName,
						poolConfig
					);
				};

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
	 * Validate uid/gid configuration
	 */
	validatePrivilegeConfiguration () {
		const isRoot = Deno.uid() === 0;
		const uid = this.configData.at('uid');
		const gid = this.configData.at('gid');

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

		this.configMonitor = createConfigMonitor(
			this.configPath,
			(newConfig) => this.handleConfigUpdate(newConfig)
		);
		await this.configMonitor.startMonitoring();

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

		const tasks = [];

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
			const timeout = new Promise((resolve) => setTimeout(resolve, (stopTime + 5) * 1000));
			await Promise.race([Promise.all(tasks), timeout]);
		}

		if (this.logger) {
			await this.logger.close();
		}

		this.logger.info('JSMAWS operator process shutdown complete');
	}
}
