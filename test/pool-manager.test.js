/**
 * Pool Manager Tests
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PoolManager, ItemState } from '../src/pool-manager.esm.js';

// Mock logger
function createMockLogger () {
	return {
		debug: () => {},
		error: () => {},
		info: () => {},
		warn: () => {},
		/*
		debug: (...args) => console.debug(...args),
		error: (...args) => console.error(...args),
		info: (...args) => console.info(...args),
		warn: (...args) => console.warn(...args),
		/* */
	};
}

// Mock worker factory
function createMockWorkerFactory () {
	let workerCount = 0;
	return async (itemId) => {
		workerCount++;
		const mockWorker = {
			id: itemId,
			terminate: () => { },
			postMessage: () => { },
		};
		return { item: mockWorker, isWorker: true };
	};
}

// Mock process factory
function createMockProcessFactory () {
	let processCount = 0;
	return async (itemId) => {
		processCount++;
		const mockProcess = {
			id: itemId,
			shutdown: async () => { },
		};
		return { item: mockProcess, isWorker: false };
	};
}

// Helper to wait for async operations
function delay (ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test('PoolManager - Configuration Validation', async (t) => {
	await t.step('should validate minProcs >= 0', () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: -1, maxProcs: 10 }, factory, logger);
			},
			Error,
			'Invalid minProcs'
		);
	});

	await t.step('should validate maxProcs > 0', () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 0, maxProcs: 0 }, factory, logger);
			},
			Error,
			'Invalid maxProcs'
		);
	});

	await t.step('should validate minProcs <= maxProcs', () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 10, maxProcs: 5 }, factory, logger);
			},
			Error,
			'minProcs'
		);
	});

	await t.step('should accept valid configuration', () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('test', {
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 4,
		}, factory, logger);
		assertEquals(pool.config.minProcs, 2);
		assertEquals(pool.config.maxProcs, 10);
	});
});

