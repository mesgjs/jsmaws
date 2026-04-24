/**
 * JSMAWS Router Process
 * Semi-privileged service process for filesystem-based route resolution
 *
 * This process:
 * - Runs with reduced privileges (read-only filesystem access, non-root uid/gid)
 * - Hosts router workers for route resolution (managed by pool-manager)
 * - Receives route requests from operator via PipeTransport req-N channels
 * - Sends route responses back to operator via the same req-N channels
 * - Only spawned when fsRouting is enabled in configuration
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { ServiceProcess } from './service-process.esm.js';
import { PoolManager } from './pool-manager.esm.js';
import { RouterWorkerProxy } from './router-worker-proxy.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from './request-channel-pool.esm.js';

/**
 * Router-specific req-N channel message types
 * (route-request and route-response are router-specific)
 */
const ROUTER_REQ_MESSAGE_TYPES = [
	...REQ_CHANNEL_MESSAGE_TYPES,
	'route-request',    // operator → router: route resolution request (JSON text)
	'route-response',   // router → operator: route resolution response (JSON text)
];

/**
 * Router process class
 * Hosts router workers in a pool for filesystem-based route resolution
 */
class RouterProcess extends ServiceProcess {
	constructor (processId) {
		super('router', processId);
		this.poolManager = null;
		this.workerUrl = new URL('./router-worker.esm.js', import.meta.url).href;
	}

	/**
	 * Handle configuration update from operator.
	 * Called after this.config has been updated by the ServiceProcess base class.
	 */
	async handleConfigUpdate () {
		console.info(`[${this.processId}] Received configuration update`);

		// Propagate updated config to pool manager and workers

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

		console.debug(`[${this.processId}] Configuration updated (fsRouting: ${this.config.routing.fsRouting})`);
	}

	/**
	 * Handle health check from operator.
	 * @param {object} msg - PolyTransport message (from control channel)
	 */
	async handleHealthCheck (msg) {
		console.debug(`[${this.processId}] Health check received`);

		// Get worker stats from pool manager
		const metrics = this.poolManager?.getMetrics() ?? { availableItems: 0, totalItems: 0 };

		// Send health response via control channel
		await this.controlChannel.write('health-response', JSON.stringify({
			status: 'ok',
			availableWorkers: metrics.availableItems,
			totalWorkers: metrics.totalItems,
			uptime: Math.floor(performance.now() / 1000),
		}));

		// Also send capacity update
		await this.sendCapacityUpdate(metrics.availableItems, metrics.totalItems);
	}

	/**
	 * Handle an accepted req-N channel.
	 * Sets up message types and starts the route-request read loop.
	 * @param {object} reqChannel - PolyTransport channel
	 */
	async handleReqChannel (reqChannel) {
		await reqChannel.addMessageTypes(ROUTER_REQ_MESSAGE_TYPES);

		// Process route requests on this channel
		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: 'route-request', decode: true });
				if (!msg) break;
				await msg.process(async () => {
					await this.#handleRouteRequest(reqChannel, msg.text);
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
		msg?.done(); // ACK the shutdown message before transport.stop() to avoid channel-close deadlock
		console.info(`[${this.processId}] Shutdown requested (timeout: ${timeout}s)`);

		this.isShuttingDown = true;

		// Shutdown pool manager
		if (this.poolManager) {
			await this.poolManager.shutdown(timeout);
		}

		// Stop transport (graceful drain)
		if (this.transport) {
			await this.transport.stop();
		}

		console.info(`[${this.processId}] Shutdown complete`);
		Deno.exit(0);
	}

	/**
	 * Handle a route request on a req-N channel.
	 * @param {object} reqChannel - The req-N channel to write the response to
	 * @param {string} requestJson - JSON-encoded route request
	 */
	async #handleRouteRequest (reqChannel, requestJson) {
		let requestData;
		try {
			requestData = JSON.parse(requestJson);
		} catch (err) {
			console.error(`[${this.processId}] Invalid route request JSON:`, err);
			await reqChannel.write('route-response', JSON.stringify({ status: 400 }));
			return;
		}

		const { id, method, path } = requestData;

		try {
			console.debug(`[${this.processId}] Route request: ${method?.toUpperCase()} ${path}`);

			// Get available worker from pool
			const poolItem = await this.poolManager.getAvailableItem();

			if (!poolItem) {
				console.warn(`[${this.processId}] No available workers, returning 503`);
				await reqChannel.write('route-response', JSON.stringify({ id, status: 503 }));
				return;
			}

			try {
				// Find route using worker
				const routeMatch = await poolItem.item.findRoute(path, method);

				if (routeMatch) {
					await reqChannel.write('route-response', JSON.stringify({
						id,
						status: 200,
						pool: routeMatch.pool || 'standard',
						app: routeMatch.app || '',
						params: routeMatch.params || {},
						tail: routeMatch.tail || '',
					}));
				} else {
					await reqChannel.write('route-response', JSON.stringify({ id, status: 404 }));
				}
			} finally {
				// Make sure route worker is always marked free
				await this.poolManager.decrementItemUsage(poolItem.id);
			}
		} catch (error) {
			console.error(`[${this.processId}] Route request error:`, error);
			await reqChannel.write('route-response', JSON.stringify({ id, status: 500 }));
		}
	}

	/**
	 * Initialize pool manager after configuration is loaded.
	 */
	async onStarted () {
		// Initialize pool manager with router worker factory
		const routerPoolConfig = this.config.getPoolConfig('@router') || {
			minProcs: 1,
			maxProcs: 5,
			maxReqs: 0,
			idleTimeout: 300,
			reqTimeout: 30,
		};

		const workerFactory = async (itemId) => {
			const worker = new RouterWorkerProxy(itemId, this.workerUrl);
			await worker.initialize(this.config);
			return { item: worker, isWorker: true };
		};

		this.poolManager = new PoolManager('@router', routerPoolConfig, workerFactory, this.logger);
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
