/**
 * Event-Driven IPC Tests
 * Tests for stream handler infrastructure and continuous monitoring
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { IPCConnection, MessageType, createFrame, createHealthCheck } from '../src/ipc-protocol.esm.js';
import { NANOS } from '../src/vendor.esm.js';

/**
 * Create mock connection for testing
 */
function createMockConnection() {
	const readQueue = [];
	const writeQueue = [];
	let closed = false;
	let blocked = null;

	return {
		conn: {
			read: async () => {
				if (closed && readQueue.length === 0) {
					return { done: true, value: undefined };
				}
				while (readQueue.length === 0 && !closed) {
					blocked = Promise.withResolvers();
					await blocked.promise;
					blocked = null;
				}
				if (readQueue.length > 0) {
					return { done: false, value: readQueue.shift() };
				}
				return { done: true, value: undefined };
			},
			write: async (data) => {
				if (closed) throw new Error('Connection closed');
				writeQueue.push(data);
			},
			close: async () => {
				closed = true;
			}
		},
		readQueue,
		writeQueue,
		isClosed: () => closed,
		enqueueRead: (data) => {
			readQueue.push(data);
			if (blocked) blocked.resolve();
		},
		getWritten: () => writeQueue,
		close: () => {
			closed = true;
			if (blocked) blocked.resolve();
		}
	};
}

/**
 * Test: Stream handler registration and unregistration
 */
Deno.test('IPCConnection - stream handler registration', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	let handlerCalled = false;
	const handler = async (message, binaryData) => {
		handlerCalled = true;
	};

	// Register handler
	ipcConn.registerStreamHandler('test-123', handler, 1000);
	assertEquals(ipcConn.streamHandlers.size, 1);

	// Unregister handler
	ipcConn.unregisterStreamHandler('test-123');
	assertEquals(ipcConn.streamHandlers.size, 0);

	await ipcConn.close();
});

/**
 * Test: Stream handler timeout
 */
Deno.test('IPCConnection - stream handler timeout', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	let errorReceived = null;
	const handler = async (message, binaryData) => {
		if (message instanceof Error) {
			errorReceived = message;
		}
	};

	// Register handler with short timeout
	ipcConn.registerStreamHandler('test-123', handler, 100);

	// Wait for timeout
	await new Promise(resolve => setTimeout(resolve, 150));

	// Handler should have been called with timeout error
	assertEquals(errorReceived !== null, true);
	assertEquals(errorReceived.message.includes('timed out'), true);
	assertEquals(ipcConn.streamHandlers.size, 0);

	await ipcConn.close();
});

/**
 * Test: Multiple frames delivered to same handler
 */
Deno.test('IPCConnection - multiple frames to handler', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	const receivedFrames = [];
	const handler = async (message, binaryData) => {
		if (!(message instanceof Error)) {
			receivedFrames.push({ message, binaryData });
		}
	};

	// Register handler
	ipcConn.registerStreamHandler('req-123', handler, 5000);

	// Start monitoring
	ipcConn.startMonitoring();

	// Send multiple frames
	const frame1 = createFrame('req-123', {
		mode: 'stream',
		status: 200,
		headers: { 'Content-Type': 'text/plain' },
		data: new TextEncoder().encode('chunk1'),
		final: false,
		keepAlive: true
	});
	const data1 = new TextEncoder().encode('chunk1');
	await ipcConn.writeMessage(frame1, data1);
	mock.enqueueRead(mock.writeQueue.shift());

	// Wait for frame to be processed
	await new Promise(resolve => setTimeout(resolve, 50));

	const frame2 = createFrame('req-123', {
		data: new TextEncoder().encode('chunk2'),
		final: false,
		keepAlive: true
	});
	const data2 = new TextEncoder().encode('chunk2');
	await ipcConn.writeMessage(frame2, data2);
	mock.enqueueRead(mock.writeQueue.shift());

	await new Promise(resolve => setTimeout(resolve, 50));

	const frame3 = createFrame('req-123', {
		data: new TextEncoder().encode('chunk3'),
		final: true,
		keepAlive: false
	});
	const data3 = new TextEncoder().encode('chunk3');
	await ipcConn.writeMessage(frame3, data3);
	mock.enqueueRead(mock.writeQueue.shift());

	await new Promise(resolve => setTimeout(resolve, 50));

	// Should have received all 3 frames
	assertEquals(receivedFrames.length, 3);
	assertEquals(new TextDecoder().decode(receivedFrames[0].binaryData), 'chunk1');
	assertEquals(new TextDecoder().decode(receivedFrames[1].binaryData), 'chunk2');
	assertEquals(new TextDecoder().decode(receivedFrames[2].binaryData), 'chunk3');

	// Handler should be auto-unregistered after final frame
	assertEquals(ipcConn.streamHandlers.size, 0);

	ipcConn.stopMonitoring();
	mock.close();
	await ipcConn.close();
});

/**
 * Test: Console output forwarding during monitoring
 */
Deno.test('IPCConnection - console output during monitoring', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	const consoleOutput = [];
	ipcConn.setConsoleOutputHandler((text, logLevel) => {
		consoleOutput.push({ text, logLevel });
	});

	// Start monitoring
	ipcConn.startMonitoring();

	// Send console output
	mock.enqueueRead(new TextEncoder().encode('Console log line 1\n'));
	await new Promise(resolve => setTimeout(resolve, 50));

	mock.enqueueRead(new TextEncoder().encode('Console log line 2\n'));
	await new Promise(resolve => setTimeout(resolve, 50));

	// Should have captured console output
	assertEquals(consoleOutput.length, 2);
	assertEquals(consoleOutput[0].text, 'Console log line 1');
	assertEquals(consoleOutput[1].text, 'Console log line 2');

	// Cleanup
	ipcConn.stopMonitoring();
	mock.close();
	await ipcConn.close();
});

