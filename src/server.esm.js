/**
 * JavaScript Multi-Applet Web Server (JSMAWS)
 * Main server entry point
 *
 * This server provides:
 * - HTTP to HTTPS redirect (with ACME challenge bypass)
 * - HTTPS request handling
 * - Static file serving
 * - JavaScript applet execution (internal workers and external subprocesses)
 * - WebSocket support
 */

import { NANOS, parseSLID } from './vendor.esm.js';
import { createSSLManager } from './ssl-manager.esm.js';
import { Router } from './router.esm.js';
import { createConfigMonitor } from './config-monitor.esm.js';

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
		this.acmeChallengeDir = options.acmeChallengeDir || '/var/www/acme-challenge';
		this.noSSL = options.noSSL || false;
		this.sslCheckIntervalHours = options.sslCheckIntervalHours || 1;
	}

	/**
	 * Create ServerConfig from a NANOS configuration object
	 * @param {NANOS} config NANOS configuration object from SLID file
	 * @returns {ServerConfig}
	 */
	static fromNANOS (config) {
		return new ServerConfig({
			httpPort: config.at('httpPort', DEFAULT_HTTP_PORT),
			httpsPort: config.at('httpsPort', DEFAULT_HTTPS_PORT),
			certFile: config.at('certFile'),
			keyFile: config.at('keyFile'),
			hostname: config.at('hostname', 'localhost'),
			acmeChallengeDir: config.at('acmeChallengeDir', '/var/www/acme-challenge'),
			noSSL: config.at('noSSL', false),
			sslCheckIntervalHours: config.at('sslCheckIntervalHours', 1),
		});
	}
}

/**
 * Main server class
 */
