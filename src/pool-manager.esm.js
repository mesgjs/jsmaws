/**
 * JSMAWS Pool Manager
 * Generic pool manager supporting both worker pools and process pools
 *
 * This manager handles:
 * - Worker pools (Web Workers within a process)
 * - Process pools (sub-processes spawned by operator)
 * - Unified scaling algorithm controlled by configuration parameters
 * - Capacity tracking and metrics
 * - Lifecycle management (spawn, monitor, recycle, shutdown)
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Serializer } from './serializer.esm.js';

/**
 * Pool item states
 */
const ItemState = {
	STARTING: 'starting',  // Initializing
	IDLE: 'idle',          // No active requests (recyclable)
	READY: 'ready',        // Has requests but below capacity (available)
	BUSY: 'busy',          // At capacity (unavailable)
	RECYCLING: 'recycling', // Being shut down
	DEAD: 'dead',          // Terminated
};

/**
 * Pool item wrapper
 * Wraps either a Web Worker or a process handle
 */
class PoolItem {
	constructor (poolManager, id, item, isWorker, initialUsage, maxConcurrent = 1) {
		this.poolManager = poolManager;
		this.id = id;
		this.item = item; // Web Worker or process handle
		this.isWorker = isWorker;
		this.totalRequests = initialUsage; // Total requests (lifetime, not concurrent)
		this.lastUsed = Date.now();
		this.createdAt = Date.now();
		this.usageCount = initialUsage; // Current concurrent requests
		this.maxConcurrent = maxConcurrent; // Maximum concurrent requests
		this.shutdownPromise = null;

		// Set initial state based on initial usage
		if (initialUsage === 0) this.state = ItemState.IDLE;
		else if (initialUsage >= maxConcurrent) this.state = ItemState.BUSY;
		else this.state = ItemState.READY;
	}

	/**
	 * Decrement concurrent usage count
	 */
	async decrementUsage () {
		// Loop in the pool manager for pool-level concerns
		return await this.poolManager.decrementItemUsage(this.id);
	}

	_decrementUsage () {
		// Item-level updates...
		this.usageCount = Math.max(0, this.usageCount - 1);
		this.lastUsed = Date.now();

		// Update state based on remaining requests
		switch (this.state) {
		case ItemState.BUSY:
			if (this.usageCount === 0) this.state = ItemState.IDLE;
			else if (this.usageCount < this.maxConcurrent) this.state = ItemState.READY;
			break;
		case ItemState.READY:
			if (this.usageCount === 0) this.state = ItemState.IDLE;
			break;
		}
	}

	/**
	 * Get idle time in seconds
	 */
	getIdleTime () {
		if (!this.isIdle()) return 0;
		return Math.floor((Date.now() - this.lastUsed) / 1000);
	}

	/**
	 * Increment request count
	 */
	incrementRequests () {
		++this.totalRequests;
	}

	/**
	 * Increment concurrent usage count
	 */
	incrementUsage () {
		++this.usageCount;
		this.lastUsed = Date.now();

		// Update state based on capacity
		switch (this.state) {
		case ItemState.IDLE:
			this.state = (this.usageCount < this.maxConcurrent) ? ItemState.READY : ItemState.BUSY;
			break;
		case ItemState.READY:
			if (this.usageCount >= this.maxConcurrent) this.state = ItemState.BUSY;
			break;
		}
	}

	/**
	 * Check if item is available for work (has capacity)
	 */
	isAvailable () {
		return this.state === ItemState.IDLE || this.state === ItemState.READY;
	}

	/**
	 * Check if item is idle (no active requests, recyclable)
	 */
	isIdle () {
		return this.state === ItemState.IDLE;
	}

	/*
	 * Notify listeners when the item shuts down
	 */
	onShutdown (callback) {
		if (!this.shutdownPromise) {
			this.shutdownPromise = Promise.withResolvers();
		}
		this.shutdownPromise.promise.then(() => callback());
	}

	/**
	 * Check if item should be recycled
	 */
	shouldRecycle (maxReqs) {
		if (maxReqs === 0) return false; // Unlimited
		return this.totalRequests >= maxReqs;
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
		this.serializer = new Serializer();
		this.itemIdCounter = 0;
		this.isShuttingDown = false;
		this.scaleTimer = null;

		// Metrics
		this.metrics = {
			totalSpawned: 0,
			totalRecycled: 0,
			totalRequests: 0,
			totalErrors: 0,
		};
	}

	/**
	 * Check if pool can spawn more items
	 */
	canSpawnItem (auto = false) {
		if (this.isShuttingDown) return false;
		if (auto && this.serializer.size) return false;
		return this.items.size < this.config.maxProcs;
	}

