/**
 * Tests for responder-process.esm.js
 * 
 * Tests cover:
 * - Configuration updates and chunking settings
 * - Direct applet worker spawning
 * - Unified frame protocol handling (first frame, subsequent frames)
 * - Sticky state tracking (mode, keepAlive)
 * - Bidirectional flow control (credit-based)
 * - Backpressure detection and signaling
 * - Request lifecycle and cleanup
 * - Error handling
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '../src/vendor.esm.js';
import { ResponderProcess } from '../src/responder-process.esm.js';
import { MessageType, createFrame } from '../src/ipc-protocol.esm.js';
import { Configuration } from '../src/configuration.esm.js';

/**
 * Mock IPC connection for testing
 */
class MockIPCConnection {
	constructor () {
		this.messages = [];
		this.readQueue = [];
		this.closed = false;
		this.conn = {
			write: async (data) => data.length
		};
	}

	async writeMessage (message, binaryData = null) {
		// Store message (NANOS) and binaryData separately
		this.messages.push({ msg: message, data: binaryData });
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
 * Mock Worker for testing applet execution
 */
class MockWorker {
	constructor (path, options) {
		this.path = path;
		this.options = options;
		this.terminated = false;
		this.onmessage = null;
		this.onerror = null;
		this.messages = [];
	}

	postMessage (data) {
		this.messages.push(data);
	}

	terminate () {
		this.terminated = true;
	}

	// Simulate applet sending frame
	simulateFrame (id, options) {
		if (this.onmessage) {
			this.onmessage({
				data: {
					type: 'frame',
					id,
					...options
				}
			});
		}
	}

	// Simulate applet error
	simulateError (id, error) {
		if (this.onmessage) {
			this.onmessage({
				data: {
					type: 'error',
					id,
					error: error.message,
					stack: error.stack
				}
			});
		}
	}
}

/**
 * Create mock configuration
 */
function createMockConfig () {
	return new Configuration(NANOS.parseSLID(`[(
		maxDirectWrite=65536
		autoChunkThresh=10485760
		chunkSize=65536
		bpWriteTimeThresh=50
		pools=[
			standard=[
				minProcs=2
				maxProcs=10
				maxWorkers=10
				reqTimeout=30
			]
		]
		routing=[
			root="/var/www"
		]
		mimeTypes=[
			".html"="text/html"
			".js"="application/javascript"
		]
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
	)]`));
}

/**
 * Test: ResponderProcess initialization
 */
Deno.test('ResponderProcess - initialization', () => {
	const process = new ResponderProcess('test-proc-1', 'standard');

	assertEquals(process.processId, 'test-proc-1');
	assertEquals(process.poolName, 'standard');
	assertExists(process.activeRequests);
	assertExists(process.bidiConnections);
	assertEquals(process.activeRequests.size, 0);
});

/**
 * Test: Configuration update
 */
Deno.test('ResponderProcess - configuration update', async () => {
	const process = new ResponderProcess('test-proc-2', 'standard');
	process.config = createMockConfig();

	const configFields = new NANOS({
		maxDirectWrite: 32768,
		autoChunkThresh: 5242880
	});

	await process.handleConfigUpdate(configFields);

	assertEquals(process.chunkingConfig.maxDirectWrite, 65536); // From config object
	assertEquals(process.maxConcurrentRequests, 10); // From pool config
});

/**
 * Test: Applet worker spawning
 */
Deno.test('ResponderProcess - spawn applet worker', () => {
	const process = new ResponderProcess('test-proc-3', 'standard');

	const originalWorker = globalThis.Worker;
	globalThis.Worker = MockWorker;

	try {
		const worker = process.spawnAppletWorker('/path/to/applet.esm.js');
		assertExists(worker);
		assertEquals(worker.path, '/path/to/applet.esm.js');
		assert(worker.options.deno.permissions.net); // Network always allowed
		assertEquals(worker.options.deno.permissions.write, false);
	} finally {
		globalThis.Worker = originalWorker;
	}
});

/**
 * Test: Handle first frame (establishes connection)
 */
Deno.test('ResponderProcess - handle first frame', async () => {
	const process = new ResponderProcess('test-proc-4', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const requestInfo = {
		worker: new MockWorker('/test.js', {}),
		timeout: setTimeout(() => {}, 1000)
	};
	process.activeRequests.set('req-1', requestInfo);

	const firstFrame = {
		mode: 'response',
		status: 200,
		headers: { 'Content-Type': 'text/plain' },
		data: new TextEncoder().encode('Hello'),
		final: false,
		keepAlive: false
	};

	await process.handleFirstFrame('req-1', firstFrame, requestInfo);

	assertEquals(requestInfo.mode, 'response');
	assertEquals(requestInfo.keepAlive, false);
	assertExists(requestInfo.frameBuffer);

	// Should have sent response headers to operator
	const lastMsg = process.ipcConn.getLastMessage();
	assertExists(lastMsg);
	// Message structure: [(WRES id=req-1 [status=200 ...])]
	assertEquals(lastMsg.msg.at([1, 'status']), 200);

	clearTimeout(requestInfo.timeout);
});

/**
 * Test: Handle subsequent frames (minimal)
 */
Deno.test('ResponderProcess - handle subsequent frames', async () => {
	const process = new ResponderProcess('test-proc-5', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const requestInfo = {
		worker: new MockWorker('/test.js', {}),
		timeout: setTimeout(() => {}, 1000),
		mode: 'response',
		keepAlive: false,
		frameBuffer: [],
		totalBuffered: 0
	};
	process.activeRequests.set('req-2', requestInfo);

	// Send data chunk
	const chunk1 = new TextEncoder().encode('chunk1');
	await process.handleFrame('req-2', { data: chunk1, final: false }, requestInfo);

	assertEquals(requestInfo.frameBuffer.length, 1);
	assertEquals(requestInfo.totalBuffered, chunk1.length);

	// Send final chunk
	const chunk2 = new TextEncoder().encode('chunk2');
	await process.handleFrame('req-2', { data: chunk2, final: true }, requestInfo);

	// Should have flushed buffer and cleaned up
	assertEquals(process.activeRequests.has('req-2'), false);
	assert(requestInfo.worker.terminated);

	clearTimeout(requestInfo.timeout);
});

/**
 * Test: Sticky keepAlive state
 */
Deno.test('ResponderProcess - sticky keepAlive state', async () => {
	const process = new ResponderProcess('test-proc-6', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const requestInfo = {
		worker: new MockWorker('/test.js', {}),
		timeout: setTimeout(() => {}, 1000),
		mode: 'stream',
		keepAlive: true,
		frameBuffer: [],
		totalBuffered: 0
	};
	process.activeRequests.set('req-3', requestInfo);

	// Send frame without keepAlive (should inherit sticky state)
	const chunk = new TextEncoder().encode('data');
	await process.handleFrame('req-3', { data: chunk, final: true }, requestInfo);

	// Should still be alive (keepAlive: true is sticky)
	assertEquals(process.activeRequests.has('req-3'), true);
	assertEquals(requestInfo.worker.terminated, false);

	// Now explicitly close
	await process.handleFrame('req-3', { data: null, final: true, keepAlive: false }, requestInfo);

	// Should be cleaned up
	assertEquals(process.activeRequests.has('req-3'), false);

	clearTimeout(requestInfo.timeout);
});

/**
 * Test: DoS protection - oversized chunk
 */
Deno.test('ResponderProcess - reject oversized chunks', async () => {
	const process = new ResponderProcess('test-proc-7', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const requestInfo = {
		worker: new MockWorker('/test.js', {}),
		timeout: setTimeout(() => {}, 1000),
		mode: 'response',
		keepAlive: false,
		frameBuffer: [],
		totalBuffered: 0
	};
	process.activeRequests.set('req-4', requestInfo);

	// Send oversized chunk (> maxChunkSize)
	const oversizedChunk = new Uint8Array(process.chunkingConfig.chunkSize + 1);
	await process.handleFrame('req-4', { data: oversizedChunk, final: false }, requestInfo);

	// Should have terminated applet and sent error
	assertEquals(process.activeRequests.has('req-4'), false);

	const lastMsg = process.ipcConn.getLastMessage();
	assertEquals(lastMsg.msg.at([1, 'status']), 500);

	clearTimeout(requestInfo.timeout);
});

/**
 * Test: Frame buffer auto-flush threshold
 */
Deno.test('ResponderProcess - auto-flush on threshold', async () => {
	const process = new ResponderProcess('test-proc-8', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const requestInfo = {
		worker: new MockWorker('/test.js', {}),
		timeout: setTimeout(() => {}, 1000),
		mode: 'response',
		keepAlive: false,
		frameBuffer: [],
		totalBuffered: 0
	};
	process.activeRequests.set('req-5', requestInfo);

	// Send chunk that exceeds autoChunkThresh
	const largeChunk = new Uint8Array(process.chunkingConfig.autoChunkThresh + 1);
	await process.handleFrame('req-5', { data: largeChunk, final: false }, requestInfo);

	// Should have flushed buffer
	assertEquals(requestInfo.frameBuffer.length, 0);
	assertEquals(requestInfo.totalBuffered, 0);

	// Should have sent frame to operator
	const messages = process.ipcConn.messages;
	assert(messages.length > 0);

	clearTimeout(requestInfo.timeout);
	process.activeRequests.delete('req-5');
});

/**
 * Test: Bidirectional connection initialization
 */
Deno.test('ResponderProcess - initialize bidi connection', async () => {
	const process = new ResponderProcess('test-proc-9', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const worker = new MockWorker('/test.js', {});
	const requestInfo = {
		worker,
		timeout: setTimeout(() => {}, 1000),
		mode: 'bidi',
		keepAlive: true
	};
	process.activeRequests.set('req-6', requestInfo);

	await process.initializeBidiConnection('req-6', requestInfo);

	// Should have created connection state
	const conn = process.bidiConnections.get('req-6');
	assertExists(conn);
	assertEquals(conn.outboundCredits, 10 * 65536); // initialCredits * maxChunkSize
	assertEquals(conn.inboundCredits, 10 * 65536);

	// Should have sent protocol parameters to applet
	const appletMsg = worker.messages[worker.messages.length - 1];
	assertEquals(appletMsg.type, 'frame');
	assertEquals(appletMsg.mode, 'bidi');
	assertExists(appletMsg.initialCredits);
	assertExists(appletMsg.maxChunkSize);

	// Should have sent protocol parameters to operator
	const operatorMsg = process.ipcConn.getLastMessage();
	assertExists(operatorMsg);

	clearTimeout(requestInfo.timeout);
	process.bidiConnections.delete('req-6');
});

/**
 * Test: Bidirectional frame with sufficient credits
 */
Deno.test('ResponderProcess - bidi frame with credits', async () => {
	const process = new ResponderProcess('test-proc-10', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const worker = new MockWorker('/test.js', {});
	const requestInfo = {
		worker,
		timeout: setTimeout(() => {}, 1000),
		mode: 'bidi',
		keepAlive: true
	};

	const conn = {
		worker,
		outboundCredits: 65536,
		inboundCredits: 65536,
		outboundBuffer: [],
		inboundBuffer: [],
		maxBufferSize: 1048576,
		totalBuffered: { outbound: 0, inbound: 0 },
		maxCredits: 655360,
		lastActivity: Date.now()
	};
	process.bidiConnections.set('req-7', conn);

	const data = new TextEncoder().encode('test data');
	await process.handleBidiFrame('req-7', data, true, undefined, requestInfo);

	// Should have consumed credits
	assertEquals(conn.outboundCredits, 65536 - data.length);

	// Should have forwarded to operator
	const lastMsg = process.ipcConn.getLastMessage();
	assertExists(lastMsg);

	clearTimeout(requestInfo.timeout);
	process.bidiConnections.delete('req-7');
});

/**
 * Test: Bidirectional frame with insufficient credits (buffering)
 */
Deno.test('ResponderProcess - bidi frame buffering', async () => {
	const process = new ResponderProcess('test-proc-11', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const worker = new MockWorker('/test.js', {});
	const requestInfo = {
		worker,
		timeout: setTimeout(() => {}, 1000),
		mode: 'bidi',
		keepAlive: true
	};

	const conn = {
		worker,
		outboundCredits: 10, // Very low credits
		inboundCredits: 65536,
		outboundBuffer: [],
		inboundBuffer: [],
		maxBufferSize: 1048576,
		totalBuffered: { outbound: 0, inbound: 0 },
		maxCredits: 655360,
		lastActivity: Date.now()
	};
	process.bidiConnections.set('req-8', conn);

	const data = new TextEncoder().encode('test data that exceeds credits');
	const initialMsgCount = process.ipcConn.messages.length;

	await process.handleBidiFrame('req-8', data, true, undefined, requestInfo);

	// Should have buffered (not forwarded)
	assertEquals(conn.outboundBuffer.length, 1);
	assertEquals(conn.totalBuffered.outbound, data.length);
	assertEquals(process.ipcConn.messages.length, initialMsgCount); // No new messages

	clearTimeout(requestInfo.timeout);
	process.bidiConnections.delete('req-8');
});

/**
 * Test: Backpressure detection
 */
Deno.test('ResponderProcess - backpressure detection', () => {
	const process = new ResponderProcess('test-proc-12', 'standard');
	process.config = createMockConfig();

	// Fast writes (no backpressure)
	process.detectBackpressure(5);
	process.detectBackpressure(8);
	process.detectBackpressure(6);
	assertEquals(process.isBackpressured, false);

	// Slow writes (backpressure)
	process.detectBackpressure(100);
	process.detectBackpressure(120);
	process.detectBackpressure(110);
	process.detectBackpressure(105);
	process.detectBackpressure(115);
	assertEquals(process.isBackpressured, true);
});

/**
 * Test: Backpressure affects available workers
 */
Deno.test('ResponderProcess - backpressure affects capacity', () => {
	const process = new ResponderProcess('test-proc-13', 'standard');
	process.config = createMockConfig();
	process.maxConcurrentRequests = 10;

	// No backpressure
	process.isBackpressured = false;
	assertEquals(process.bpAvailWorkers(), 10);

	// With backpressure
	process.isBackpressured = true;
	assertEquals(process.bpAvailWorkers(), 0);
});

/**
 * Test: Handle applet error
 */
Deno.test('ResponderProcess - handle applet error', async () => {
	const process = new ResponderProcess('test-proc-14', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const worker = new MockWorker('/test.js', {});
	const requestInfo = {
		worker,
		timeout: setTimeout(() => {}, 1000)
	};
	process.activeRequests.set('req-9', requestInfo);

	const errorData = {
		error: 'Test error',
		stack: 'Error stack trace'
	};

	await process.handleAppletError('req-9', errorData, requestInfo);

	// Should have cleaned up
	assertEquals(process.activeRequests.has('req-9'), false);
	assert(worker.terminated);

	// Should have sent error response
	const lastMsg = process.ipcConn.getLastMessage();
	assertEquals(lastMsg.msg.at([1, 'status']), 500);
});

/**
 * Test: Built-in applet configuration
 */
Deno.test('ResponderProcess - built-in applet config', async () => {
	const process = new ResponderProcess('test-proc-15', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const originalWorker = globalThis.Worker;
	globalThis.Worker = MockWorker;

	try {
		const fields = new NANOS({
			method: 'GET',
			path: '/test.html',
			app: '@static',
			pool: 'standard',
			root: '/custom/root',
			headers: new NANOS(),
			params: new NANOS(),
			query: new NANOS(),
			tail: '/test.html'
		});

		await process.handleWebRequest('req-10', fields, null);

		// Give worker time to be created
		await new Promise(resolve => setTimeout(resolve, 50));

		// Should have created worker
		assertEquals(process.activeRequests.has('req-10'), true);

		// Cleanup
		const requestInfo = process.activeRequests.get('req-10');
		if (requestInfo) {
			clearTimeout(requestInfo.timeout);
			requestInfo.worker.terminate();
			process.activeRequests.delete('req-10');
		}
	} finally {
		globalThis.Worker = originalWorker;
	}
});

/**
 * Test: Request timeout
 */
Deno.test('ResponderProcess - request timeout', async () => {
	const process = new ResponderProcess('test-proc-16', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();

	const worker = new MockWorker('/test.js', {});
	const timeout = setTimeout(() => {
		// Simulate timeout
		if (process.activeRequests.has('req-11')) {
			worker.terminate();
			process.activeRequests.delete('req-11');
			process.sendErrorResponse('req-11', 504, 'Gateway Timeout').catch(console.error);
		}
	}, 100);

	const requestInfo = { worker, timeout };
	process.activeRequests.set('req-11', requestInfo);

	// Wait for timeout
	await new Promise(resolve => setTimeout(resolve, 150));

	// Should have cleaned up
	assertEquals(process.activeRequests.has('req-11'), false);
	assert(worker.terminated);

	// Should have sent timeout error
	const lastMsg = process.ipcConn.getLastMessage();
	assertEquals(lastMsg.msg.at([1, 'status']), 504);
});

/**
 * Test: Health check response
 */
Deno.test('ResponderProcess - health check', async () => {
	const process = new ResponderProcess('test-proc-17', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();
	process.maxConcurrentRequests = 10;

	const fields = new NANOS();
	fields.set('timestamp', Date.now());

	await process.handleHealthCheck('health-1', fields);

	const lastMsg = process.ipcConn.getLastMessage();
	assertExists(lastMsg);
	assertEquals(lastMsg.msg.at(0), MessageType.HEALTH_CHECK);
	assertEquals(lastMsg.msg.at([1, 'status']), 'ok');
	assertEquals(lastMsg.msg.at([1, 'totalWorkers']), 10);
	assertExists(lastMsg.msg.at([1, 'uptime']));
});

/**
 * Test: At capacity returns 503
 */
Deno.test('ResponderProcess - at capacity', async () => {
	const process = new ResponderProcess('test-proc-18', 'standard');
	process.config = createMockConfig();
	process.ipcConn = new MockIPCConnection();
	process.maxConcurrentRequests = 2;

	// Fill capacity
	process.activeRequests.set('req-12', { worker: new MockWorker('/test.js', {}), timeout: setTimeout(() => {}, 1000) });
	process.activeRequests.set('req-13', { worker: new MockWorker('/test.js', {}), timeout: setTimeout(() => {}, 1000) });

	const fields = new NANOS({
		method: 'GET',
		path: '/test',
		app: 'test-app',
		pool: 'standard'
	});

	await process.handleWebRequest('req-14', fields, null);

	// Should have returned 503
	const lastMsg = process.ipcConn.getLastMessage();
	assertEquals(lastMsg.msg.at([1, 'status']), 503);

	// Cleanup
	for (const [id, info] of process.activeRequests.entries()) {
		clearTimeout(info.timeout);
		info.worker.terminate();
	}
	process.activeRequests.clear();
});