Deno.test('PoolManager - Fixed-Size Pool Pattern', async (t) => {
	await t.step('should spawn exactly minProcs items', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('fixed-test', {
			minProcs: 3,
			maxProcs: 3,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 3);

		await pool.shutdown(1);
	});

	await t.step('should not scale up or down', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('fixed-test', {
			minProcs: 2,
			maxProcs: 2,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 2);

		// Get first item
		const item1 = await pool.getAvailableItem();
		assertEquals(item1 !== null, true);

		// Get second item
		const item2 = await pool.getAvailableItem();
		assertEquals(item2 !== null, true);

		// Try to get third item - should return null (no scaling in fixed-size mode)
		const item3 = await pool.getAvailableItem();
		assertEquals(item3, null); // Should not spawn new item
		assertEquals(pool.items.size, 2);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Baseline Pool Pattern', async (t) => {
	await t.step('should spawn minProcs items on initialization', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('baseline-test', {
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 2);

		await pool.shutdown(1);
	});

	await t.step('should scale up when all items busy', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('baseline-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 1);

		// Get first item
		const item1 = await pool.getAvailableItem();
		assertEquals(item1 !== null, true);

		// Should spawn new item
		const item2 = await pool.getAvailableItem();
		assertEquals(item2 !== null, true);
		assertEquals(pool.items.size, 2);

		await pool.shutdown(1);
	});

	await t.step('should not exceed maxProcs', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('baseline-test', {
			minProcs: 1,
			maxProcs: 2,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		const item1 = await pool.getAvailableItem();

		const item2 = await pool.getAvailableItem();

		const item3 = await pool.getAvailableItem();
		assertEquals(item3, null); // At max capacity

		await pool.shutdown(1);
	});

	await t.step('should scale down idle items after timeout', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('baseline-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
			idleTimeout: 1, // 1 second for testing
		}, factory, logger);

		await pool.initialize();

		// Spawn extra items
		await pool.spawnItem();
		await pool.spawnItem();
		assertEquals(pool.items.size, 3);

		// Wait for idle timeout
		await delay(1500);

		// Trigger scaling
		await pool.performScaling();

		// Should scale down to minProcs
		assertEquals(pool.items.size, 1);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Zero-Baseline Pool Pattern', async (t) => {
	await t.step('should start with 0 items', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('zero-baseline-test', {
			minProcs: 0,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 0);

		await pool.shutdown(1);
	});

	await t.step('should spawn items on demand', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('zero-baseline-test', {
			minProcs: 0,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 0);

		const item = await pool.getAvailableItem();
		assertEquals(item !== null, true);
		assertEquals(pool.items.size, 1);

		await pool.shutdown(1);
	});

	await t.step('should kill idle items after timeout', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('zero-baseline-test', {
			minProcs: 0,
			maxProcs: 10,
			maxWorkers: 1,
			idleTimeout: 1, // 1 second for testing
		}, factory, logger);

		await pool.initialize();

		// Spawn item
		const item = await pool.getAvailableItem();
		assertEquals(pool.items.size, 1);
		// Free item
		item.decrementUsage();

		// Wait for idle timeout
		await delay(1500);

		// Trigger scaling
		await pool.performScaling();

		// Should scale down to 0
		assertEquals(pool.items.size, 0);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Item Lifecycle', async (t) => {
	await t.step('should mark items as busy and idle', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('lifecycle-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.state, ItemState.BUSY);
		assertEquals(item.isAvailable(), false);

		await pool.decrementItemUsage(item.id);
		assertEquals(item.state, ItemState.IDLE);
		assertEquals(item.isAvailable(), true);

		await pool.shutdown(1);
	});

	await t.step('should recycle items after maxReqs', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('lifecycle-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
			maxReqs: 3,
		}, factory, logger);

		await pool.initialize();
		const initialSize = pool.items.size;

		const item = await pool.getAvailableItem();
		const itemId = item.id;

		// Process 3 requests
		for (let i = 0; i < 3; i++) {
			if (i) pool.incrementItemUsage(itemId);
			await pool.decrementItemUsage(itemId);
		}

		// Item should be recycled and replaced
		assertEquals(pool.items.has(itemId), false);
		assertEquals(pool.items.size, initialSize); // Replaced

		await pool.shutdown(1);
	});

	await t.step('should track request count', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('lifecycle-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.totalRequests, 0);

		await pool.decrementItemUsage(item.id);
		assertEquals(item.totalRequests, 1);

		pool.incrementItemUsage(item.id);
		await pool.decrementItemUsage(item.id);
		assertEquals(item.totalRequests, 2);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Metrics', async (t) => {
	await t.step('should track pool metrics', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('metrics-test', {
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		const metrics = pool.getMetrics();
		assertEquals(metrics.poolName, 'metrics-test');
		assertEquals(metrics.totalItems, 2);
		assertEquals(metrics.availableItems, 2);
		assertEquals(metrics.busyItems, 0);
		assertEquals(metrics.totalSpawned, 2);

		// Get item
		const item = await pool.getAvailableItem();

		const metrics2 = pool.getMetrics();
		assertEquals(metrics2.availableItems, 1);
		assertEquals(metrics2.busyItems, 1);
		assertEquals(metrics2.totalRequests, 1);

		await pool.shutdown(1);
	});

	await t.step('should track spawned and recycled counts', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('metrics-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
			maxReqs: 2,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.metrics.totalSpawned, 1);
		assertEquals(pool.metrics.totalRecycled, 0);

		const item = await pool.getAvailableItem();

		// Trigger recycling
		await pool.decrementItemUsage(item.id);
		pool.incrementItemUsage(item.id);
		await pool.decrementItemUsage(item.id);

		// Wait for recycling to complete
		await delay(100);

		assertEquals(pool.metrics.totalRecycled, 1);
		assertEquals(pool.metrics.totalSpawned, 2); // Original + replacement

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Configuration Updates', async (t) => {
	await t.step('should update configuration', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('config-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.config.minProcs, 1);
		assertEquals(pool.config.maxProcs, 5);

		await pool.updateConfig({
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
		});

		assertEquals(pool.config.minProcs, 2);
		assertEquals(pool.config.maxProcs, 10);
		assertEquals(pool.items.size, 2); // Should spawn to meet minProcs

		await pool.shutdown(1);
	});

	await t.step('should stop timer when converging to fixed size', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('config-test', {
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.scaleTimer !== null, true);

		await pool.updateConfig({
			minProcs: 2,
			maxProcs: 2,
		});

		// Wait for scaling to converge
		await delay(100);
		await pool.performScaling();

		assertEquals(pool.scaleTimer, null); // Timer should be stopped at equilibrium

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Worker vs Process Pools', async (t) => {
	await t.step('should handle worker pools', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('worker-test', {
			minProcs: 2,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.isWorker, true);

		await pool.shutdown(1);
	});

	await t.step('should handle process pools', async () => {
		const factory = createMockProcessFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('process-test', {
			minProcs: 2,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.isWorker, false);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Shutdown', async (t) => {
	await t.step('should gracefully shutdown all items', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('shutdown-test', {
			minProcs: 3,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 3);

		await pool.shutdown(1);
		assertEquals(pool.items.size, 0);
		assertEquals(pool.isShuttingDown, true);
	});

	await t.step('should prevent spawning during shutdown', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('shutdown-test', {
			minProcs: 1,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		pool.isShuttingDown = true;

		await assertRejects(
			async () => await pool.spawnItem(),
			Error,
			'shutting down'
		);

		clearInterval(pool.scaleTimer);
	});
});


Deno.test('PoolManager - Unified Scaling', async (t) => {
	await t.step('should stop timer when min === max and at equilibrium', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('unified-test', {
			minProcs: 3,
			maxProcs: 3,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 3);

		// Wait for scaling to run
		await delay(100);
		await pool.performScaling();

		// Timer should be stopped at equilibrium
		assertEquals(pool.scaleTimer, null);

		await pool.shutdown(1);
	});

	await t.step('should continue timer when out of spec after config change', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('unified-test', {
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		// Spawn extra items to get to 10
		for (let i = 0; i < 8; i++) {
			await pool.spawnItem();
		}
		assertEquals(pool.items.size, 10);

		// Change config to fixed size of 5
		await pool.updateConfig({
			minProcs: 5,
			maxProcs: 5,
			maxWorkers: 1,
			idleTimeout: 1, // Fast timeout for testing
		});

		// Timer should still be running (pool out of spec)
		assertEquals(pool.scaleTimer !== null, true);

		// Wait for idle timeout and scaling
		await delay(1500);
		await pool.performScaling();

		// Should scale down to 5
		assertEquals(pool.items.size, 5);

		// Now timer should stop (at equilibrium)
		await pool.performScaling();
		assertEquals(pool.scaleTimer, null);

		await pool.shutdown(1);
	});

	await t.step('should handle any minProcs/maxProcs combination', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();

		// Test 0/10 (zero-baseline)
		const pool1 = new PoolManager('unified-test-1', {
			minProcs: 0,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);
		await pool1.initialize();
		assertEquals(pool1.items.size, 0);
		await pool1.shutdown(1);

		// Test 5/5 (fixed-size)
		const pool2 = new PoolManager('unified-test-2', {
			minProcs: 5,
			maxProcs: 5,
			maxWorkers: 1,
		}, factory, logger);
		await pool2.initialize();
		assertEquals(pool2.items.size, 5);
		await pool2.shutdown(1);

		// Test 2/20 (baseline with scaling)
		const pool3 = new PoolManager('unified-test-3', {
			minProcs: 2,
			maxProcs: 20,
			maxWorkers: 1,
		}, factory, logger);
		await pool3.initialize();
		assertEquals(pool3.items.size, 2);
		await pool3.shutdown(1);
	});

	await t.step('should scale up to minProcs after config increase', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('unified-test', {
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();
		assertEquals(pool.items.size, 2);

		// Increase minProcs
		await pool.updateConfig({
			minProcs: 5,
			maxProcs: 20,
			maxWorkers: 1,
		});

		// Should spawn to reach new minimum
		assertEquals(pool.items.size, 5);

		await pool.shutdown(1);
	});

	await t.step('should scale down to maxProcs after config decrease', async () => {
		const factory = createMockWorkerFactory();
		const logger = createMockLogger();
		const pool = new PoolManager('unified-test', {
			minProcs: 5,
			maxProcs: 20,
			maxWorkers: 1,
		}, factory, logger);

		await pool.initialize();

		// Spawn extra items
		for (let i = 0; i < 10; i++) {
			await pool.spawnItem();
		}
		assertEquals(pool.items.size, 15);

		// Decrease limits
		await pool.updateConfig({
			minProcs: 2,
			maxProcs: 10,
			maxWorkers: 1,
			idleTimeout: 1, // Fast timeout for testing
		});

		// Wait for idle timeout and scaling
		await delay(1500);
		await pool.performScaling();

		// Should scale down to new maximum (10)
		assertEquals(pool.items.size <= 10, true);

		await pool.shutdown(1);
	});
});

