/**
 * Tests for responder-process.esm.js
 * 
 * Tests cover:
 * - IPC message handling (CONFIG_UPDATE, WEB_REQUEST, HEALTH_CHECK, SHUTDOWN)
 * - Tiered response chunking (< 64KB, 64KB-10MB, > 10MB)
 * - Backpressure detection and signaling
 * - Worker lifecycle (one-shot behavior)
 * - Pool manager integration
 * - Error handling
 */

import { assertEquals, assertExists, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '../src/vendor.esm.js';
import { ResponderProcess, ResponderWorker } from '../src/responder-process.esm.js';
import { MessageType } from '../src/ipc-protocol.esm.js';

/**
 * Mock IPC connection for testing
 */
class MockIPCConnection {
	constructor () {
		this.messages = [];
		this.readQueue = [];
		this.closed = false;
	}

	async writeMessage (message, binaryData = null) {
		this.messages.push({ message, binaryData });
	}

	async readMessage () {
		if (this.readQueue.length > 0) {
			return this.readQueue.shift();
		}
		return null;
	}

	queueMessage (message, binaryData = null) {
		this.readQueue.push({ message, binaryData });
	}

	async close () {
		this.closed = true;
	}

	getLastMessage () {
		return this.messages[this.messages.length - 1];
	}

	clearMessages () {
		this.messages = [];
	}
}

/**
 * Mock worker for testing
 */
class MockWorker {
	constructor (workerId) {
		this.workerId = workerId;
		this.initialized = false;
		this.terminated = false;
		this.requests = [];
		this.onmessage = null;
		this.onerror = null;
	}

	postMessage (data) {
		if (data.type === 'init') {
			this.initialized = true;
		} else if (data.type === 'request') {
			this.requests.push(data);
			// Simulate successful response
			setTimeout(() => {
				if (this.onmessage) {
					this.onmessage({
						data: {
							type: 'response',
							requestId: data.requestId,
							result: {
								status: 200,
								headers: { 'Content-Type': 'text/plain' },
								body: new TextEncoder().encode('Test response'),
							},
						},
					});
				}
			}, 10);
		}
	}

	terminate () {
		this.terminated = true;
	}
}

/**
 * Test: ResponderWorker initialization
 */
Deno.test('ResponderWorker - initialization', async () => {
	const config = new NANOS();
	config.set('pools', new NANOS());

	const worker = new ResponderWorker('test-worker-1', 'mock://worker.js');

	// Mock the Worker constructor
	const originalWorker = globalThis.Worker;
	globalThis.Worker = MockWorker;

	try {
		await worker.initialize(config);
		assertExists(worker.worker);
		assertEquals(worker.config, config);
	} finally {
		globalThis.Worker = originalWorker;
	}
});

/**
 * Test: ResponderWorker request execution
 */
Deno.test('ResponderWorker - execute request', async () => {
	const config = new NANOS();
	const worker = new ResponderWorker('test-worker-2', 'mock://worker.js');

	const originalWorker = globalThis.Worker;
	globalThis.Worker = MockWorker;

	try {
		await worker.initialize(config);

		const requestData = {
			method: 'GET',
			path: '/test',
			app: 'test-app',
			headers: '[(headers=[])]',
			params: '[(params=[])]',
			tail: '',
			body: null,
		};

		const result = await worker.executeRequest('req-1', requestData, 30);

		assertExists(result);
		assertEquals(result.status, 200);
	} finally {
		globalThis.Worker = originalWorker;
	}
});

/**
 * Test: ResponderWorker timeout handling
 */
Deno.test('ResponderWorker - request timeout', async () => {
	const config = new NANOS();
	const worker = new ResponderWorker('test-worker-3', 'mock://worker.js');

	const originalWorker = globalThis.Worker;

	// Mock worker that never responds
	class SlowMockWorker extends MockWorker {
		postMessage (data) {
			if (data.type === 'init') {
				this.initialized = true;
			}
			// Don't respond to requests
		}
	}

	globalThis.Worker = SlowMockWorker;

	try {
		await worker.initialize(config);

		const requestData = {
			method: 'GET',
			path: '/test',
			app: 'test-app',
			headers: '[(headers=[])]',
			params: '[(params=[])]',
			tail: '',
			body: null,
		};

		// Use very short timeout for test
		await assertRejects(
			async () => await worker.executeRequest('req-1', requestData, 0.1),
			Error,
			'Request timeout'
		);
	} finally {
		globalThis.Worker = originalWorker;
	}
});

/**
 * Test: ResponderProcess configuration update
 */
Deno.test('ResponderProcess - configuration update', async () => {
	const process = new ResponderProcess('test-process-1', 'standard');

	const configFields = new NANOS();
	const pools = new NANOS();
	pools.set('standard', new NANOS());
	pools.at('standard').set('minProcs', 2);
	pools.at('standard').set('maxProcs', 10);

	configFields.set('pools', pools);

	await process.handleConfigUpdate(configFields);

	assertEquals(process.config.at('pools'), pools);
});

/**
 * Test: ResponderProcess chunking configuration
 */
Deno.test('ResponderProcess - chunking configuration', async () => {
	const process = new ResponderProcess('test-process-2', 'standard');

	const configFields = new NANOS();
	const chunking = new NANOS();
	chunking.set('maxDirectWrite', 32768);
	chunking.set('autoChunkThresh', 5242880);
	chunking.set('chunkSize', 32768);
	chunking.set('bpWriteTimeThresh', 100);

	configFields.set('chunking', chunking);

	await process.handleConfigUpdate(configFields);

	assertEquals(process.chunkingConfig.maxDirectWrite, 32768);
	assertEquals(process.chunkingConfig.autoChunkThresh, 5242880);
	assertEquals(process.chunkingConfig.chunkSize, 32768);
	assertEquals(process.chunkingConfig.bpWriteTimeThresh, 100);
});

/**
 * Test: ResponderProcess backpressure detection
 */
Deno.test('ResponderProcess - backpressure detection', () => {
	const process = new ResponderProcess('test-process-3', 'standard');

	// Simulate fast writes (no backpressure)
	process.detectBackpressure(5);
	process.detectBackpressure(8);
	process.detectBackpressure(6);
	assertEquals(process.isBackpressured, false);

	// Simulate slow writes (backpressure)
	process.detectBackpressure(100);
	process.detectBackpressure(120);
	process.detectBackpressure(110);
	process.detectBackpressure(105);
	process.detectBackpressure(115);
	assertEquals(process.isBackpressured, true);

	// Simulate recovery
	process.detectBackpressure(10);
	process.detectBackpressure(8);
	process.detectBackpressure(12);
	process.detectBackpressure(9);
	process.detectBackpressure(11);
	assertEquals(process.isBackpressured, false);
});

/**
 * Test: ResponderProcess small response (Tier 1)
 */
Deno.test('ResponderProcess - small response direct write', async () => {
	const process = new ResponderProcess('test-process-4', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 3,
			totalItems: 4,
			queuedRequests: 0,
		}),
	};

	const result = {
		status: 200,
		headers: { 'Content-Type': 'text/plain' },
		body: new TextEncoder().encode('Small response'),
	};

	await process.sendResponse('req-1', result);

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	assertEquals(lastMessage.message.fields.at('status'), 200);
	assertEquals(lastMessage.message.fields.at('availableWorkers'), 3);
	assertExists(lastMessage.binaryData);
});

