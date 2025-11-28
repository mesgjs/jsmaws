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
	MessageType,
	createRouteResponse,
	validateMessage,
} from './ipc-protocol.esm.js';
import { ServiceProcess } from './service-process.esm.js';
import { PoolManager } from './pool-manager.esm.js';
import { RouterWorkerProxy } from './router-worker-proxy.esm.js';

/**
 * Router process class
 * Hosts router workers in a pool for filesystem-based route resolution
 */
class RouterProcess extends ServiceProcess {
	constructor (processId) {
		super('router', processId);
		this.fsRouting = false;
		this.poolManager = null;
		this.workerUrl = new URL('./router-worker.esm.js', import.meta.url).href;
	}

	/**
	 * Handle configuration update from operator
	 */
	async handleConfigUpdate (fields) {
		console.log(`[${this.processId}] Received configuration update`);

		// Configuration instance is already updated by ServiceProcess base class
		// Just need to propagate to pool manager and workers

		// Update pool manager if already initialized
		if (this.poolManager) {
			// Get router pool config
			const routerPoolConfig = this.config.getPoolConfig('@router') || {};
			await this.poolManager.updateConfig(routerPoolConfig);

			// Update all workers with new configuration
			for (const item of this.poolManager.items.values()) {
				if (item.item instanceof RouterWorkerProxy) {
					await item.item.updateConfig(this.config);
				}
			}
		}

		console.log(`[${this.processId}] Configuration updated (fsRouting: ${this.config.routing.fsRouting})`);
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
	 * Get message handlers for router-specific messages
	 */
	getMessageHandlers () {
		const baseHandlers = super.getMessageHandlers();

		// Add router-specific handler
		baseHandlers.set(MessageType.ROUTE_REQUEST, async (id, fields) => {
			await this.handleRouteRequest(id, fields);
		});

		return baseHandlers;
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
			availableWorkers: metrics.availableItems,
			totalWorkers: metrics.totalItems,
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
	 * Initialize pool manager after configuration is loaded
	 */
	async onStarted () {
		// Initialize pool manager with router worker factory
		const routerPoolConfig = this.config.getPoolConfig('@router') || {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
			maxReqs: 0,
			idleTimeout: 300,
			reqTimeout: 30,
		};

		const workerFactory = async (itemId) => {
			const worker = new RouterWorkerProxy(itemId, this.workerUrl);
			await worker.initialize(this.config);
			return { item: worker, isWorker: true };
		};

		this.poolManager = new PoolManager('@router', routerPoolConfig, workerFactory);
		await this.poolManager.initialize();
	}
}

/**
 * Main entry point
 */
async function main () {
	const processId = Deno.env.get('JSMAWS_PID'); // process id string
	await ServiceProcess.run(RouterProcess, processId);
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
