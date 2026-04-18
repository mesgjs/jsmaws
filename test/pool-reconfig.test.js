/**
 * Tests for Pool Reconfiguration
 * 
 * Tests the pool lifecycle management during configuration reloads:
 * - Default pool application on reconfig
 * - Pool addition (parallel)
 * - Pool removal (parallel with timeout)
 * - Pool reconfiguration (synchronous)
 * - Affinity map cleanup
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { OperatorProcess, ServerConfig } from "../src/operator.esm.js";
import { Configuration } from "../src/configuration.esm.js";
import { NANOS, parseSLID } from '@nanos';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a mock process manager for testing
 */
function createMockProcessManager (operator) {
	const processes = new Map();
	let processCounter = 0;

	return {
		processes,
		createProcess: async (processId, type, poolName, poolConfig) => {
			processCounter++;
			const mockProcess = {
				id: processId,
				type,
				poolName,
				state: 'ready',
				availableWorkers: 1,
				totalWorkers: 1,
				ipcConn: {
					setRequestHandler: () => {},
					clearRequestHandler: () => {},
					writeMessage: async () => {}
				},
				shutdown: async (timeout) => {
					// Simulate graceful shutdown
					await new Promise(resolve => setTimeout(resolve, 0));
				}
			};
			processes.set(processId, mockProcess);
			return {
				item: mockProcess,
				isWorker: false
			};
		},
		sendConfigUpdate: async (proc) => {
			// Mock config update
		},
		broadcastConfigUpdate: async () => {
			// Mock broadcast config update
		},
		shutdown: async (timeout) => {
			// Mock shutdown
		},
		healthCheck: async () => {
			// Mock health check
		}
	};
}

/**
 * Create an OperatorProcess with a Configuration from a SLID string
 */
function makeOperator (slidStr) {
	const config = new ServerConfig({ noSSL: true });
	const operator = new OperatorProcess(config);
	if (slidStr) {
		const nanos = parseSLID(slidStr);
		operator.configData = nanos;
		operator.configuration = new Configuration(nanos);
	}
	return operator;
}

/**
 * Wait for async operations to complete
 */
async function waitForAsync (ms = 50) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Default Pool Application Tests
// ============================================================================