/**
 * Test: ResponderProcess medium response (Tier 2)
 */
Deno.test('ResponderProcess - medium response with backpressure monitoring', async () => {
	const process = new ResponderProcess('test-process-5', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 2,
			totalItems: 4,
			queuedRequests: 1,
		}),
	};

	// Create medium-sized response (100KB)
	const bodySize = 100 * 1024;
	const body = new Uint8Array(bodySize);

	const result = {
		status: 200,
		headers: { 'Content-Type': 'application/octet-stream' },
		body,
	};

	await process.sendResponse('req-2', result);

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	assertEquals(lastMessage.message.fields.at('status'), 200);
	assertEquals(lastMessage.message.fields.at('bodySize'), bodySize);
});

/**
 * Test: ResponderProcess large response (Tier 3)
 */
Deno.test('ResponderProcess - large response with chunking', async () => {
	const process = new ResponderProcess('test-process-6', 'standard');

	// Mock IPC connection that tracks writes
	const mockConn = new MockIPCConnection();
	let writeCount = 0;
	const originalWrite = mockConn.writeMessage.bind(mockConn);
	mockConn.writeMessage = async function (message, binaryData) {
		writeCount++;
		return originalWrite(message, binaryData);
	};

	// Mock the conn.write method for chunked writes
	mockConn.conn = {
		write: async (data) => {
			writeCount++;
			return data.length;
		},
	};

	process.ipcConn = mockConn;

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 1,
			totalItems: 4,
			queuedRequests: 2,
		}),
	};

	// Create large response (15MB)
	const bodySize = 15 * 1024 * 1024;
	const body = new Uint8Array(bodySize);

	const result = {
		status: 200,
		headers: { 'Content-Type': 'application/octet-stream' },
		body,
	};

	await process.sendResponse('req-3', result);

	// Verify chunking occurred (should have multiple writes)
	const expectedChunks = Math.ceil(bodySize / process.chunkingConfig.chunkSize);
	assertEquals(writeCount > 1, true); // At least header + some chunks
});

