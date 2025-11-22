/**
 * JSMAWS Router Process
 * Semi-privileged service process for filesystem-based route resolution
 * 
 * This process:
 * - Runs with reduced privileges (read-only filesystem access, non-root uid/gid)
 * - Hosts router workers for route resolution (managed by pool-manager)
 * - Receives route requests from operator via IPC
 * - Sends route responses back to operator via IPC
 * - Only spawned when fsRouting is enabled in configuration
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';
import {
	IPCConnection,
	MessageType,
	createRouteResponse,
	validateMessage,
} from './ipc-protocol.esm.js';
import { PoolManager } from './pool-manager.esm.js';
import { RouterWorker } from './router-worker-manager.esm.js';

/**
 * Router process class
 * Hosts router workers in a pool for filesystem-based route resolution
 */
class RouterProcess {
	constructor (processId) {
		this.processId = processId || Deno.env.get('JSMAWS_PID') || `router-${Date.now()}`;
		this.config = new NANOS();
		this.ipcConn = null;
		this.isShuttingDown = false;
		this.fsRouting = false;
		this.poolManager = null;
		this.workerUrl = new URL('./router-worker.esm.js', import.meta.url).href;
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
		const fsRouting = fields.at('fsRouting', false);

		// Update configuration
		if (pools) this.config.set('pools', pools);
		if (mimeTypes) this.config.set('mimeTypes', mimeTypes);
		if (routes) this.config.set('routes', routes);
		this.config.set('fsRouting', fsRouting);
		this.fsRouting = fsRouting === true;

		// Update pool manager if already initialized
		if (this.poolManager) {
			// Get router pool config
			const routerPoolConfig = pools?.at('@router') || {};
			await this.poolManager.updateConfig(routerPoolConfig);

			// Update all workers with new configuration
			for (const item of this.poolManager.items.values()) {
				if (item.item instanceof RouterWorker) {
					await item.item.updateConfig(this.config, this.fsRouting);
				}
			}
		}

		console.log(`[${this.processId}] Configuration updated (fsRouting: ${this.fsRouting})`);
	}

	/**
	 * Handle route request from operator
	 */
	async handleRouteRequest (id, fields) {
		try {
			// Validate required fields
			validateMessage({ fields }, ['method', 'path']);

			const method = fields.at('method');
			const path = fields.at('path');

			console.log(`[${this.processId}] Route request: ${method.toUpperCase()} ${path}`);

			// Get available worker from pool
			const poolItem = await this.poolManager.getAvailableItem();

			if (!poolItem) {
				console.warn(`[${this.processId}] No available workers, returning 503`);
				const response = createRouteResponse(id, '', '', {}, '', 503);
				await this.ipcConn.writeMessage(response);
				return;
			}

			try {
				// Mark worker as busy
				this.poolManager.markItemBusy(poolItem.id);

				// Find route using worker
				const routeMatch = await poolItem.item.findRoute(path, method);

				// Mark worker as idle
				await this.poolManager.markItemIdle(poolItem.id);

				// Send route response
				if (routeMatch) {
					const response = createRouteResponse(
						id,
						routeMatch.pool || 'standard',
						routeMatch.app || '',
						routeMatch.params || {},
						routeMatch.tail || '',
						200
					);
					await this.ipcConn.writeMessage(response);
				} else {
					const response = createRouteResponse(id, '', '', {}, '', 404);
					await this.ipcConn.writeMessage(response);
				}
			} catch (workerError) {
				// Mark worker as idle on error
				await this.poolManager.markItemIdle(poolItem.id);
				throw workerError;
			}
		} catch (error) {
			console.error(`[${this.processId}] Route request error:`, error);

			// Send error response
			const response = createRouteResponse(id, '', '', {}, '', 500);
			await this.ipcConn.writeMessage(response);
		}
	}

	/**
	 * Handle health check from operator
	 */
	async handleHealthCheck (id, fields) {
		console.log(`[${this.processId}] Health check received`);

		// Get worker stats from pool manager
		const metrics = this.poolManager.getMetrics();

		// Create health check response
		const response = new NANOS(MessageType.HEALTH_CHECK, { id });
		response.setOpts({ transform: true });
		response.push([{
			timestamp: fields.at('timestamp'),
			status: 'ok',
			workersAvailable: metrics.availableItems,
			workersTotal: metrics.totalItems,
			requestsQueued: metrics.queuedRequests,
			uptime: Math.floor(performance.now() / 1000),
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

				const { message } = result;

				// Handle message based on type
				switch (message.type) {
					case MessageType.CONFIG_UPDATE:
						await this.handleConfigUpdate(message.fields);
						break;

					case MessageType.ROUTE_REQUEST:
						await this.handleRouteRequest(message.id, message.fields);
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
	 * Start the router process
	 */
	async start () {
		console.log(`[${this.processId}] Starting router process...`);

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

		// Initialize pool manager with router worker factory
		const routerPoolConfig = this.config.at(['pools', '@router']) || {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
			maxReqs: 0,
			idleTimeout: 300,
			reqTimeout: 30,
		};

		const workerFactory = async (itemId) => {
			const worker = new RouterWorker(itemId, this.workerUrl);
			await worker.initialize(this.config, this.fsRouting);
			return { item: worker, isWorker: true };
		};

		this.poolManager = new PoolManager('@router', routerPoolConfig, workerFactory);
		await this.poolManager.initialize();

		console.log(`[${this.processId}] Router process started successfully`);

		// Process incoming messages
		await this.processMessages();
	}
}

/**
 * Main entry point
 */
async function main () {
	const processId = Deno.env.get('JSMAWS_PID');
	const routerProcess = new RouterProcess(processId);

	// Handle shutdown signals
	const shutdownHandler = async () => {
		await routerProcess.handleShutdown(new NANOS());
	};

	Deno.addSignalListener('SIGINT', shutdownHandler);
	Deno.addSignalListener('SIGTERM', shutdownHandler);

	// Start the router process
	await routerProcess.start();
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing
export { RouterProcess };
