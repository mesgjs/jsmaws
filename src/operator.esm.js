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
import {
	createRequest,
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
	try {
		const configText = await Deno.readTextFile(configPath);
		const config = parseSLID(configText);
		return config;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			console.warn(`Configuration file not found: ${configPath}`);
			return new NANOS();
		}
		throw error;
	}
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
		return new ServerConfig(Object.fromEntries(config.entries()));
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
		this.logger = null;
		this.isShuttingDown = false;
		this.isReloading = false;
		this.pendingRequests = new Map(); // requestId -> {resolve, reject, timeout, controller, writer}
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

		this.logger.info(`HTTP server started on port ${this.config.httpPort}`);
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

			this.logger.info(`HTTPS server started on port ${this.config.httpsPort}`);
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
		this.logger.info(`Router initialized with ${this.router.routes.length} route(s)`);
	}

	/**
	 * Handle configuration update from config monitor
	 */
	async handleConfigUpdate (newConfig) {
		this.logger.info('Configuration updated; reloading...');
		this.configData = newConfig;

		// Update server config
		this.config = ServerConfig.fromNANOS(newConfig);

		// Update router configuration
		if (this.configuration && this.router) {
			this.configuration.updateConfig(newConfig);
			this.router.updateConfig();
			this.logger.info(`Router updated with ${this.router.routes.length} route(s)`);
		}

		// Send config update to all service processes
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
	 * Handle HTTPS requests
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
	 * Forward request to service process via IPC
	 */
	async forwardToServiceProcess (req, route, match, remote) {
		// Determine pool name from route (default to 'standard')
		const poolName = route.spec.at('pool', 'standard');
		const appletPath = match.app || route.app;

		// Find best process for this request
		const process = this.processManager.findProcessForRequest(poolName, appletPath);

		if (!process) {
			this.logger.warn(`No available process in pool ${poolName}`);
			return new Response(
				JSON.stringify({ error: '503 Service Unavailable', message: 'No available workers' }),
				{
					status: 503,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}

		// Read request body
		const bodyBytes = req.body ? await req.arrayBuffer() : new ArrayBuffer(0);
		const bodySize = bodyBytes.byteLength;

		// Convert headers to NANOS format
		const headersNanos = new NANOS();
		for (const [key, value] of req.headers.entries()) {
			headersNanos.set(key, value);
		}

		// Create IPC request message
		const requestMsg = createRequest(
			req.method,
			new URL(req.url).pathname,
			appletPath,
			poolName,
			headersNanos,
			bodySize,
			remote,
			match.params || {},
			match.tail || ''
		);

		// Send request to process
		try {
			await process.ipcConn.writeMessage(requestMsg, new Uint8Array(bodyBytes));

			// Update affinity
			if (appletPath) {
				this.processManager.updateAffinity(process.id, appletPath);
			}

			// Wait for initial response
			const { message, binaryData } = await process.ipcConn.readMessage();

			// Update process capacity from response
			process.updateCapacity(
				message.fields.at('availableWorkers', 0),
				message.fields.at('totalWorkers', 0),
				message.fields.at('requestsQueued', 0)
			);

			// Handle different message types
			switch (message.type) {
				case MessageType.WEB_RESPONSE:
					return await this.handleWebResponse(message, binaryData);
					
				case MessageType.WEB_CHUNK:
					return await this.handleChunkedResponse(message.id, message, binaryData, process);
					
				case MessageType.WEB_STREAM:
					return await this.handleStreamingResponse(message.id, message, binaryData, process);
					
				case MessageType.WS_UPGRADE:
					return await this.handleWebSocketUpgrade(message.id, message, process, req);
					
				default:
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
		}
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
	 * Handle regular web response
	 */
	async handleWebResponse (message, binaryData) {
		// Convert response headers from NANOS to Headers
		const responseHeaders = this.convertHeaders(message.fields.at('headers'));

		// Create HTTP response
		return new Response(binaryData, {
			status: message.fields.at('status', 200),
			headers: responseHeaders,
		});
	}

	/**
	 * Handle chunked response (large files, etc.)
	 */
	async handleChunkedResponse (requestId, initialMessage, initialData, process) {
		// Convert response headers
		const responseHeaders = this.convertHeaders(initialMessage.fields.at('headers'));

		// Create readable stream for chunked response
		const stream = new ReadableStream({
			start: async (controller) => {
				try {
					// Send initial chunk if present
					if (initialData && initialData.length > 0) {
						controller.enqueue(initialData);
					}

					// Check if this was the final chunk
					if (initialMessage.fields.at('final', false)) {
						controller.close();
						return;
					}

					// Read subsequent chunks
					while (true) {
						const { message, binaryData } = await process.ipcConn.readMessage();

						if (message.type !== MessageType.WEB_CHUNK) {
							throw new Error(`Expected WEB_CHUNK, got ${message.type}`);
						}

						// Send chunk data
						if (binaryData && binaryData.length > 0) {
							controller.enqueue(binaryData);
						}

						// Check if final chunk
						if (message.fields.at('final', false)) {
							controller.close();
							break;
						}
					}
				} catch (error) {
					controller.error(error);
				}
			},
		});

		return new Response(stream, {
			status: initialMessage.fields.at('status', 200),
			headers: responseHeaders,
		});
	}

	/**
	 * Handle streaming response (SSE, etc.)
	 */
	async handleStreamingResponse (requestId, initialMessage, initialData, process) {
		// Convert response headers
		const responseHeaders = this.convertHeaders(initialMessage.fields.at('headers'));

		// Create readable stream for streaming response
		const stream = new ReadableStream({
			start: async (controller) => {
				try {
					// Send initial data if present
					if (initialData && initialData.length > 0) {
						controller.enqueue(initialData);
					}

					// Read subsequent stream data
					while (true) {
						const { message, binaryData } = await process.ipcConn.readMessage();

						if (message.type === MessageType.WEB_STREAM) {
							// Send stream data
							if (binaryData && binaryData.length > 0) {
								controller.enqueue(binaryData);
							}
						} else if (message.type === MessageType.WEB_STREAM_CLOSE) {
							// Stream closed
							controller.close();
							break;
						} else {
							throw new Error(`Expected WEB_STREAM or WEB_STREAM_CLOSE, got ${message.type}`);
						}
					}
				} catch (error) {
					controller.error(error);
				}
			},
		});

		return new Response(stream, {
			status: initialMessage.fields.at('status', 200),
			headers: responseHeaders,
		});
	}

	/**
	 * Handle WebSocket upgrade
	 */
	async handleWebSocketUpgrade (requestId, message, process, req) {
		// WebSocket upgrade handling would require Deno.upgradeWebSocket
		// This is a placeholder for the full implementation
		this.logger.warn('WebSocket upgrade not yet fully implemented');
		
		return new Response('WebSocket upgrade not yet implemented', {
			status: 501,
			headers: { 'Content-Type': 'text/plain' },
		});
	}

	/**
	 * Initialize service process pools
	 */
	async initializeProcessPools () {
		const poolsConfig = this.configData.at('pools');
		if (!poolsConfig || !(poolsConfig instanceof NANOS)) {
			this.logger.warn('No pools configured, using defaults');
			return;
		}

		// Spawn initial processes for each pool
		for (const [poolName, poolConfig] of poolsConfig.entries()) {
			if (poolName === '@router') {
				// Router pool - only spawn if fsRouting is enabled
				const fsRouting = this.configData.at('fsRouting', false);
				if (fsRouting) {
					const minProcs = poolConfig.at('minProcs', 1);
					this.logger.info(`Initializing router pool with ${minProcs} process(es)`);

					for (let i = 0; i < minProcs; i++) {
						await this.processManager.spawnProcess(ProcessType.ROUTER, poolName, poolConfig);
					}
				}
			} else {
				// Responder pool
				const minProcs = poolConfig.at('minProcs', 1);
				this.logger.info(`Initializing pool '${poolName}' with ${minProcs} process(es)`);

				for (let i = 0; i < minProcs; i++) {
					await this.processManager.spawnProcess(ProcessType.RESPONDER, poolName, poolConfig);
				}
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

		// Shutdown service processes
		if (this.processManager) {
			await this.processManager.shutdown();
		}

		// Shutdown HTTP server
		if (this.httpServer) {
			await this.httpServer.shutdown();
			this.logger.info('HTTP server stopped');
		}

		// Shutdown HTTPS server
		if (this.httpsServer) {
			await this.httpsServer.shutdown();
			this.logger.info('HTTPS server stopped');
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
	console.log(`  No SSL Mode: ${config.noSSL}`);
	console.log(`  Cert File: ${config.certFile || '(not configured)'}`);
	console.log(`  Key File: ${config.keyFile || '(not configured)'}`);
	console.log(`  SSL Check Interval: ${config.sslCheckIntervalHours} hour(s)`);
	console.log(`  ACME Challenge Dir: ${config.acmeChallengeDir || '(not configured'}`);

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
