/**
 * Pool Manager Tests
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PoolManager, ItemState, ScalingStrategy } from '../src/pool-manager.esm.js';

// Mock worker factory
function createMockWorkerFactory() {
	let workerCount = 0;
	return async (itemId) => {
		workerCount++;
		const mockWorker = {
			id: itemId,
			terminate: () => {},
			postMessage: () => {},
		};
		return { item: mockWorker, isWorker: true };
	};
}

// Mock process factory
function createMockProcessFactory() {
	let processCount = 0;
	return async (itemId) => {
		processCount++;
		const mockProcess = {
			id: itemId,
			shutdown: async () => {},
		};
		return { item: mockProcess, isWorker: false };
	};
}

// Helper to wait for async operations
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test('PoolManager - Configuration Validation', async (t) => {
	await t.step('should validate minProcs >= 0', () => {
		const factory = createMockWorkerFactory();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: -1, maxProcs: 10 }, factory);
			},
			Error,
			'Invalid minProcs'
		);
	});

	await t.step('should validate maxProcs > 0', () => {
		const factory = createMockWorkerFactory();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 0, maxProcs: 0 }, factory);
			},
			Error,
			'Invalid maxProcs'
		);
	});

	await t.step('should validate minProcs <= maxProcs', () => {
		const factory = createMockWorkerFactory();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 10, maxProcs: 5 }, factory);
			},
			Error,
			'minProcs'
		);
	});

	await t.step('should validate static scaling requires minProcs == maxProcs', () => {
		const factory = createMockWorkerFactory();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 2, maxProcs: 10, scaling: 'static' }, factory);
			},
			Error,
			'Static scaling'
		);
	});

	await t.step('should validate minWorkers >= 1', () => {
		const factory = createMockWorkerFactory();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 1, maxProcs: 10, minWorkers: 0 }, factory);
			},
			Error,
			'Invalid minWorkers'
		);
	});

	await t.step('should validate maxWorkers >= minWorkers', () => {
		const factory = createMockWorkerFactory();
		assertRejects(
			async () => {
				new PoolManager('test', { minProcs: 1, maxProcs: 10, minWorkers: 4, maxWorkers: 2 }, factory);
			},
			Error,
			'maxWorkers'
		);
	});

	await t.step('should accept valid configuration', () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('test', {
			minProcs: 2,
			maxProcs: 10,
			scaling: 'dynamic',
			minWorkers: 1,
			maxWorkers: 4,
		}, factory);
		assertEquals(pool.config.minProcs, 2);
		assertEquals(pool.config.maxProcs, 10);
		assertEquals(pool.config.scaling, 'dynamic');
	});
});

Deno.test('PoolManager - Static Scaling', async (t) => {
	await t.step('should spawn exactly minProcs items', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('static-test', {
			minProcs: 3,
			maxProcs: 3,
			scaling: 'static',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 3);

		await pool.shutdown(1);
	});

	await t.step('should not scale up or down', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('static-test', {
			minProcs: 2,
			maxProcs: 2,
			scaling: 'static',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 2);

		// Try to get more items than available
		const item1 = await pool.getAvailableItem();
		const item2 = await pool.getAvailableItem();
		const item3 = await pool.getAvailableItem();

		assertEquals(item3, null); // Should not spawn new item
		assertEquals(pool.items.size, 2);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Dynamic Scaling', async (t) => {
	await t.step('should spawn minProcs items on initialization', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('dynamic-test', {
			minProcs: 2,
			maxProcs: 10,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 2);

		await pool.shutdown(1);
	});

	await t.step('should scale up when all items busy', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('dynamic-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 1);

		// Get first item
		const item1 = await pool.getAvailableItem();
		assertEquals(item1 !== null, true);
		pool.markItemBusy(item1.id);

		// Should spawn new item
		const item2 = await pool.getAvailableItem();
		assertEquals(item2 !== null, true);
		assertEquals(pool.items.size, 2);

		await pool.shutdown(1);
	});

	await t.step('should not exceed maxProcs', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('dynamic-test', {
			minProcs: 1,
			maxProcs: 2,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();

		const item1 = await pool.getAvailableItem();
		pool.markItemBusy(item1.id);

		const item2 = await pool.getAvailableItem();
		pool.markItemBusy(item2.id);

		const item3 = await pool.getAvailableItem();
		assertEquals(item3, null); // At max capacity

		await pool.shutdown(1);
	});

	await t.step('should scale down idle items after timeout', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('dynamic-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
			idleTimeout: 1, // 1 second for testing
		}, factory);

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

Deno.test('PoolManager - OnDemand Scaling', async (t) => {
	await t.step('should start with 0 items', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('ondemand-test', {
			minProcs: 0,
			maxProcs: 10,
			scaling: 'ondemand',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 0);

		await pool.shutdown(1);
	});

	await t.step('should spawn items on demand', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('ondemand-test', {
			minProcs: 0,
			maxProcs: 10,
			scaling: 'ondemand',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 0);

		const item = await pool.getAvailableItem();
		assertEquals(item !== null, true);
		assertEquals(pool.items.size, 1);

		await pool.shutdown(1);
	});

	await t.step('should kill idle items after timeout', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('ondemand-test', {
			minProcs: 0,
			maxProcs: 10,
			scaling: 'ondemand',
			idleTimeout: 1, // 1 second for testing
		}, factory);

		await pool.initialize();

		// Spawn item
		const item = await pool.getAvailableItem();
		assertEquals(pool.items.size, 1);

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
		const pool = new PoolManager('lifecycle-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.state, ItemState.IDLE);
		assertEquals(item.isAvailable(), true);

		pool.markItemBusy(item.id);
		assertEquals(item.state, ItemState.BUSY);
		assertEquals(item.isAvailable(), false);

		await pool.markItemIdle(item.id);
		assertEquals(item.state, ItemState.IDLE);
		assertEquals(item.isAvailable(), true);

		await pool.shutdown(1);
	});

	await t.step('should recycle items after maxReqs', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('lifecycle-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
			maxReqs: 3,
		}, factory);

		await pool.initialize();
		const initialSize = pool.items.size;

		const item = await pool.getAvailableItem();
		const itemId = item.id;

		// Process 3 requests
		for (let i = 0; i < 3; i++) {
			pool.markItemBusy(itemId);
			await pool.markItemIdle(itemId);
		}

		// Item should be recycled and replaced
		assertEquals(pool.items.has(itemId), false);
		assertEquals(pool.items.size, initialSize); // Replaced

		await pool.shutdown(1);
	});

	await t.step('should track request count', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('lifecycle-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.requestCount, 0);

		pool.markItemBusy(item.id);
		await pool.markItemIdle(item.id);
		assertEquals(item.requestCount, 1);

		pool.markItemBusy(item.id);
		await pool.markItemIdle(item.id);
		assertEquals(item.requestCount, 2);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Metrics', async (t) => {
	await t.step('should track pool metrics', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('metrics-test', {
			minProcs: 2,
			maxProcs: 10,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();

		const metrics = pool.getMetrics();
		assertEquals(metrics.poolName, 'metrics-test');
		assertEquals(metrics.totalItems, 2);
		assertEquals(metrics.availableItems, 2);
		assertEquals(metrics.busyItems, 0);
		assertEquals(metrics.totalSpawned, 2);

		// Get and mark item busy
		const item = await pool.getAvailableItem();
		pool.markItemBusy(item.id);

		const metrics2 = pool.getMetrics();
		assertEquals(metrics2.availableItems, 1);
		assertEquals(metrics2.busyItems, 1);
		assertEquals(metrics2.totalRequests, 1);

		await pool.shutdown(1);
	});

	await t.step('should track spawned and recycled counts', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('metrics-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
			maxReqs: 2,
		}, factory);

		await pool.initialize();
		assertEquals(pool.metrics.totalSpawned, 1);
		assertEquals(pool.metrics.totalRecycled, 0);

		const item = await pool.getAvailableItem();

		// Trigger recycling
		pool.markItemBusy(item.id);
		await pool.markItemIdle(item.id);
		pool.markItemBusy(item.id);
		await pool.markItemIdle(item.id);

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
		const pool = new PoolManager('config-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();
		assertEquals(pool.config.minProcs, 1);
		assertEquals(pool.config.maxProcs, 5);

		await pool.updateConfig({
			minProcs: 2,
			maxProcs: 10,
			scaling: 'dynamic',
		});

		assertEquals(pool.config.minProcs, 2);
		assertEquals(pool.config.maxProcs, 10);
		assertEquals(pool.items.size, 2); // Should spawn to meet minProcs

		await pool.shutdown(1);
	});

	await t.step('should handle scaling strategy change', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('config-test', {
			minProcs: 2,
			maxProcs: 10,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();
		assertEquals(pool.scaleTimer !== null, true);

		await pool.updateConfig({
			minProcs: 2,
			maxProcs: 2,
			scaling: 'static',
		});

		assertEquals(pool.config.scaling, 'static');
		assertEquals(pool.scaleTimer, null); // Timer should be stopped

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Worker vs Process Pools', async (t) => {
	await t.step('should handle worker pools', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('worker-test', {
			minProcs: 2,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.isWorker, true);

		await pool.shutdown(1);
	});

	await t.step('should handle process pools', async () => {
		const factory = createMockProcessFactory();
		const pool = new PoolManager('process-test', {
			minProcs: 2,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();

		const item = await pool.getAvailableItem();
		assertEquals(item.isWorker, false);

		await pool.shutdown(1);
	});
});

Deno.test('PoolManager - Shutdown', async (t) => {
	await t.step('should gracefully shutdown all items', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('shutdown-test', {
			minProcs: 3,
			maxProcs: 10,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();
		assertEquals(pool.items.size, 3);

		await pool.shutdown(1);
		assertEquals(pool.items.size, 0);
		assertEquals(pool.isShuttingDown, true);
	});

	await t.step('should prevent spawning during shutdown', async () => {
		const factory = createMockWorkerFactory();
		const pool = new PoolManager('shutdown-test', {
			minProcs: 1,
			maxProcs: 5,
			scaling: 'dynamic',
		}, factory);

		await pool.initialize();
		pool.isShuttingDown = true;

		await assertRejects(
			async () => await pool.spawnItem(),
			Error,
			'shutting down'
		);
	});
});