Deno.test("Pool Reconfig - applies default pool when pools section missing", async () => {
	const operator = makeOperator(null);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with default pools (no pools in config → defaults applied)
	await operator.initializeProcessPools();

	// Verify default pool was created
	assertExists(operator.poolManagers.get('standard'));

	// Create new config without pools section
	const newConfig = new NANOS({
		httpPort: 9090,
		httpsPort: 9443
	});

	// Handle config update
	await operator.handleConfigUpdate(newConfig);

	// Verify default pool config was applied to configuration.config.pools
	assertExists(operator.configuration.config.pools);
	assertExists(operator.configuration.config.pools.standard);

	// Verify pool manager still exists
	assertExists(operator.poolManagers.get('standard'));

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

Deno.test("Pool Reconfig - applies default pool when pools section is omitted", async () => {
	const operator = makeOperator(null);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with default pools
	await operator.initializeProcessPools();

	// Create new config with pools section explicitly null
	const newConfig = new NANOS({
		httpPort: 9090,
		httpsPort: 9443,
		pools: null
	});

	// Handle config update
	await operator.handleConfigUpdate(newConfig);

	// Verify default pool config was applied to configuration.config.pools
	assertExists(operator.configuration.config.pools);
	assertExists(operator.configuration.config.pools.standard);

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

Deno.test("Pool Reconfig - uses provided pools config when present", async () => {
	const operator = makeOperator(null);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with default pools
	await operator.initializeProcessPools();

	// Create new config with custom pools
	const newConfig = parseSLID(`[(
		httpPort=9090 httpsPort=9443
		logging=[level=debug]
		pools=[
			fast=[minProcs=2 maxProcs=10]
			slow=[minProcs=1 maxProcs=5]
		]
	)]`);

	// Handle config update
	await operator.handleConfigUpdate(newConfig);

	// Verify custom pools config was used (not defaults)
	assertExists(operator.configuration.config.pools.fast);
	assertExists(operator.configuration.config.pools.slow);
	assertEquals(operator.configuration.config.pools.fast.minProcs, 2);
	assertEquals(operator.configuration.config.pools.slow.minProcs, 1);

	// Wait for pool creation
	await waitForAsync(100);

	// Verify pool managers were created
	assertExists(operator.poolManagers.get('fast'));
	assertExists(operator.poolManagers.get('slow'));

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

// ============================================================================
// Pool Lifecycle Management Tests
// ============================================================================

Deno.test("Pool Reconfig - adds new pools in parallel", async () => {
	const operator = makeOperator(`[(
		pools=[poolA=[minProcs=1 maxProcs=5]]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with poolA
	await operator.initializeProcessPools();
	assertExists(operator.poolManagers.get('poolA'));
	assertEquals(operator.poolManagers.size, 1);

	// Add poolB and poolC
	const newConfig = parseSLID(`[(
		pools=[
			poolA=[minProcs=1 maxProcs=5]
			poolB=[minProcs=2 maxProcs=10]
			poolC=[minProcs=1 maxProcs=1]
		]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify all three pools exist
	assertExists(operator.poolManagers.get('poolA'));
	assertExists(operator.poolManagers.get('poolB'));
	assertExists(operator.poolManagers.get('poolC'));
	assertEquals(operator.poolManagers.size, 3);

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

Deno.test("Pool Reconfig - removes old pools in parallel", async () => {
	const operator = makeOperator(`[(
		pools=[
			poolA=[minProcs=1 maxProcs=5]
			poolB=[minProcs=1 maxProcs=5]
			poolC=[minProcs=1 maxProcs=5]
		]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with three pools
	await operator.initializeProcessPools();
	assertEquals(operator.poolManagers.size, 3);

	// Remove poolB and poolC, keep poolA
	const newConfig = parseSLID(`[(
		pools=[poolA=[minProcs=1 maxProcs=5]]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify only poolA remains
	assertExists(operator.poolManagers.get('poolA'));
	assertEquals(operator.poolManagers.get('poolB'), undefined);
	assertEquals(operator.poolManagers.get('poolC'), undefined);
	assertEquals(operator.poolManagers.size, 1);

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

Deno.test("Pool Reconfig - reconfigures existing pools synchronously", async () => {
	const operator = makeOperator(`[(
		pools=[poolA=[minProcs=1 maxProcs=5]]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with poolA
	await operator.initializeProcessPools();
	const originalPoolManager = operator.poolManagers.get('poolA');
	assertExists(originalPoolManager);
	assertEquals(originalPoolManager.config.minProcs, 1);
	assertEquals(originalPoolManager.config.maxProcs, 5);

	// Reconfigure poolA with different limits
	const newConfig = parseSLID(`[(
		pools=[poolA=[minProcs=2 maxProcs=10]]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify same pool manager instance (not replaced)
	const updatedPoolManager = operator.poolManagers.get('poolA');
	assertEquals(updatedPoolManager, originalPoolManager);

	// Verify config was updated
	assertEquals(updatedPoolManager.config.minProcs, 2);
	assertEquals(updatedPoolManager.config.maxProcs, 10);

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

Deno.test("Pool Reconfig - handles mixed add/remove/reconfig", async () => {
	const operator = makeOperator(`[(
		pools=[
			poolA=[minProcs=1 maxProcs=5]
			poolB=[minProcs=1 maxProcs=5]
		]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize with poolA and poolB
	await operator.initializeProcessPools();
	assertEquals(operator.poolManagers.size, 2);
	const originalPoolA = operator.poolManagers.get('poolA');

	// Reconfig: keep poolA (modified), remove poolB, add poolC
	const newConfig = parseSLID(`[(
		pools=[
			poolA=[minProcs=2 maxProcs=10]
			poolC=[minProcs=3 maxProcs=3]
		]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify results
	assertExists(operator.poolManagers.get('poolA'));
	assertEquals(operator.poolManagers.get('poolA'), originalPoolA); // Same instance
	assertEquals(operator.poolManagers.get('poolA').config.minProcs, 2); // Updated config
	assertEquals(operator.poolManagers.get('poolB'), undefined); // Removed
	assertExists(operator.poolManagers.get('poolC')); // Added
	assertEquals(operator.poolManagers.size, 2);

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

// ============================================================================
// Affinity Map Cleanup Tests
// ============================================================================

Deno.test("Pool Reconfig - cleans up affinity map for removed pools", async () => {
	const operator = makeOperator(`[(
		pools=[
			poolA=[minProcs=1 maxProcs=5 maxWorkers=1]
			poolB=[minProcs=1 maxProcs=5 maxWorkers=1]
		]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize pools
	await operator.initializeProcessPools();

	// Get pool managers
	const poolA = operator.poolManagers.get('poolA');
	const poolB = operator.poolManagers.get('poolB');

	// Get items from each pool to simulate affinity tracking
	const itemA1 = await poolA.getAvailableItem();
	const itemA2 = await poolA.getAvailableItem();
	const itemA3 = await poolA.getAvailableItem();
	const itemB1 = await poolB.getAvailableItem();
	const itemB2 = await poolB.getAvailableItem();
	const itemB3 = await poolB.getAvailableItem();

	assert(itemA1);
	assert(itemA2);
	assert(itemA3);
	assert(itemB1);
	assert(itemB2);
	assert(itemB3);

	// Use updateAffinity to properly register shutdown subscriptions
	operator.updateAffinity(itemA1, '/app1.js');
	operator.updateAffinity(itemA2, '/app1.js');
	operator.updateAffinity(itemA3, '/app3.js');
	operator.updateAffinity(itemB1, '/app2.js');
	operator.updateAffinity(itemB2, '/app2.js');
	operator.updateAffinity(itemB3, '/app3.js');

	// Verify affinity map was populated
	assertEquals(operator.affinityMap.size, 3);
	assertEquals(operator.affinityMap.get('/app1.js').size, 2);
	assertEquals(operator.affinityMap.get('/app2.js').size, 2);
	assertEquals(operator.affinityMap.get('/app3.js').size, 2);

	// Remove poolB
	const newConfig = parseSLID(`[(
		pools=[poolA=[minProcs=1 maxProcs=5 maxWorkers=1]]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify affinity map cleanup
	// /app1.js should still have poolA entries
	assertExists(operator.affinityMap.get('/app1.js'));
	assertEquals(operator.affinityMap.get('/app1.js').size, 2);

	// /app2.js should have no entries (only had poolB entries)
	assertEquals(operator.affinityMap.get('/app2.js').size, 0);

	// /app3.js should only have poolA entry (poolB entry removed)
	assertExists(operator.affinityMap.get('/app3.js'));
	assertEquals(operator.affinityMap.get('/app3.js').size, 1);
	assert(operator.affinityMap.get('/app3.js').has(itemA3.id));
	assert(!operator.affinityMap.get('/app3.js').has(itemB3.id));

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

// ============================================================================
// Shutdown Timeout Tests
// ============================================================================

Deno.test("Pool Reconfig - respects shutdown timeout", async () => {
	const operator = makeOperator(`[(
		shutdownDelay=1
		pools=[poolA=[minProcs=1 maxProcs=5]]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize pool
	await operator.initializeProcessPools();

	// Remove pool (should timeout after shutdownDelay + 5s grace)
	const newConfig = parseSLID(`[(
		shutdownDelay=1
		pools=[]
	)]`);

	const startTime = Date.now();
	await operator.handleConfigUpdate(newConfig);
	const duration = Date.now() - startTime;

	// Should complete within timeout window (1s + 5s grace + some overhead)
	assert(duration < 7000, `Shutdown took ${duration}ms, expected < 7000ms`);

	// Pool should be removed
	assertEquals(operator.poolManagers.get('poolA'), undefined);
});

// ============================================================================
// Router Pool Skip Tests
// ============================================================================

Deno.test("Pool Reconfig - skips @router pool in lifecycle management", async () => {
	const operator = makeOperator(`[(
		pools=[
			@router=[minProcs=1 maxProcs=5]
			poolA=[minProcs=1 maxProcs=5]
		]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize pools (should skip @router)
	await operator.initializeProcessPools();
	assertEquals(operator.poolManagers.get('@router'), undefined);
	assertExists(operator.poolManagers.get('poolA'));

	// Reconfig with @router still present
	const newConfig = parseSLID(`[(
		pools=[
			@router=[minProcs=2 maxProcs=10]
			poolB=[minProcs=1 maxProcs=5]
		]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify @router still skipped, poolA removed, poolB added
	assertEquals(operator.poolManagers.get('@router'), undefined);
	assertEquals(operator.poolManagers.get('poolA'), undefined);
	assertExists(operator.poolManagers.get('poolB'));

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

// ============================================================================
// Error Handling Tests
// ============================================================================

Deno.test("Pool Reconfig - continues on pool creation failure", async () => {
	const operator = makeOperator(`[(
		pools=[poolA=[minProcs=1 maxProcs=5]]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();

	// Create mock that fails for poolB
	const mockProcessManager = createMockProcessManager(operator);
	const originalCreate = mockProcessManager.createProcess;
	mockProcessManager.createProcess = async (processId, type, poolName, poolConfig) => {
		if (poolName === 'poolB') {
			throw new Error('Simulated pool creation failure');
		}
		return await originalCreate(processId, type, poolName, poolConfig);
	};
	operator.processManager = mockProcessManager;

	// Initialize with poolA
	await operator.initializeProcessPools();

	// Try to add poolB (will fail) and poolC (should succeed)
	const newConfig = parseSLID(`[(
		pools=[
			poolA=[minProcs=1 maxProcs=5]
			poolB=[minProcs=1 maxProcs=5]
			poolC=[minProcs=1 maxProcs=5]
		]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify poolA and poolC exist, poolB does not
	assertExists(operator.poolManagers.get('poolA'));
	assertEquals(operator.poolManagers.get('poolB'), undefined);
	assertExists(operator.poolManagers.get('poolC'));

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});

Deno.test("Pool Reconfig - continues on pool reconfiguration failure", async () => {
	const operator = makeOperator(`[(
		pools=[
			poolA=[minProcs=1 maxProcs=5]
			poolB=[minProcs=1 maxProcs=5]
		]
	)]`);
	operator.initializeLogger();
	operator.initializeRouter();
	operator.processManager = createMockProcessManager(operator);

	// Initialize pools
	await operator.initializeProcessPools();

	// Mock poolA.updateConfig to throw error
	const poolA = operator.poolManagers.get('poolA');
	poolA.updateConfig = (newConfig) => {
		throw new Error('Simulated reconfig failure');
	};

	// Try to reconfigure both pools (poolA will fail, poolB should succeed)
	const newConfig = parseSLID(`[(
		pools=[
			poolA=[minProcs=2 maxProcs=10]
			poolB=[minProcs=2 maxProcs=10]
		]
	)]`);

	await operator.handleConfigUpdate(newConfig);
	await waitForAsync(100);

	// Verify both pools still exist
	assertExists(operator.poolManagers.get('poolA'));
	assertExists(operator.poolManagers.get('poolB'));

	// Verify poolB was reconfigured (poolA was not due to error)
	assertEquals(operator.poolManagers.get('poolB').config.minProcs, 2);

	// Cleanup
	for (const [poolName, poolManager] of operator.poolManagers) {
		await poolManager.shutdown(5);
	}
});
