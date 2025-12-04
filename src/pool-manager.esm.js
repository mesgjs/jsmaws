/**
 * JSMAWS Pool Manager
 * Generic pool manager supporting both worker pools and process pools
 * 
 * This manager handles:
 * - Worker pools (Web Workers within a process)
 * - Process pools (sub-processes spawned by operator)
 * - Three scaling strategies: static, dynamic, ondemand
 * - Capacity tracking and metrics
 * - Lifecycle management (spawn, monitor, recycle, shutdown)
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';

/**
 * Pool item states
 */
const ItemState = {
	STARTING: 'starting',
	IDLE: 'idle',
	BUSY: 'busy',
	RECYCLING: 'recycling',
	DEAD: 'dead',
};

/**
 * Scaling strategies
 */
const ScalingStrategy = {
	STATIC: 'static',
	DYNAMIC: 'dynamic',
	ONDEMAND: 'ondemand',
};

/**
 * Pool item wrapper
 * Wraps either a Web Worker or a process handle
 */
class PoolItem {
	constructor (id, item, isWorker) {
		this.id = id;
		this.item = item; // Web Worker or process handle
		this.isWorker = isWorker;
		this.state = ItemState.STARTING;
		this.requestCount = 0;
		this.lastUsed = Date.now();
		this.createdAt = Date.now();
		this.busyCount = 0; // For workers: concurrent requests
	}

	/**
	 * Check if item is available for work
	 */
	isAvailable () {
		return this.state === ItemState.IDLE && this.busyCount === 0;
	}

	/**
	 * Check if item is idle
	 */
	isIdle () {
		return this.state === ItemState.IDLE && this.busyCount === 0;
	}

	/**
	 * Get idle time in seconds
	 */
	getIdleTime () {
		if (!this.isIdle()) return 0;
		return Math.floor((Date.now() - this.lastUsed) / 1000);
	}

	/**
	 * Mark as busy
	 */
	markBusy () {
		this.state = ItemState.BUSY;
		this.busyCount++;
		this.lastUsed = Date.now();
	}

	/**
	 * Mark as idle
	 */
	markIdle () {
		this.busyCount = Math.max(0, this.busyCount - 1);
		if (this.busyCount === 0) {
			this.state = ItemState.IDLE;
			this.lastUsed = Date.now();
		}
	}

	/**
	 * Increment request count
	 */
	incrementRequests () {
		this.requestCount++;
	}

	/**
	 * Check if item should be recycled
	 */
	shouldRecycle (maxReqs) {
		if (maxReqs === 0) return false; // Unlimited
		return this.requestCount >= maxReqs;
	}
}

/**
 * Generic pool manager
 * Handles both worker pools and process pools with configurable scaling
 */
export class PoolManager {
	constructor (poolName, config, itemFactory, logger) {
		this.poolName = poolName;
		this.config = this.validateConfig(config); // Expects object
		this.itemFactory = itemFactory; // Function to create new items
		this.logger = logger; // Logger instance
		this.items = new Map(); // itemId -> PoolItem
		this.itemIdCounter = 0;
		this.isShuttingDown = false;
		this.scaleTimer = null;
		this.requestQueue = [];

		// Metrics
		this.metrics = {
			totalSpawned: 0,
			totalRecycled: 0,
			totalRequests: 0,
			totalErrors: 0,
		};
	}

	/**
	 * Validate and replace current pool configuration
	 */
	updateConfig (newConfig) {
		this.logger.info(`[PoolManager:${this.poolName}] Updating configuration`);
		this.config = this.validateConfig(newConfig);

		// Trigger immediate scaling check (non-blocking, *all* strategies)
		this.startScalingTimer();
		this.performScaling().catch((error) => {
			this.logger.error(`[PoolManager:${this.poolName}] Scaling error after config update:`, error);
		});
	}

	/**
	 * Validate pool configuration object
	 */
	validateConfig (config) {
		const validated = {
			minProcs: config.minProcs ?? 1,
			maxProcs: config.maxProcs ?? 10,
			scaling: config.scaling ?? ScalingStrategy.DYNAMIC,
			minWorkers: config.minWorkers ?? 1,
			maxWorkers: config.maxWorkers ?? 4,
			maxReqs: config.maxReqs ?? 0,
			idleTimeout: config.idleTimeout ?? 300,
			reqTimeout: config.reqTimeout ?? 30,
			conTimeout: config.conTimeout ?? 60,
		};

		// Validation rules
		if (validated.minProcs < 0) {
			throw new Error(`Invalid minProcs: ${validated.minProcs} (must be >= 0)`);
		}
		if (validated.maxProcs <= 0) {
			throw new Error(`Invalid maxProcs: ${validated.maxProcs} (must be > 0)`);
		}
		if (validated.minProcs > validated.maxProcs) {
			throw new Error(`minProcs (${validated.minProcs}) > maxProcs (${validated.maxProcs})`);
		}
		if (validated.scaling === ScalingStrategy.STATIC && validated.minProcs !== validated.maxProcs) {
			throw new Error(`Static scaling requires minProcs == maxProcs`);
		}
		if (validated.minWorkers < 1) {
			throw new Error(`Invalid minWorkers: ${validated.minWorkers} (must be >= 1)`);
		}
		if (validated.maxWorkers < validated.minWorkers) {
			throw new Error(`maxWorkers (${validated.maxWorkers}) < minWorkers (${validated.minWorkers})`);
		}

		return validated;
	}

