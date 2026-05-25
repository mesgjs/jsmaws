/**
 * Tests for RouterProcess
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { RouterProcess } from '../src/router-process.esm.js';
import { Configuration } from '../src/configuration.esm.js';
import { NANOS, parseSLID } from '@nanos';

// ============================================================================
// Helper: minimal Configuration for testing
// ============================================================================

function makeConfig (extra = {}) {
	return new Configuration({
		pools: {
			'@router': {
				minProcs: 1,
				maxProcs: 5,
				maxReqs: 0,
				idleTimeout: 300,
				reqTimeout: 30,
			},
			standard: {
				minProcs: 2,
				maxProcs: 10,
			}
		},
		routes: [
			{ path: 'api/@*', pool: 'standard' }
		],
		fsRouting: true,
		appRoot: '/test/apps',
		extensions: ['.esm.js', '.js'],
		...extra,
	});
}

// ============================================================================
// Constructor Tests
// ============================================================================

Deno.test('RouterProcess - constructor initializes correctly', () => {
	const proc = new RouterProcess('router-test-1');

	assertEquals(proc.processType, 'router');
	assertEquals(proc.processId, 'router-test-1');
	assertEquals(proc.poolManager, null);
	assertExists(proc.workerUrl);
});

// ============================================================================
// handleConfigUpdate Tests
// ============================================================================

Deno.test('RouterProcess - handleConfigUpdate updates pool manager config', async () => {
	const proc = new RouterProcess('router-test-2');

	// Create a mock pool manager
	let updateConfigCalled = false;
	let lastPoolConfig = null;
	proc.poolManager = {
		items: new Map(),
		updateConfig: async (cfg) => {
			updateConfigCalled = true;
			lastPoolConfig = cfg;
		},
	};

	// Base class sets proc.config before calling handleConfigUpdate()
	proc.config = makeConfig({ fsRouting: false });
	await proc.handleConfigUpdate();

	// Pool manager should have been updated
	assertEquals(updateConfigCalled, true);
	// The @router pool config should have been passed
	assertExists(lastPoolConfig);
});

Deno.test('RouterProcess - handleConfigUpdate with no pool manager is a no-op', async () => {
	const proc = new RouterProcess('router-test-3');
	proc.config = makeConfig();
	proc.poolManager = null;

	// Should not throw
	await proc.handleConfigUpdate();
});

// ============================================================================
// handleShutdown Tests
// ============================================================================

Deno.test('RouterProcess - handleShutdown sets isShuttingDown and calls pool shutdown', async () => {
	const proc = new RouterProcess('router-test-4');
	proc.config = makeConfig();

	let poolShutdownCalled = false;
	let poolShutdownDeadline = null;
	let poolShutdownSpread = null;
	proc.poolManager = {
		shutdown: async (deadline, spread) => {
			poolShutdownCalled = true;
			poolShutdownDeadline = deadline;
			poolShutdownSpread = spread;
		},
	};

	// Mock transport
	let transportStopped = false;
	proc.transport = {
		stop: async () => { transportStopped = true; },
	};

	// Mock Deno.exit to prevent actual exit
	const originalExit = Deno.exit;
	let exitCode = null;
	Deno.exit = (code) => { exitCode = code; };

	try {
		// Create a mock PolyTransport message with shutdown payload
		const msgDeadline = Date.now() + 5000;
		const mockMsg = {
			text: JSON.stringify({ deadline: msgDeadline, spread: 2 }),
			done: () => {},
			process: () => {},
		};

		await proc.handleShutdown(mockMsg);

		assertEquals(proc.isShuttingDown, true);
		assertEquals(poolShutdownCalled, true);
		assertEquals(poolShutdownDeadline, msgDeadline);
		assertEquals(poolShutdownSpread, 2);
		assertEquals(transportStopped, true);
		assertEquals(exitCode, 0);
	} finally {
		Deno.exit = originalExit;
	}
});

Deno.test('RouterProcess - handleShutdown with null msg uses config defaults', async () => {
	const proc = new RouterProcess('router-test-5');
	proc.config = makeConfig();

	let poolShutdownDeadline = null;
	proc.poolManager = {
		shutdown: async (deadline) => { poolShutdownDeadline = deadline; },
	};
	proc.transport = { stop: async () => {} };

	const originalExit = Deno.exit;
	Deno.exit = () => {};

	try {
		const before = Date.now();
		await proc.handleShutdown(null);
		const after = Date.now();
		// Default shutdownDelay is 30s; deadline should be ~30s from now
		assertEquals(poolShutdownDeadline >= before + 29000, true, 'deadline should be ~30s from now');
		assertEquals(poolShutdownDeadline <= after + 31000, true, 'deadline should be ~30s from now');
	} finally {
		Deno.exit = originalExit;
	}
});

// ============================================================================
// handleHealthCheck Tests
// ============================================================================

Deno.test('RouterProcess - handleHealthCheck sends health-response via control channel', async () => {
	const proc = new RouterProcess('router-test-6');
	proc.config = makeConfig();

	// Mock pool manager with metrics
	proc.poolManager = {
		getMetrics: () => ({ availableItems: 2, totalItems: 3 }),
	};

	// Mock control channel
	const writtenMessages = [];
	proc.controlChannel = {
		write: async (type, data) => {
			writtenMessages.push({ type, data });
		},
	};

	// Mock sendCapacityUpdate
	let capacityUpdateCalled = false;
	proc.sendCapacityUpdate = async (avail, total) => {
		capacityUpdateCalled = true;
	};

	// Create a mock PolyTransport message
	const mockMsg = { text: JSON.stringify({ timestamp: Date.now() }) };
	await proc.handleHealthCheck(mockMsg);

	// Verify health-response was written
	assertEquals(writtenMessages.length, 1);
	assertEquals(writtenMessages[0].type, 'health-response');
	const responseData = JSON.parse(writtenMessages[0].data);
	assertEquals(responseData.status, 'ok');
	assertEquals(responseData.availableWorkers, 2);
	assertEquals(responseData.totalWorkers, 3);
	assertExists(responseData.uptime);
	assertEquals(capacityUpdateCalled, true);
});

Deno.test('RouterProcess - handleHealthCheck with no pool manager uses zero metrics', async () => {
	const proc = new RouterProcess('router-test-7');
	proc.config = makeConfig();
	proc.poolManager = null;

	const writtenMessages = [];
	proc.controlChannel = {
		write: async (type, data) => { writtenMessages.push({ type, data }); },
	};
	proc.sendCapacityUpdate = async () => {};

	await proc.handleHealthCheck({ text: '{}' });

	assertEquals(writtenMessages.length, 1);
	const responseData = JSON.parse(writtenMessages[0].data);
	assertEquals(responseData.availableWorkers, 0);
	assertEquals(responseData.totalWorkers, 0);
});

// ============================================================================
// onStarted Tests
// ============================================================================

Deno.test('RouterProcess - onStarted initializes pool manager', async () => {
	const proc = new RouterProcess('router-test-8');
	proc.config = makeConfig();

	// Mock logger (required by PoolManager)
	proc.logger = {
		info: () => {},
		debug: () => {},
		warn: () => {},
		error: () => {},
	};

	assertEquals(proc.poolManager, null);

	await proc.onStarted();

	assertExists(proc.poolManager);

	// Clean up to prevent resource leaks
	await proc.poolManager.shutdown(Date.now());
});
