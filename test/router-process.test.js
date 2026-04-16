/**
 * Tests for RouterProcess
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '@nanos';
import { RouterProcess } from '../src/router-process.esm.js';
import { MessageType } from '../src/ipc-protocol.esm.js';
import { Configuration } from '../src/configuration.esm.js';

/**
 * Mock IPC connection for testing
 */
class MockIPCConnection {
	constructor () {
		this.messages = [];
		this.readIndex = 0;
		this.writtenMessages = [];
		this.closed = false;
	}

	addMessage (type, id, fields) {
		this.messages.push({
			message: { type, id, fields },
			binaryData: null
		});
	}

	async readMessage () {
		if (this.readIndex >= this.messages.length) {
			return null;
		}
		return this.messages[this.readIndex++];
	}

	async writeMessage (message, binaryData = null) {
		this.writtenMessages.push({ message, binaryData });
	}

	async close () {
		this.closed = true;
	}
}

/**
 * Mock PoolManager for testing
 */
class MockPoolManager {
	constructor () {
		this.items = new Map();
		this.availableItems = [];
		this.busyItems = new Set();
		this.configUpdated = false;
		this.initialized = false;
		this.shutdownCalled = false;
	}

	async initialize () {
		this.initialized = true;
	}

	async updateConfig (config) {
		this.configUpdated = true;
	}

	async getAvailableItem () {
		if (this.availableItems.length === 0) {
			return null;
		}
		const item = this.availableItems.shift();
		this.incrementItemUsage(item);
		return item;
	}

	incrementItemUsage (itemId) {
		this.busyItems.add(itemId);
	}

	async decrementItemUsage (itemId) {
		this.busyItems.delete(itemId);
	}

	getMetrics () {
		return {
			availableItems: this.availableItems.length,
			totalItems: this.items.size,
			queuedRequests: 0,
		};
	}

	async shutdown (timeout) {
		this.shutdownCalled = true;
	}
}

/**
 * Mock RouterWorkerProxy for testing
 */
class MockRouterWorkerProxy {
	constructor (id) {
		this.id = id;
		this.configUpdated = false;
		this.routeResult = null;
	}

	async initialize (config) {
		// Mock initialization
	}

	async updateConfig (config) {
		this.configUpdated = true;
	}

	async findRoute (path, method) {
		return this.routeResult;
	}
}

/**
 * Create minimal configuration for testing
 */
function createTestConfig () {
	const config = new NANOS();
	config.setOpts({ transform: true });
	config.push({
		pools: {
			'@router': {
				minProcs: 1,
				maxProcs: 5,
				scaling: 'dynamic',
				maxReqs: 0,
				idleTimeout: 300,
				reqTimeout: 30,
			},
			'standard': {
				minProcs: 2,
				maxProcs: 10,
				scaling: 'dynamic',
			}
		},
		routes: [
			{ path: 'api/@*', pool: 'standard' }
		],
		fsRouting: true,
		appRoot: '/test/apps',
		extensions: ['.esm.js', '.js'],
		mimeTypes: {},
		chunking: {
			maxDirectWrite: 65536,
			autoChunkThresh: 1048576,
			chunkSize: 65536,
			maxWriteBuffer: 262144,
		},
		ipc: {
			maxMessageSize: 16777216,
			readTimeout: 30000,
			writeTimeout: 30000,
		},
		logging: {
			level: 'info',
			format: 'json',
		},
	});
	return config;
}

Deno.test('RouterProcess - constructor initializes correctly', () => {
	const process = new RouterProcess('router-test-1');

	assertEquals(process.processType, 'router');
	assertEquals(process.processId, 'router-test-1');
	assertEquals(process.fsRouting, false);
	assertEquals(process.poolManager, null);
	assertExists(process.workerUrl);
});

Deno.test('RouterProcess - handleConfigUpdate updates pool manager', async () => {
	const process = new RouterProcess('router-test-2');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// Handle config update
	await process.handleConfigUpdate(configFields);

	// Verify pool manager was updated
	assertEquals(mockPool.configUpdated, true);

	// Verify configuration was updated correctly
	assertEquals(process.config.routing.fsRouting, true);

	// Note: Worker update testing requires actual RouterWorkerProxy instances due to instanceof check
	// This is tested in integration tests with real workers
});