/**
 * Test: Global message handlers
 */
Deno.test('IPCConnection - global message handlers', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	let healthCheckReceived = null;
	ipcConn.onMessage(MessageType.HEALTH_CHECK, async (message, binaryData) => {
		healthCheckReceived = message;
	});

	// Start monitoring
	ipcConn.startMonitoring();

	// Send health check message
	const healthCheck = createHealthCheck();
	await ipcConn.writeMessage(healthCheck);
	mock.enqueueRead(mock.writeQueue.shift());

	await new Promise(resolve => setTimeout(resolve, 50));

	// Should have received health check
	assertEquals(healthCheckReceived !== null, true);
	assertEquals(healthCheckReceived.type, MessageType.HEALTH_CHECK);

	// Cleanup
	ipcConn.stopMonitoring();
	mock.close();
	await ipcConn.close();
});

/**
 * Test: Capacity update callback
 */
Deno.test('IPCConnection - capacity update callback', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	let capacityUpdate = null;
	ipcConn.onCapacityUpdate = (capacity) => {
		capacityUpdate = capacity;
	};

	// Register a stream handler to receive the frame
	ipcConn.registerStreamHandler('req-123', async (message, binaryData) => {
		// Handler receives the frame
	}, 5000);

	// Start monitoring
	ipcConn.startMonitoring();

	// Send frame with capacity info
	const frame = createFrame('req-123', {
		mode: 'response',
		status: 200,
		headers: {},
		data: null,
		final: true,
		availableWorkers: 5,
		totalWorkers: 10
	});
	await ipcConn.writeMessage(frame);
	mock.enqueueRead(mock.writeQueue.shift());

	await new Promise(resolve => setTimeout(resolve, 50));

	// Should have received capacity update
	assertEquals(capacityUpdate !== null, true);
	assertEquals(capacityUpdate.at('availableWorkers'), 5);
	assertEquals(capacityUpdate.at('totalWorkers'), 10);

	// Cleanup
	ipcConn.stopMonitoring();
	mock.close();
	await ipcConn.close();
});

/**
 * Test: Handler cleanup on connection close
 */
Deno.test('IPCConnection - cleanup on close', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	let errorCount = 0;
	const handler = async (message, binaryData) => {
		if (message instanceof Error) {
			errorCount++;
		}
	};

	// Register multiple handlers
	ipcConn.registerStreamHandler('req-1', handler, 5000);
	ipcConn.registerStreamHandler('req-2', handler, 5000);
	ipcConn.registerStreamHandler('req-3', handler, 5000);

	assertEquals(ipcConn.streamHandlers.size, 3);

	// Stop monitoring (simulates connection close)
	ipcConn.stopMonitoring();

	// All handlers should be cleaned up and called with error
	assertEquals(ipcConn.streamHandlers.size, 0);
	assertEquals(errorCount, 3);

	await ipcConn.close();
});

/**
 * Test: Concurrent stream handlers
 */
Deno.test('IPCConnection - concurrent stream handlers', async () => {
	const mock = createMockConnection();
	const ipcConn = new IPCConnection(mock.conn);

	const req1Frames = [];
	const req2Frames = [];

	ipcConn.registerStreamHandler('req-1', async (message, binaryData) => {
		if (!(message instanceof Error)) {
			req1Frames.push(message);
		}
	}, 5000);

	ipcConn.registerStreamHandler('req-2', async (message, binaryData) => {
		if (!(message instanceof Error)) {
			req2Frames.push(message);
		}
	}, 5000);

	// Start monitoring
	ipcConn.startMonitoring();

	// Send interleaved frames for both requests
	const frame1a = createFrame('req-1', {
		mode: 'stream',
		status: 200,
		headers: {},
		data: new TextEncoder().encode('1a'),
		final: false,
		keepAlive: true
	});
	await ipcConn.writeMessage(frame1a, new TextEncoder().encode('1a'));
	mock.enqueueRead(mock.writeQueue.shift());
	await new Promise(resolve => setTimeout(resolve, 20));

	const frame2a = createFrame('req-2', {
		mode: 'stream',
		status: 200,
		headers: {},
		data: new TextEncoder().encode('2a'),
		final: false,
		keepAlive: true
	});
	await ipcConn.writeMessage(frame2a, new TextEncoder().encode('2a'));
	mock.enqueueRead(mock.writeQueue.shift());
	await new Promise(resolve => setTimeout(resolve, 20));

	const frame1b = createFrame('req-1', {
		data: new TextEncoder().encode('1b'),
		final: true,
		keepAlive: false
	});
	await ipcConn.writeMessage(frame1b, new TextEncoder().encode('1b'));
	mock.enqueueRead(mock.writeQueue.shift());
	await new Promise(resolve => setTimeout(resolve, 20));

	const frame2b = createFrame('req-2', {
		data: new TextEncoder().encode('2b'),
		final: true,
		keepAlive: false
	});
	await ipcConn.writeMessage(frame2b, new TextEncoder().encode('2b'));
	mock.enqueueRead(mock.writeQueue.shift());
	await new Promise(resolve => setTimeout(resolve, 20));

	// Each handler should have received its frames
	assertEquals(req1Frames.length, 2);
	assertEquals(req2Frames.length, 2);

	// Both handlers should be auto-unregistered
	assertEquals(ipcConn.streamHandlers.size, 0);

	// Cleanup
	ipcConn.stopMonitoring();
	mock.close();
	await ipcConn.close();
});