/**
 * Test: ResponderProcess backpressure signaling
 */
Deno.test('ResponderProcess - backpressure signaling via availableWorkers=0', async () => {
	const process = new ResponderProcess('test-process-7', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 3,
			totalItems: 4,
			queuedRequests: 0,
		}),
	};

	// Simulate backpressure
	process.isBackpressured = true;

	const result = {
		status: 200,
		headers: { 'Content-Type': 'text/plain' },
		body: new TextEncoder().encode('Response during backpressure'),
	};

	await process.sendResponse('req-4', result);

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	// Should report 0 workers available when backpressured
	assertEquals(lastMessage.message.fields.at('availableWorkers'), 0);
});

/**
 * Test: ResponderProcess health check
 */
Deno.test('ResponderProcess - health check', async () => {
	const process = new ResponderProcess('test-process-8', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 2,
			totalItems: 4,
			queuedRequests: 1,
		}),
	};

	const fields = new NANOS();
	fields.set('timestamp', Date.now());

	await process.handleHealthCheck('health-1', fields);

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	assertEquals(lastMessage.message.type, MessageType.HEALTH_CHECK);
	assertEquals(lastMessage.message.fields.at('status'), 'ok');
	assertEquals(lastMessage.message.fields.at('availableWorkers'), 2);
	assertEquals(lastMessage.message.fields.at('totalWorkers'), 4);
	assertEquals(lastMessage.message.fields.at('requestsQueued'), 1);
});

/**
 * Test: ResponderProcess error response
 */
Deno.test('ResponderProcess - error response', async () => {
	const process = new ResponderProcess('test-process-9', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 3,
			totalItems: 4,
			queuedRequests: 0,
		}),
	};

	await process.sendErrorResponse('req-5', 500, 'Internal Server Error');

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	assertEquals(lastMessage.message.fields.at('status'), 500);

	const body = JSON.parse(new TextDecoder().decode(lastMessage.binaryData));
	assertEquals(body.error, 'Internal Server Error');
});

/**
 * Test: ResponderProcess no available workers
 */
Deno.test('ResponderProcess - no available workers returns 503', async () => {
	const process = new ResponderProcess('test-process-10', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager with no available workers
	process.poolManager = {
		getAvailableItem: async () => null,
		getMetrics: () => ({
			availableItems: 0,
			totalItems: 4,
			queuedRequests: 5,
		}),
	};

	const fields = new NANOS();
	fields.set('method', 'GET');
	fields.set('path', '/test');
	fields.set('app', 'test-app');
	fields.set('pool', 'standard');

	await process.handleWebRequest('req-6', fields, null);

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	assertEquals(lastMessage.message.fields.at('status'), 503);
});

/**
 * Test: ResponderProcess configuration validation
 */
Deno.test('ResponderProcess - validates required request fields', async () => {
	const process = new ResponderProcess('test-process-11', 'standard');
	process.ipcConn = new MockIPCConnection();

	// Mock pool manager
	process.poolManager = {
		getMetrics: () => ({
			availableItems: 3,
			totalItems: 4,
			queuedRequests: 0,
		}),
	};

	// Missing required fields
	const fields = new NANOS();
	fields.set('method', 'GET');
	// Missing path, app, pool

	await process.handleWebRequest('req-7', fields, null);

	const lastMessage = process.ipcConn.getLastMessage();
	assertExists(lastMessage);
	// Should return error response
	assertEquals(lastMessage.message.fields.at('status'), 500);
});