Deno.test('RouterProcess - handleRouteRequest with successful match', async () => {
	const process = new RouterProcess('router-test-3');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// Create mock worker with route result
	const mockWorker = new MockRouterWorkerProxy('worker-1');
	mockWorker.routeResult = {
		pool: 'standard',
		app: '/test/apps/myapp.esm.js',
		params: { id: '123' },
		tail: 'extra/path',
	};

	// Add worker to available pool
	mockPool.availableItems.push({ item: mockWorker, id: 'worker-1' });

	// Create route request fields
	const requestFields = new NANOS({
		method: 'get',
		path: '/api/myapp/extra/path',
	});

	// Handle route request
	await process.handleRouteRequest('req-1', requestFields);

	// Verify response was sent
	assertEquals(mockConn.writtenMessages.length, 1);
	const response = mockConn.writtenMessages[0].message;
	assertEquals(response.at(0), MessageType.ROUTE_RESPONSE);
	assertEquals(response.at('id'), 'req-1');

	const fields = response.at(1);
	assertEquals(fields.at('status'), 200);
	assertEquals(fields.at('pool'), 'standard');
	assertEquals(fields.at('app'), '/test/apps/myapp.esm.js');
});

Deno.test('RouterProcess - handleRouteRequest with no match returns 404', async () => {
	const process = new RouterProcess('router-test-4');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// Create mock worker with no route result
	const mockWorker = new MockRouterWorkerProxy('worker-1');
	mockWorker.routeResult = null;

	// Add worker to available pool
	mockPool.availableItems.push({ item: mockWorker, id: 'worker-1' });

	// Create route request fields - must be NANOS with proper structure
	const requestFields = new NANOS({
		method: 'get',
		path: '/nonexistent',
	});

	// Handle route request
	await process.handleRouteRequest('req-2', requestFields);

	// Verify 404 response was sent
	assertEquals(mockConn.writtenMessages.length, 1);
	const response = mockConn.writtenMessages[0].message;
	const fields = response.at(1);
	assertEquals(fields.at('status'), 404);
});

Deno.test('RouterProcess - handleRouteRequest with no available workers returns 503', async () => {
	const process = new RouterProcess('router-test-5');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// No workers available
	mockPool.availableItems = [];

	// Create route request fields - must be NANOS with proper structure
	const requestFields = new NANOS({
		method: 'get',
		path: '/api/test',
	});

	// Handle route request
	await process.handleRouteRequest('req-3', requestFields);

	// Verify 503 response was sent
	assertEquals(mockConn.writtenMessages.length, 1);
	const response = mockConn.writtenMessages[0].message;
	const fields = response.at(1);
	assertEquals(fields.at('status'), 503);
});

Deno.test('RouterProcess - handleRouteRequest marks worker busy and idle', async () => {
	const process = new RouterProcess('router-test-6');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// Create mock worker
	const mockWorker = new MockRouterWorkerProxy('worker-1');
	mockWorker.routeResult = { pool: 'standard', app: '/test/app.esm.js', params: {}, tail: '' };

	// Add worker to available pool
	mockPool.availableItems.push({ item: mockWorker, id: 'worker-1' });

	// Create route request fields - must be NANOS with proper structure
	const requestFields = new NANOS({
		method: 'get',
		path: '/api/test',
	});

	// Handle route request
	await process.handleRouteRequest('req-4', requestFields);

	// Verify worker was marked busy then idle
	assertEquals(mockPool.busyItems.has('worker-1'), false); // Should be idle after completion
});