	/**
	 * Initialize pool
	 */
	async initialize () {
		this.logger.debug(`[PoolManager:${this.poolName}] Initializing pool (strategy: ${this.config.scaling})`);

		// Spawn minimum items
		const spawnCount = this.config.scaling === ScalingStrategy.ONDEMAND ? 0 : this.config.minProcs;
		for (let i = 0; i < spawnCount; i++) {
			await this.spawnItem();
		}

		// Start scaling timer for dynamic/ondemand strategies
		if (this.config.scaling !== ScalingStrategy.STATIC) {
			this.startScalingTimer();
		}

		this.logger.debug(`[PoolManager:${this.poolName}] Initialized with ${this.items.size} items`);
	}

	/**
	 * Generate unique item ID
	 */
	generateItemId () {
		return `${this.poolName}-${++this.itemIdCounter}`;
	}

	/**
	 * Spawn new item (worker or process)
	 */
	async spawnItem () {
		if (this.isShuttingDown) {
			throw new Error('Pool is shutting down');
		}

		if (this.items.size >= this.config.maxProcs) {
			throw new Error(`Pool at maximum capacity (${this.config.maxProcs})`);
		}

		const itemId = this.generateItemId();
		this.logger.debug(`[PoolManager:${this.poolName}] Spawning item ${itemId}`);

		try {
			// Use factory to create item (worker or process)
			const { item, isWorker } = await this.itemFactory(itemId);

			const poolItem = new PoolItem(itemId, item, isWorker);
			this.items.set(itemId, poolItem);
			this.metrics.totalSpawned++;

			// Mark as idle after initialization
			poolItem.state = ItemState.IDLE;

			this.logger.debug(`[PoolManager:${this.poolName}] Item ${itemId} spawned successfully`);
			return poolItem;
		} catch (error) {
			this.logger.error(`[PoolManager:${this.poolName}] Failed to spawn item ${itemId}:`, error);
			this.metrics.totalErrors++;
			throw error;
		}
	}

	/**
	 * Get available item
	 */
	async getAvailableItem () {
		this.metrics.totalRequests++;

		// Strategy 1: Find idle item
		for (const item of this.items.values()) {
			if (item.isAvailable()) {
				return item;
			}
		}

		// Strategy 2: Spawn new item if allowed
		const canSpawn = this.canSpawnItem();
		if (canSpawn) {
			try {
				return await this.spawnItem();
			} catch (error) {
				this.logger.error(`[PoolManager:${this.poolName}] Failed to spawn item:`, error);
			}
		}

		// Strategy 3: Queue request (caller handles)
		return null;
	}

	/**
	 * Check if pool can spawn more items
	 */
	canSpawnItem () {
		if (this.isShuttingDown) return false;
		if (this.items.size >= this.config.maxProcs) return false;

		// For static scaling, only spawn up to minProcs
		if (this.config.scaling === ScalingStrategy.STATIC) {
			return this.items.size < this.config.minProcs;
		}

		return true;
	}

	/**
	 * Mark item as busy
	 */
	markItemBusy (itemId) {
		const item = this.items.get(itemId);
		if (!item) {
			throw new Error(`Item not found: ${itemId}`);
		}
		item.markBusy();
	}

	/**
	 * Mark item as idle and check for recycling
	 */
	async markItemIdle (itemId) {
		const item = this.items.get(itemId);
		if (!item) {
			this.logger.warn(`[PoolManager:${this.poolName}] Item not found: ${itemId}`);
			return;
		}

		item.markIdle();
		item.incrementRequests();

		// Check if item should be recycled
		if (item.shouldRecycle(this.config.maxReqs)) {
			this.logger.debug(`[PoolManager:${this.poolName}] Item ${itemId} reached maxReqs (${this.config.maxReqs}); recycling`);
			await this.recycleItem(itemId);
		}
	}

	/**
	 * Recycle item (graceful shutdown and respawn)
	 */
	async recycleItem (itemId) {
		const item = this.items.get(itemId);
		if (!item) return;

		this.logger.debug(`[PoolManager:${this.poolName}] Recycling item ${itemId}`);
		item.state = ItemState.RECYCLING;

		try {
			// Terminate item
			if (item.isWorker) {
				item.item.terminate();
			} else {
				// For processes, send shutdown signal (implementation-specific)
				// This is a hook for process-based pools
				if (typeof item.item.shutdown === 'function') {
					await item.item.shutdown();
				}
			}

			this.items.delete(itemId);
			this.metrics.totalRecycled++;

			// Spawn replacement if needed
			if (!this.isShuttingDown && this.items.size < this.config.minProcs) {
				await this.spawnItem();
			}
		} catch (error) {
			this.logger.error(`[PoolManager:${this.poolName}] Error recycling item ${itemId}:`, error);
			this.metrics.totalErrors++;
		}
	}