	/**
	 * Decrement item usage (active requests) and check for recycling
	 */
	async decrementItemUsage (itemId) {
		const item = this.items.get(itemId);
		if (!item) {
			this.logger.warn(`[PoolManager:${this.poolName}] Item not found: ${itemId}`);
			return;
		}

		item._decrementUsage();
		item.incrementRequests();

		// Check if item should be recycled
		if (item.shouldRecycle(this.config.maxReqs)) {
			this.logger.debug(`[PoolManager:${this.poolName}] Item ${itemId} reached maxReqs (${this.config.maxReqs}); recycling`);
			await this.recycleItem(itemId);
		}
	}

	/**
	 * Generate unique item ID
	 */
	generateItemId () {
		return `${this.poolName}-${++this.itemIdCounter}`;
	}

	/**
	 * Get available item with optional affinity preference
	 * @param {Set<string>|null} preferredIds - Optional set of preferred item IDs
	 * @returns {PoolItem|null}
	 */
	async getAvailableItem (preferredIds = null) {
		this.metrics.totalRequests++;
		this.logger.debug(`Searching for available item in ${this.poolName} of ${this.items.size}`);
		// Strategy 1: Check affinity items first if provided
		if (preferredIds) {
			for (const itemId of preferredIds) {
				const item = this.items.get(itemId);
				if (item && item.isAvailable()) {
					item.incrementUsage();
					return item;
				}
			}
		}

		// Strategy 2: Find any existing available item
		for (const item of this.items.values()) {
			this.logger.debug(`Considering ${item.id} usage ${item.usageCount} state ${item.state}`);
			if (item.isAvailable()) {
				this.logger.debug('(available)');
				item.incrementUsage();
				return item;
			}
			this.logger.debug('(not available)');
		}

		// Strategy 3: Spawn new (reserved) item on-demand if allowed
		const canSpawn = this.canSpawnItem();
		if (canSpawn) {
			try {
				return await this.spawnItem(1);
			} catch (error) {
				this.logger.error(`[PoolManager:${this.poolName}] Failed to spawn item:`, error);
			}
		}

		return null;
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
			queuedRequests: this.serializer.size,
		};
	}

	/**
	 * Increment item usage (active requests)
	 * (Should only be needed for testing)
	 */
	incrementItemUsage (itemId) {
		const item = this.items.get(itemId);
		if (!item) {
			throw new Error(`Item not found: ${itemId}`);
		}
		item.incrementUsage();
	}

	/**
	 * Initialize pool
	 */
	async initialize () {
		this.logger.debug(`[PoolManager:${this.poolName}] Initializing pool (minProcs: ${this.config.minProcs}, maxProcs: ${this.config.maxProcs})`);

		// Spawn minimum items
		for (let i = 0; i < this.config.minProcs; i++) {
			await this.spawnItem();
		}

		// Always start scaling (it will self-stop at equilibrium)
		this.startScaling();

		this.logger.debug(`[PoolManager:${this.poolName}] Initialized with ${this.items.size} items`);
	}

	/**
	 * Perform unified scaling algorithm
	 * Adapts behavior based on configuration parameters
	 */
	async performScaling () {
		if (this.isShuttingDown) return;

		const currentCount = this.items.size;
		const { minProcs, maxProcs, idleTimeout } = this.config;

		// Stop timer only when:
		// 1. No scaling is possible (min === max)
		// 2. Current count is within spec (min <= current <= max)
		if (minProcs === maxProcs && currentCount === minProcs) {
			this.stopScaling();
			return;
		}

		const idleItems = Array.from(this.items.values()).filter((item) => item.isIdle());

		// Scale down: Remove idle items beyond minProcs
		if (currentCount > minProcs) {
			if (!idleItems.length) this.logger.debug(`[PoolManager:${this.poolName}]: No idle items for scale-down`);
			for (const item of idleItems) {
				if (this.items.size <= minProcs) break;

				const idleTime = item.getIdleTime();
				if (idleTime >= idleTimeout) {
					this.logger.debug(`[PoolManager:${this.poolName}] Scaling down: removing idle item ${item.id} (idle: ${idleTime}s)`);
					await this.recycleItem(item.id);
				}
			}
		}

		// Scale up: Spawn items if below minProcs
		while (this.items.size < minProcs && this.canSpawnItem(true)) {
			this.logger.debug(`[PoolManager:${this.poolName}] Scaling up: below minProcs, spawning new item`);
			try {
				await this.spawnItem();
			} catch (error) {
				this.logger.error(`[PoolManager:${this.poolName}] Failed to scale up:`, error);
				break; // Stop trying if spawn fails
			}
		}

		// Can't be busy when you're not doing anything (ie at minProcs = 0)!
		if (!this.items.size) return;

		// Scale up: Spawn if all busy and below maxProcs
		const availableCount = Array.from(this.items.values()).filter((item) => item.isAvailable()).length;
		if (availableCount === 0 && this.canSpawnItem(true)) {
			this.logger.debug(`[PoolManager:${this.poolName}] Scaling up: all items busy, spawning new item`);
			try {
				await this.spawnItem();
			} catch (error) {
				this.logger.error(`[PoolManager:${this.poolName}] Failed to scale up:`, error);
			}
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
			// Wake up any shutdown listeners
			const onShutdown = !this.isShuttingDown && item.shutdownPromise;
			if (onShutdown) onShutdown.resolve();

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

		// Wake up any shutdown listeners
		const onShutdown = !this.isShuttingDown && item.shutdownPromise;
		if (onShutdown) onShutdown.resolve();

		item.state = ItemState.DEAD;
		this.items.delete(itemId);
	}

	/**
	 * Serialize pool access.
	 * Returns a promise with the return value of the async callback.
	 * Rejects if shutting down.
	 */
	serialize (callback) {
		return this.serializer.serialize(callback);
	}

	/**
	 * Graceful shutdown
	 */
	async shutdown (stopTime = 30) {
		this.logger.info(`[PoolManager:${this.poolName}] Shutting down (${stopTime}s)`);
		this.isShuttingDown = true;
		this.stopScaling();
		// The process manager will handle processes in the case of a system-wide shutdown
		const systemShutdown = globalThis.OperatorProcess?.instance?.isShuttingDown;

		this.serializer.shutdown();
		const shutdownPromises = [];
		for (const [itemId, item] of this.items.entries()) {
			const promise = (async () => {
				try {
					if (!systemShutdown && item.shutdownPromise) item.shutdownPromise.resolve();
					if (item.isWorker) {
						item.item.terminate();
					} else if (!systemShutdown) {
						if (typeof item.item.shutdown === 'function') {
							await item.item.shutdown(stopTime);
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
			const timer = setTimeout(() => wrapUpPromise.resolve(false), stopTime * 1000);
			await wrapUpPromise.promise;
			clearTimeout(timer);
		}

		if (!systemShutdown) this.logger.info(`[PoolManager:${this.poolName}] Shutdown complete (items remaining: ${this.items.size})`);
	}

	/**
	 * Spawn new item (worker or process)
	 */
	async spawnItem (initialUsage = 0) {
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

			// For responder processes, maxConcurrent = maxWorkers from pool config
			// For worker pools, maxConcurrent = 1 (each worker handles one request)
			const maxConcurrent = isWorker ? 1 : this.config.maxWorkers;

			const poolItem = new PoolItem(this, itemId, item, isWorker, initialUsage, maxConcurrent);
			this.items.set(itemId, poolItem);
			this.metrics.totalSpawned++;

			this.logger.debug(`[PoolManager:${this.poolName}] Item ${itemId} spawned successfully (initial ${initialUsage} capacity ${maxConcurrent})`);
			return poolItem;
		} catch (error) {
			this.logger.error(`[PoolManager:${this.poolName}] Failed to spawn item ${itemId}:`, error);
			this.metrics.totalErrors++;
			throw error;
		}
	}

	/**
	 * Start scaling
	 */
	startScaling () {
		if (this.scaleTimer) return;

		// Check every 10 seconds
		this.scaleTimer = setInterval(() => {
			this.performScaling().catch((error) => {
				this.logger.error(`[PoolManager:${this.poolName}] Scaling error:`, error);
			});
		}, 10000);
		// TODO: Configurable scaling frequency
	}

	/**
	 * Stop scaling
	 */
	stopScaling () {
		if (this.scaleTimer) {
			clearInterval(this.scaleTimer);
			this.scaleTimer = null;
		}
	}

	/**
	 * Validate and replace current pool configuration
	 */
	async updateConfig (newConfig) {
		this.logger.info(`[PoolManager:${this.poolName}] Updating configuration`);
		this.config = this.validateConfig(newConfig);

		// Trigger immediate scaling check (blocking to ensure config takes effect)
		this.startScaling();
		await this.performScaling();
	}

	/**
	 * Validate pool configuration object
	 */
	validateConfig (config) {
		const validated = {
			minProcs: config.minProcs ?? 1,
			maxProcs: config.maxProcs ?? 10,
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
		if (validated.maxWorkers < 1) {
			throw new Error(`maxWorkers (${validated.maxWorkers}) < 1`);
		}

		return validated;
	}
}

export { ItemState };