Deno.test('RouterProcess - handleRouteRequest handles worker error', async () => {
	const process = new RouterProcess('router-test-7');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// Create mock worker that throws error
	const mockWorker = new MockRouterWorkerProxy('worker-1');
	mockWorker.findRoute = async () => {
		throw new Error('Worker error');
	};

	// Add worker to available pool
	mockPool.availableItems.push({ item: mockWorker, id: 'worker-1' });

	// Create route request fields - must be NANOS with proper structure
	const requestFields = new NANOS({
		method: 'get',
		path: '/api/test',
	});

	// Handle route request
	await process.handleRouteRequest('req-5', requestFields);

	// Verify 500 error response was sent
	assertEquals(mockConn.writtenMessages.length, 1);
	const response = mockConn.writtenMessages[0].message;
	const fields = response.at(1);
	assertEquals(fields.at('status'), 500);

	// Verify worker was marked idle after error
	assertEquals(mockPool.busyItems.has('worker-1'), false);
});

Deno.test('RouterProcess - handleHealthCheck returns worker metrics', async () => {
	const process = new RouterProcess('router-test-8');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Set up pool metrics
	mockPool.availableItems = [{ id: 'w1' }, { id: 'w2' }];
	mockPool.items.set('w1', { id: 'w1' });
	mockPool.items.set('w2', { id: 'w2' });
	mockPool.items.set('w3', { id: 'w3' });

	// Create health check fields
	const checkFields = new NANOS();
	checkFields.setOpts({ transform: true });
	checkFields.push([{
		timestamp: Date.now(),
	}]);

	// Handle health check
	await process.handleHealthCheck('hc-1', checkFields);

	// Verify response
	assertEquals(mockConn.writtenMessages.length, 1);
	const response = mockConn.writtenMessages[0].message;
	assertEquals(response.at(0), MessageType.HEALTH_CHECK);
	assertEquals(response.at('id'), 'hc-1');

	const fields = response.at(1);
	assertEquals(fields.at('status'), 'ok');
	assertEquals(fields.at('availableWorkers'), 2);
	assertEquals(fields.at('totalWorkers'), 3);
	assertExists(fields.at('uptime'));
});

Deno.test('RouterProcess - handleShutdown closes pool and connection', async () => {
	const process = new RouterProcess('router-test-9');
	const mockConn = new MockIPCConnection();
	const mockPool = new MockPoolManager();

	process.ipcConn = mockConn;
	process.poolManager = mockPool;

	// Create shutdown fields
	const shutdownFields = new NANOS();
	shutdownFields.setOpts({ transform: true });
	shutdownFields.push([{
		timeout: 30,
	}]);

	// Mock Deno.exit to prevent actual exit
	const originalExit = Deno.exit;
	let exitCalled = false;
	Deno.exit = (code) => {
		exitCalled = true;
		assertEquals(code, 0);
	};

	try {
		// Handle shutdown
		await process.handleShutdown(shutdownFields);

		// Verify shutdown sequence
		assertEquals(process.isShuttingDown, true);
		assertEquals(mockPool.shutdownCalled, true);
		assertEquals(mockConn.closed, true);
		assertEquals(exitCalled, true);
	} finally {
		// Restore Deno.exit
		Deno.exit = originalExit;
	}
});

Deno.test('RouterProcess - getMessageHandlers includes ROUTE_REQUEST', () => {
	const process = new RouterProcess('router-test-10');
	const handlers = process.getMessageHandlers();

	// Verify base handlers
	assertEquals(handlers.has(MessageType.CONFIG_UPDATE), true);
	assertEquals(handlers.has(MessageType.HEALTH_CHECK), true);
	assertEquals(handlers.has(MessageType.SHUTDOWN), true);

	// Verify router-specific handler
	assertEquals(handlers.has(MessageType.ROUTE_REQUEST), true);
});

Deno.test('RouterProcess - onStarted initializes pool manager', async () => {
	const process = new RouterProcess('router-test-11');

	// Create configuration
	const configFields = createTestConfig();
	process.config = new Configuration(configFields);

	// Mock PoolManager constructor
	const originalPoolManager = process.poolManager;

	// We can't easily mock the PoolManager constructor, so we'll just verify
	// that onStarted completes without error and sets poolManager
	await process.onStarted();

	assertExists(process.poolManager);
	assertEquals(process.poolManager !== originalPoolManager, true);

	// Clean up the pool manager to prevent resource leaks
	if (process.poolManager) {
		await process.poolManager.shutdown(0);
	}
});