class JsmawsServer {
	constructor (config, configPath = DEFAULT_CONFIG_FILE) {
		this.config = config;
		this.configPath = configPath;
		this.httpServer = null;
		this.httpsServer = null;
		this.sslManager = null;
		this.router = null;
		this.configMonitor = null;
		this.isShuttingDown = false;
		this.isReloading = false;
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
				console.log(`HTTP server listening on http://${hostname}:${port}`);
			},
		}, handler);

		console.log(`HTTP server started on port ${this.config.httpPort}`);
	}

	/**
	 * Start the HTTPS server (for secure requests)
	 */
	async startHttpsServer () {
		if (this.config.noSSL) {
			console.log('HTTPS server disabled (noSSL mode)');
			return;
		}

		if (!this.config.certFile || !this.config.keyFile) {
			const message = 'SSL certificates not configured (use noSSL mode for http-only operation)';
			console.error(message);
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
					console.log(`HTTPS server listening on https://${hostname}:${port}`);
				},
			}, handler);

			console.log(`HTTPS server started on port ${this.config.httpsPort}`);
		} catch (error) {
			console.error('Failed to start HTTPS server:', error.message);
			if (!this.config.noSSL) {
				throw error;
			}
		}
	}

	/**
	 * Handle HTTP requests (redirects and ACME challenges)
	 */
	async handleHttpRequest (req) {
		const url = new URL(req.url);

		// Check if this is an ACME challenge request
		if (url.pathname.startsWith(ACME_CHALLENGE_PREFIX)) {
			return await this.handleAcmeChallenge(url.pathname);
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
			console.error('ACME challenge failed:', error.message);
			return new Response('Not Found', { status: 404 });
		}
	}

	/**
	 * Initialize router with current configuration
	 */
	initializeRouter () {
		this.router = new Router(this.config);
		console.log(`Router initialized with ${this.router.routes.length} route(s)`);
	}

	/**
	 * Handle configuration update from config monitor
	 */
	async handleConfigUpdate (newConfig) {
		console.log('Configuration updated, reloading router...');
		this.config = newConfig;
		
		if (this.router) {
			this.router.updateConfig(newConfig);
			console.log(`Router updated with ${this.router.routes.length} route(s)`);
		}
	}

	/**
	 * Handle HTTPS requests
	 */
	async handleHttpsRequest (req) {
		const url = new URL(req.url);

		// Use router to find matching route
		if (this.router) {
			const routeMatch = this.router.findRoute(url.pathname, req.method);
			
			if (routeMatch) {
				const { route, match } = routeMatch;
				
				// Handle response codes (redirects, 404, etc.)
				if (route.response) {
					const status = typeof route.response === 'string'
						? parseInt(route.response.split(' ')[0])
						: route.response;
					
					if (route.href) {
						// Redirect response
						return new Response(null, {
							status,
							headers: {
								'Location': route.href,
							},
						});
					}
					
					// Error response
					return new Response(
						JSON.stringify({
							error: `${status} ${route.response}`,
							path: url.pathname,
						}),
						{
							status,
							headers: {
								'Content-Type': 'application/json',
							},
						}
					);
				}
				
				// Route matched - will be handled by appropriate handler in later phases
				return new Response(
					JSON.stringify({
						message: 'Route matched',
						path: url.pathname,
						method: req.method,
						class: route.class,
						app: match.app,
						params: match.params,
						tail: match.tail,
					}),
					{
						status: 200,
						headers: {
							'Content-Type': 'application/json',
						},
					}
				);
			}
		}

		// No route matched - return 404
		return new Response(
			JSON.stringify({
				error: '404 Not Found',
				path: url.pathname,
			}),
			{
				status: 404,
				headers: {
					'Content-Type': 'application/json',
				},
			}
		);
	}

	/**
	 * Reload HTTPS server with updated certificates
	 */
	async reloadHttpsServer () {
		if (this.isReloading) {
			console.warn('Server reload already in progress');
			return;
		}

		this.isReloading = true;
		console.log('Reloading HTTPS server with updated certificates...');

		try {
			// Shutdown existing HTTPS server
			if (this.httpsServer) {
				await this.httpsServer.shutdown();
				console.log('Previous HTTPS server stopped');
			}

			// Start new HTTPS server with updated certificates
			await this.startHttpsServer();
			console.log('HTTPS server reloaded successfully');
		} catch (error) {
			console.error('Failed to reload HTTPS server:', error.message);
			throw error;
		} finally {
			this.isReloading = false;
		}
	}

	/**
	 * Start both HTTP and HTTPS servers
	 */
	async start () {
		console.log('Starting JSMAWS server...');

		// Initialize router with current configuration
		this.initializeRouter();

		// Start HTTP server (always runs for redirects and ACME)
		await this.startHttpServer();

		// Start HTTPS server if certificates are available
		if (!this.config.noSSL && this.config.certFile && this.config.keyFile) {
			await this.startHttpsServer();
		}
		// Code updated required here:
		// Warn if no certificates and noSSL mode is enabled
		// Throw if no certificates and noSSL mode is NOT enabled
		// (It must not be possible to "accidentally" run unsecured;
		// fail fast if there's an issue)

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

		console.log('JSMAWS server started successfully');
	}

	/**
	 * Gracefully shutdown the server
	 */
	async shutdown () {
		if (this.isShuttingDown) {
			return;
		}

		this.isShuttingDown = true;
		console.log('Shutting down JSMAWS server...');

		// Stop configuration monitoring
		if (this.configMonitor) {
			this.configMonitor.stopMonitoring();
		}

		// Stop SSL monitoring
		if (this.sslManager) {
			this.sslManager.stopMonitoring();
		}

		if (this.httpServer) {
			await this.httpServer.shutdown();
			console.log('HTTP server stopped');
		}

		if (this.httpsServer) {
			await this.httpsServer.shutdown();
			console.log('HTTPS server stopped');
		}

		console.log('JSMAWS server shutdown complete');
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

	console.log('Server configuration:');
	console.log(`  HTTP Port: ${config.httpPort}`);
	console.log(`  HTTPS Port: ${config.httpsPort}`);
	console.log(`  Hostname: ${config.hostname}`);
	console.log(`  No SSL Mode: ${config.noSSL}`);
	console.log(`  Cert File: ${config.certFile || '(not configured)'}`);
	console.log(`  Key File: ${config.keyFile || '(not configured)'}`);
	console.log(`  SSL Check Interval: ${config.sslCheckIntervalHours} hour(s)`);
	console.log(`  ACME Challenge Dir: ${config.acmeChallengeDir}`);

	// Create and start server
	const server = new JsmawsServer(config, configFile);

	// Handle shutdown signals
	const shutdownHandler = async () => {
		await server.shutdown();
		Deno.exit(0);
	};

	// Code update needed here:
	// Should also support force-config-reload-and-graceful-restart on SIGHUP
	// Defer until later if too complicated due to need to finish pending requests
	Deno.addSignalListener('SIGINT', shutdownHandler);
	Deno.addSignalListener('SIGTERM', shutdownHandler);

	// Start the server
	await server.start();
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing and module usage
export { JsmawsServer, ServerConfig, loadConfig };