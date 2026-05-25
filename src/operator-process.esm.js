/**
 * JSMAWS Operator Process
 * Main operator class for managing the server
 *
 * This is the privileged operator process that:
 * - Binds to HTTP/HTTPS ports (80, 443)
 * - Manages configuration and SSL certificates
 * - Spawns and manages sub-processes (responders and routers)
 * - Routes requests to appropriate sub-processes via IPC
 * - Never executes user code directly
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { BufferPool } from '@poly-transport/buffer-pool.esm.js';
import { createSSLManager } from './ssl-manager.esm.js';
import { Router } from './router-worker.esm.js';
import { Configuration } from './configuration.esm.js';
import { FileMonitor } from './file-monitor.esm.js';
import { createLogger } from './logger.esm.js';
import { ProcessManager, ProcessType } from './process-manager.esm.js';
import { PoolManager } from './pool-manager.esm.js';
import { RequestContext, RequestState } from './operator-request-state.esm.js';
import { ValueResolver } from './value-resolver.esm.js';
import { OperatorAuthn } from './operator-authn.esm.js';
import { OperatorAuthDelegate } from './operator-auth-delegate.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from './request-channel-pool.esm.js';
import { applyRequestFilter, applyResponseFilter } from './header-filter.esm.js';

const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';

/**
 * Main operator class (privileged process)
 */
export class OperatorProcess {
	static instance = null; // Singleton instance
	#nextRequestId = 0;