	/**
	 * Remove dead item
	 */
	removeItem (itemId) {
		const item = this.items.get(itemId);
		if (!item) return;

		this.logger.info(`[PoolManager:${this.poolName}] Removing dead item ${itemId}`);
		item.state = ItemState.DEAD;
		this.items.delete(itemId);
	}

	/**
	 * Start scaling timer
	 */
	startScalingTimer () {
		if (this.scaleTimer) return;

		// Check every 10 seconds
		this.scaleTimer = setInterval(() => {
			this.performScaling().catch((error) => {
				this.logger.error(`[PoolManager:${this.poolName}] Scaling error:`, error);
			});
		}, 10000);
	}

	/**
	 * Stop scaling timer
	 */
	stopScalingTimer () {
		if (this.scaleTimer) {
			clearInterval(this.scaleTimer);
			this.scaleTimer = null;
		}
	}

	/**
	 * Perform scaling based on strategy
	 */
	async performScaling () {
		if (this.isShuttingDown) return;

		const idleItems = Array.from(this.items.values()).filter((item) => item.isIdle());
		const idleCount = idleItems.length;

		// Scale down: Remove idle items beyond minProcs
		if (idleCount > 0 && this.items.size > this.config.minProcs) {
			for (const item of idleItems) {
				if (this.items.size <= this.config.minProcs) break;

				const idleTime = item.getIdleTime();
				if (idleTime >= this.config.idleTimeout) {
					this.logger.debug(`[PoolManager:${this.poolName}] Scaling down: removing idle item ${item.id} (idle: ${idleTime}s)`);
					await this.recycleItem(item.id);
				}
			}
		}

		// Scale up: Spawn items if below minProcs OR (all busy and below maxProcs)
		if (this.items.size < this.config.minProcs) {
			// Below minimum - spawn to reach minProcs
			this.logger.debug(`[PoolManager:${this.poolName}] Scaling up: below minProcs, spawning new item`);
			try {
				await this.spawnItem();
			} catch (error) {
				this.logger.error(`[PoolManager:${this.poolName}] Failed to scale up:`, error);
			}
		} else {
			// At or above minimum - only spawn if all items are busy
			const availableCount = Array.from(this.items.values()).filter((item) => item.isAvailable()).length;
			const busyCount = this.items.size - availableCount;
			if (availableCount === 0 && busyCount > 0 && this.canSpawnItem()) {
				this.logger.debug(`[PoolManager:${this.poolName}] Scaling up: all items busy, spawning new item`);
				try {
					await this.spawnItem();
				} catch (error) {
					this.logger.error(`[PoolManager:${this.poolName}] Failed to scale up:`, error);
				}
			}
		}

		if (this.items.size === this.config.minProcs && this.config.scaling === ScalingStrategy.STATIC) {
			// Stop scaling static strategy at equilibrium
			this.stopScalingTimer();
		}
	}

	/**
	 * Get pool metrics
	 */
	getMetrics () {
		const items = Array.from(this.items.values());
		return {
			poolName: this.poolName,
			totalItems: this.items.size,
			availableItems: items.filter((item) => item.isAvailable()).length,
			busyItems: items.filter((item) => item.state === ItemState.BUSY).length,
			idleItems: items.filter((item) => item.isIdle()).length,
			totalSpawned: this.metrics.totalSpawned,
			totalRecycled: this.metrics.totalRecycled,
			totalRequests: this.metrics.totalRequests,
			totalErrors: this.metrics.totalErrors,
			queuedRequests: this.requestQueue.length,
		};
	}

	/**
	 * Graceful shutdown
	 */
	async shutdown (timeoutSeconds = 30) {
		this.logger.info(`[PoolManager:${this.poolName}] Shutting down (timeout: ${timeoutSeconds}s)`);
		this.isShuttingDown = true;
		this.stopScalingTimer();

		const shutdownPromises = [];
		for (const [itemId, item] of this.items.entries()) {
			const promise = (async () => {
				try {
					if (item.isWorker) {
						item.item.terminate();
					} else {
						if (typeof item.item.shutdown === 'function') {
							await item.item.shutdown(timeoutSeconds);
						}
					}
					this.items.delete(itemId);
				} catch (error) {
					this.logger.error(`[PoolManager:${this.poolName}] Error shutting down item ${itemId}:`, error);
				}
			})();
			shutdownPromises.push(promise);
		}

		// Wait for all items to shutdown with timeout
		if (shutdownPromises.length) {
			const wrapUpPromise = Promise.withResolvers();
			Promise.all(shutdownPromises).then(() => wrapUpPromise.resolve(true));
			const timer = setTimeout(() => wrapUpPromise.resolve(false), timeoutSeconds * 1000);
			await wrapUpPromise.promise;
			clearTimeout(timer);
		}

		this.logger.info(`[PoolManager:${this.poolName}] Shutdown complete (${this.items.size} items remaining)`);
	}
}

export { ItemState, ScalingStrategy };