	constructor (config, configPath) {
		this.constructor.instance = this;
		// Accept plain object (from JSON.parse), Configuration instance,
		// or null/undefined (config will be set via loadConfigFile() before start()).
		this.config = (config instanceof Configuration) ? config : new Configuration(config ?? {});
		this.configPath = configPath;
		this.httpServer = null;
		this.httpsServer = null;
		this.sslManager = null;
		this.router = null;
		this.configMonitor = null;
		this.processManager = null;
		this.poolManagers = new Map(); // poolName -> PoolManager (responders)
		this.authPoolManager = null;   // Auth sub-process PoolManager (optional)
		this.affinityMap = new Map(); // appPath -> Set<processIds>
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
		// Value resolver for :scheme: references in configuration
		this.valueResolver = new ValueResolver();
		// Operator-resident authn runner (JWT, API key, Basic) with optional auth sub-process delegation
		this.operatorAuthn = new OperatorAuthn();
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
	 * Forward request to responder via PipeTransport using state machine.
	 *
	 * @param {Request} req - HTTP request
	 * @param {Object} route - Matched route object
	 * @param {Object} match - Route match result
	 * @param {string} remote - Remote IP address
	 * @param {Object|null} [identity] - Presented identity (from route-group authn filter evaluation)
	 * @param {Object|null} [requestFilter] - Effective requestFilter spec (route-group or top-level)
	 * @param {Object|null} [responseFilter] - Effective responseFilter spec (route-group or top-level)
	 */
	async forwardToResponder (req, route, match, remote, { identity = null, requestFilter = null, responseFilter = null } = {}) {
		const poolName = route.spec?.pool ?? 'standard';
		const appPath = match.app || route.app;
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
		const poolItem = await poolManager.serialize(async () => await this.getProcessWithAffinity(poolManager, appPath)).catch((error) => {
			this.logger.error(`Sub-process selection error: ${error.message}`);
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
		const requestId = `req-${++this.#nextRequestId}`;
		const context = new RequestContext({
			requestId,
			process,
			poolName,
			routeSpec,
			request: req,
			appPath,
			poolManager,
			poolItemId: poolItem.id,
			reqChannel,
			responseFilter,
		});

		try {
			if (appPath) {
				this.updateAffinity(poolItem, appPath);
			}

			// Read request body — skip for WebSocket upgrade requests.
			// Deno.upgradeWebSocket() requires the original, unread Request object;
			// calling req.arrayBuffer() first locks the body stream and causes the
			// upgrade to fail/be canceled on the client side.
			const isWebSocketUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
			const bodyBytes = (!isWebSocketUpgrade && req.body)
				? await req.arrayBuffer()
				: new ArrayBuffer(0);

			// Convert headers to plain object for JSON serialization, then apply requestFilter
			const rawHeadersObj = Object.fromEntries(req.headers.entries());
			const headersObj = applyRequestFilter(rawHeadersObj, requestFilter);

			const url = new URL(req.url);
			this.logger.debug(`Sending ${requestId} to ${process.id} (usage ${poolItem.usageCount}) for ${req.method} ${url.pathname}`);

			// Store context
			this.requestContexts.set(requestId, context);

			// Start processing req-N channel messages (handles res, res-error, res-frame, bidi-frame, con-*)
			context.processReqChannelMessages(reqChannel);

			// Build request payload (include identity for mod-app consumption)
			const requestPayload = JSON.stringify({
				id: requestId,
				method: req.method,
				url: req.url,
				app: appPath,
				root,
				pool: poolName,
				headers: headersObj,
				body: bodyBytes.byteLength > 0 ? Array.from(new Uint8Array(bodyBytes)) : null,
				remote,
				routeParams: match.params || {},
				routeTail: match.tail || '',
				routeSpec: route.spec || null,
				identity: identity ?? null,
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
				JSON.stringify({ error: '502 Bad Gateway', message: 'Sub-process error' }),
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
	async getProcessWithAffinity (poolManager, appPath) {
		const affinitySet = appPath && this.affinityMap.get(appPath);
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
	 * Handle configuration update from file monitor (or initial load).
	 * Resolves value references, updates Configuration, and propagates changes
	 * to the router, responder pools, and sub-processes (if initialized).
	 *
	 * Safe to call before the logger is initialized (uses console fallback).
	 *
	 * @param {Object} newConfig - New configuration (plain object)
	 */
	async handleConfigUpdate (newConfig) {
		(this.logger ?? console).info('Configuration updated; reloading...');

		// Resolve value references before updating Configuration.
		// resolveConfig() injects configDir and calls valueResolver.resolveObject().
		const resolvedConfig = await this.resolveConfig(newConfig);

		// Update Configuration instance with the already-resolved plain object.
		// The pools getter handles the default-pool fallback automatically.
		this.config.updateConfig(resolvedConfig);

		// Invalidate authn cache on config reload (authn config may have changed)
		if (this.operatorAuthn) {
			this.operatorAuthn.clearCache();
		}

		// Update router configuration (no-op if router not yet initialized)
		if (this.router) {
			this.router.updateConfig();
			this.logger.debug(`Router updated with ${this.router.routes.length} route(s)`);
		}

		// Update responder pools, auth pool, and broadcast config to sub-processes in parallel.
		// These are independent of each other and can run concurrently.
		const updateTasks = [];
		if (this.poolManagers.size > 0) {
			updateTasks.push(this.updateResponderPools());
		}
		if (this.processManager) {
			updateTasks.push(this.updateAuthPool());
			updateTasks.push(this.processManager.broadcastConfigUpdate());
		}
		if (updateTasks.length > 0) {
			await Promise.all(updateTasks);
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
				// Run top-level authn before routing (per auth-revisions-20260510.md 2026-05-11-A).
				// The authn result (identity + provider) is passed to the router so that
				// route-group scalar authn filters can be evaluated during route matching.
				const headersObj = Object.fromEntries(req.headers.entries());
				const authnResult = await this.operatorAuthn.runAuthn({
					method: req.method,
					url: req.url,
					headers: headersObj,
					topLevelAuthn: this.config.authn,
				});

				if (!authnResult.allow) {
					// Authn denied — return denial response without routing
					const denyStatus = authnResult.denyStatus ?? 401;
					const denyMessage = authnResult.denyMessage ?? 'Unauthorized';
					const body = JSON.stringify({ error: denyMessage });
					const duration = (Date.now() - startTime) / 1000;
					this.logger.logRequest(req.method, url.pathname, denyStatus, body.length, duration, remote);
					this.logger.warn(`[authn] Denied ${req.method} ${url.pathname}: ${denyMessage}`);
					return new Response(body, {
						status: denyStatus,
						headers: { 'content-type': 'application/json' },
					});
				}

				// Build authState for the router (used for route-group authn filter evaluation)
				const authState = {
					identity: authnResult.identity ?? null,
					provider: authnResult.provider ?? null,
				};

				// Pass hostname for hostRoutes (SNI) support; pass authState for route-group authn
				const hostname = url.hostname;
				const routeMatch = await this.router.findRoute(url.pathname, req.method, hostname, authState);

				if (routeMatch) {
					const { route, match, routeGroup, presentedIdentity } = routeMatch;

					// Handle response codes (redirects, 404, etc.)
						if (route.response) {
							const status = typeof route.response === 'string'
								? parseInt(route.response.split(' ')[0])
								: route.response;

							if (route.href) {
								const duration = (Date.now() - startTime) / 1000;
								this.logger.logRequest(req.method, url.pathname, status, 0, duration, remote);

								// Build redirect response headers (include any route-level headers)
								const redirectHeaders = { 'Location': route.href };
								if (route.headers && typeof route.headers === 'object') {
									for (const [name, value] of Object.entries(route.headers)) {
										redirectHeaders[name] = String(value);
									}
								}

								return new Response(null, {
									status,
									headers: redirectHeaders,
								});
							}

							// Non-redirect response route: use responseText if provided, else JSON error body
							let body;
							let contentType;
							if (route.responseText != null) {
								// Use configured plain-text body (e.g. "Unauthorized")
								body = route.responseText;
								contentType = 'text/plain';
							} else {
								// Default JSON error body
								body = JSON.stringify({
									error: `${status} ${route.response}`,
									path: url.pathname,
								});
								contentType = 'application/json';
							}

							// Build response headers (include any route-level headers)
							const responseHeaders = { 'content-type': contentType };
							if (route.headers && typeof route.headers === 'object') {
								for (const [name, value] of Object.entries(route.headers)) {
									responseHeaders[name] = String(value);
								}
							}

							const duration = (Date.now() - startTime) / 1000;
							this.logger.logRequest(req.method, url.pathname, status, body.length, duration, remote);

							return new Response(body, {
								status,
								headers: responseHeaders,
							});
						}

					// Determine effective requestFilter and responseFilter.
					// Route-group level overrides top-level (per auth-revisions-20260510.md).
					const requestFilter = (routeGroup?.requestFilter != null)
						? routeGroup.requestFilter
						: (this.config.config.requestFilter ?? null);
					const responseFilter = (routeGroup?.responseFilter != null)
						? routeGroup.responseFilter
						: (this.config.config.responseFilter ?? null);

					// Route matched - forward to sub-process with presented identity and filters
					// presentedIdentity is the identity after route-group authn filter evaluation
					// (may be null if suppressed by @allow-all, or the original identity if presented)
					const response = await this.forwardToResponder(req, route, match, remote, {
						identity: presentedIdentity ?? null,
						requestFilter,
						responseFilter,
					});

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
	 * Initialize the auth sub-process pool (if authPool is configured).
	 * Creates a PoolManager for auth processes and sets up the auth delegate
	 * on the operatorAuthn instance.
	 *
	 * The auth pool is optional. When not configured, authn runs inline in the
	 * operator (operator-resident providers only, or inline fallback for external ones).
	 */
	async initializeAuthPool () {
		const authPoolConfig = this.config.config.authPool;
		if (!authPoolConfig) {
			this.logger.debug('No authPool configured; auth sub-process disabled');
			return;
		}

		this.logger.info('Initializing auth sub-process pool');

		const itemFactory = async (itemId) => {
			return await this.processManager.createProcess(
				itemId,
				ProcessType.AUTH,
				'@auth',
				authPoolConfig
			);
		};

		this.authPoolManager = new PoolManager('@auth', authPoolConfig, itemFactory, this.logger);
		await this.authPoolManager.initialize();

		// Wire up the auth delegate so OperatorAuthn can delegate external providers
		const authDelegate = new OperatorAuthDelegate(this.authPoolManager, this.logger);
		this.operatorAuthn.setAuthDelegate(authDelegate);

		this.logger.debug('Auth sub-process pool initialized');
	}

	/**
	 * Initialize logger
	 */
	initializeLogger () {
		const loggingConfig = this.config.logging;
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
		this.processManager = new ProcessManager(this.config, this.logger);
	}

	/**
	 * Initialize responder pools
	 */
	async initializeResponderPools () {
		// config.pools always returns the effective pools (defaults applied by updateConfig).
		// An explicitly empty pools object ({}) is respected as-is (no pools configured).
		const poolsConfig = this.config.pools;

		// Create PoolManager for each pool
		for (const [poolName, poolConfig] of Object.entries(poolsConfig)) {
			if (poolName === '@router') {
				const fsRouting = this.config.routing.fsRouting;
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
		this.router = new Router(this.config);
		this.logger.debug(`Router initialized with ${this.router.routes.length} route(s)`);
	}

	/**
	 * Load configuration from a file path, resolve value references, and apply it.
	 * Used for initial boot, file-watch reloads, and SIGHUP reloads — all the same path.
	 * No-op if filePath is not provided.
	 *
	 * @param {string} filePath Path to the SLID config file
	 * @returns {Promise<void>}
	 */
	async loadConfigFile (filePath) {
		if (!filePath) {
			(this.logger ?? console).warn('loadConfigFile() called with no filePath; skipping');
			return;
		}
		const config = await Configuration.fromFile(filePath);
		await this.handleConfigUpdate(config.config);
	}

	/**
	 * Register the SIGHUP signal handler for graceful config reload.
	 * Exposed as a method so tests can register it without going through main().
	 * The handler logs at INFO level and calls loadConfigFile().
	 */
	registerSighupHandler () {
		Deno.addSignalListener('SIGHUP', async () => {
			this.logger.info('SIGHUP received; reloading configuration...');
			try {
				await this.loadConfigFile(this.configPath);
				this.logger.info('Configuration reloaded successfully (SIGHUP)');
			} catch (error) {
				this.logger.error(`Failed to reload configuration on SIGHUP: ${error.message}`);
			}
		});
	}

	/**
	 * Register the SIGTERM signal handler for graceful shutdown.
	 * Exposed as a method so tests can register it without going through main().
	 * The handler logs at INFO level, calls shutdown() with configured delay and spread,
	 * and exits with code 0.
	 */
	registerSigtermHandler () {
		Deno.addSignalListener('SIGTERM', async () => {
			this.logger.info('SIGTERM received; initiating graceful shutdown...');
			await this.shutdown();
			Deno.exit(0);
		});
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
	 * Resolve value references in a raw configuration object.
	 * Injects configDir for the :file: scheme and calls valueResolver.resolveObject().
	 *
	 * @param {Object} rawConfig - Raw plain-object configuration
	 * @returns {Promise<Object>} Resolved plain-object configuration
	 */
	async resolveConfig (rawConfig) {
		// Derive configDir from configPath for :file: relative path resolution.
		// Use URL to handle both absolute and relative configPath values consistently.
		const configDir = this.configPath
			? new URL('.', new URL(this.configPath, `file://${Deno.cwd()}/`)).pathname.replace(/\/$/, '')
			: Deno.cwd();

		const rawWithDir = { ...(rawConfig ?? {}), configDir };
		return await this.valueResolver.resolveObject(rawWithDir, rawWithDir);
	}

	/**
	 * Gracefully shutdown the operator process.
	 *
	 * @param {number|null} stopTime - Shutdown timeout in seconds (default: config.shutdownDelay)
	 * @param {number|null} spread - Spread in seconds (default: config.shutdownSpread, already normalized)
	 */
	async shutdown (stopTime = null, spread = null) {
		if (this.isShuttingDown) {
			return;
		}
		this.isShuttingDown = true;

		// Use normalized config getters (shutdownSpread is already in seconds)
		stopTime ??= this.config.shutdownDelay;
		spread ??= this.config.shutdownSpread;
		this.logger.info(`Shutting down JSMAWS operator process (${stopTime}s, spread=${spread}s)...`);

		// Compute absolute deadline (ms since epoch) for next layer.
		// Sub-processes receive subDeadline = now + (stopTime - spread) * 1000.
		const subDeadline = Date.now() + (stopTime - spread) * 1000;

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
				tasks.push(poolManager.shutdown(subDeadline, spread));
			}
		}

		if (this.authPoolManager) {
			this.logger.info('Shutting down auth pool');
			tasks.push(this.authPoolManager.shutdown(subDeadline, spread));
		}

		if (this.processManager) {
			tasks.push(this.processManager.shutdown(subDeadline, spread));
		}

		if (tasks.length) {
			const wrapUpPromise = Promise.withResolvers();
			wrapUpPromise.promise.then((completed) => {
				if (!completed) this.logger.info('Operator shutdown timed out');
			});
			// Operator waits until its own deadline (stopTime from now, not reduced by spread)
			const deadline = Date.now() + stopTime * 1000;
			const remainingMs = Math.max(0, deadline - Date.now());
			const wrapUpTimer = setTimeout(wrapUpPromise.resolve, remainingMs);
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
		await Promise.all([
			this.initializeResponderPools(),
			this.initializeAuthPool(),
		]);
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
			this.configMonitor = new FileMonitor(
				this.configPath,
				(filePath) => this.loadConfigFile(filePath)
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
		const intervalSeconds = this.config.config.healthCheckInterval ?? 60;

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
	updateAffinity (item, appPath) {
		if (!appPath) return;

		if (!this.affinityMap.has(appPath)) {
			this.affinityMap.set(appPath, new Set());
		}
		const appMap = this.affinityMap.get(appPath);
		if (!appMap.has(item.id)) {
			appMap.add(item.id);
			//console.debug(`Adding affinity ${item.id} for ${appPath}`);
			item.onShutdown(() => {
				//console.debug(`Removing affinity ${item.id} for ${appPath}`);
				appMap.delete(item.id);
			});
		}
	}

	/**
	 * Update the auth sub-process pool based on new configuration.
	 * - If authPool was not configured and is now configured → initialize it.
	 * - If authPool was configured and is still configured → reconfigure it.
	 * - If authPool was configured and is now removed → shut it down and clear the delegate.
	 * No-op if processManager is not yet initialized.
	 */
	async updateAuthPool () {
		const authPoolConfig = this.config.config.authPool;

		if (!authPoolConfig) {
			// authPool removed from config — shut down if running
			if (this.authPoolManager) {
				this.logger.info('authPool removed from config; shutting down auth pool');
				// Config reload: pass unreduced process deadline + spread for workers
				const stopTime = this.config.shutdownDelay;
				const spread = this.config.shutdownSpread;
				const deadline = Date.now() + stopTime * 1000;
				await this.authPoolManager.shutdown(deadline, spread);
				this.authPoolManager = null;
				this.operatorAuthn.setAuthDelegate(null);
			}
			return;
		}

		if (!this.authPoolManager) {
			// authPool newly added to config — initialize it
			await this.initializeAuthPool();
		} else {
			// authPool already running — reconfigure it
			try {
				this.authPoolManager.updateConfig(authPoolConfig);
				this.logger.debug('Auth pool reconfigured');
			} catch (error) {
				this.logger.error(`Failed to reconfigure auth pool: ${error.message}`);
			}
		}
	}

	/**
	 * Update responder pools based on new configuration
	 */
	async updateResponderPools () {
		this.logger.info('Updating responder pools');
		const newPoolsConfig = this.config.pools;

		// Config reload: pass unreduced process deadline + spread for workers
		const stopTime = this.config.shutdownDelay;
		const spread = this.config.shutdownSpread;
		const deadline = Date.now() + stopTime * 1000;
		const newPoolNames = new Set(Object.keys(newPoolsConfig));
		const oldPoolNames = new Set(this.poolManagers.keys());

		// Identify pools to remove, reconfigure, and add
		const poolsToRemove = new Set();
		const poolsToReconfig = new Set();
		const poolsToAdd = new Set();

		for (const poolName of oldPoolNames) {
			// FIX LATER (needs to be noted in memory bank): bad design - the router is not a responder; it should use routerPool (like auth uses authPool)
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
						await poolManager.shutdown(deadline, spread);
						this.poolManagers.delete(poolName);
						++completedShutdowns;
					} catch (error) {
						this.logger.error(`Error shutting down pool '${poolName}': ${error.message}`);
					}
				})();

				removePromises.push(removePromise);
			}
		}

		// Wait for shutdowns until the deadline
		const shutdownTimeout = Math.max(0, deadline - Date.now());
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
		const uid = this.config.config.uid;
		const gid = this.config.config.gid;

		if (isRoot) {
			if (!uid || !gid) {
				const message = 'Fatal: uid and gid must be configured when running as root. Sub-processes require privilege dropping for security.';
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
