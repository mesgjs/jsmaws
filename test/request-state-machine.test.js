/**
 * Tests for JSMAWS Request State Machine
 * 
 * Tests the data-driven state machine for request handling that eliminates
 * handler swapping and race conditions.
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { NANOS } from '../src/vendor.esm.js';
import {
	RequestState,
	RequestContext,
	createRequestHandler,
	handleFirstFrame,
	handleBidiParams,
	handleStreamFrame,
	handleBidiFrame,
	handleRequestError,
} from '../src/operator-request-state.esm.js';

/**
 * Create mock operator for testing
 */
function createMockOperator () {
	const logs = [];
	return {
		logger: {
			debug: (msg) => logs.push({ level: 'debug', msg }),
			info: (msg) => logs.push({ level: 'info', msg }),
			warn: (msg) => logs.push({ level: 'warn', msg }),
			error: (msg) => logs.push({ level: 'error', msg }),
		},
		convertHeaders: (nanosHeaders) => {
			const headers = new Headers();
			if (nanosHeaders instanceof NANOS) {
				for (const [name, value] of nanosHeaders.entries()) {
					headers.set(name, value);
				}
			}
			return headers;
		},
		bidiConnections: new Map(),
		requestContexts: new Map(),
		cleanupRequestContext: (requestId) => {
			// Mock cleanup
		},
		logs, // Expose for assertions
	};
}

/**
 * Create mock process for testing
 */
function createMockProcess () {
	return {
		id: 'test-process',
		ipcConn: {
			setRequestHandler: () => {},
			clearRequestHandler: () => {},
		}
	};
}

// ============================================================================
// RequestContext Tests
// ============================================================================

Deno.test("RequestContext - initializes with correct defaults", () => {
	const mockProcess = createMockProcess();
	const mockRequest = new Request('https://example.com/test');
	
	const context = new RequestContext(
		'test-req-123',
		mockProcess,
		'standard',
		null,
		mockRequest
	);
	
	assertEquals(context.requestId, 'test-req-123');
	assertEquals(context.process, mockProcess);
	assertEquals(context.poolName, 'standard');
	assertEquals(context.routeSpec, null);
	assertEquals(context.originalRequest, mockRequest);
	assertEquals(context.state, RequestState.WAITING_FIRST_FRAME);
	assertExists(context.responsePromise);
	assertEquals(context.mode, null);
	assertEquals(context.status, null);
	assertEquals(context.headers, null);
	assertEquals(context.keepAlive, false);
	assertEquals(context.streamController, null);
	assertEquals(context.bidiState, null);
	assertEquals(context.protocolParams, null);
});

// ============================================================================
// Single-Frame Response Tests
// ============================================================================

Deno.test("handleFirstFrame - single-frame response completes immediately", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-1',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	// Create first frame (single-frame response)
	const message = {
		type: 'WEB_FRAME',
		id: 'test-req-1',
		fields: new NANOS({
			mode: 'response',
			status: 200,
			headers: new NANOS({ 'content-type': 'text/plain' }),
			final: true,
			keepAlive: false
		}),
	};
	
	const binaryData = new TextEncoder().encode('Hello, World!');
	
	await handleFirstFrame(context, message, binaryData, mockOperator);
	
	// Verify state transition
	assertEquals(context.state, RequestState.COMPLETED);
	assertEquals(context.mode, 'response');
	assertEquals(context.status, 200);
	assertEquals(context.keepAlive, false);
	
	// Verify response was created
	const response = await context.responsePromise.promise;
	assertEquals(response.status, 200);
	assertEquals(response.headers.get('content-type'), 'text/plain');
	
	const body = await response.text();
	assertEquals(body, 'Hello, World!');
});

// ============================================================================
// Multi-Frame Response Tests
// ============================================================================

Deno.test("handleFirstFrame - multi-frame response starts streaming", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-2',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	// Create first frame (multi-frame response)
	const message = {
		type: 'WEB_FRAME',
		id: 'test-req-2',
		fields: new NANOS({
			mode: 'response',
			status: 200,
			headers: new NANOS({ 'content-type': 'application/octet-stream' }),
			final: false,
			keepAlive: false
		}),
	};
	
	const firstData = new TextEncoder().encode('First chunk');
	
	await handleFirstFrame(context, message, firstData, mockOperator);
	
	// Verify state transition
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	assertEquals(context.mode, 'response');
	assertExists(context.streamController);
	
	// Verify response was created with stream
	const response = await context.responsePromise.promise;
	assertEquals(response.status, 200);
	assertExists(response.body);
});

Deno.test("handleStreamFrame - enqueues data and continues", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-3',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	// Set up streaming state
	context.state = RequestState.STREAMING_RESPONSE;
	context.keepAlive = false;
	
	const chunks = [];
	context.streamController = {
		enqueue: (data) => chunks.push(data),
		close: () => { context.streamController.closed = true; },
		closed: false
	};
	
	// Send non-final frame
	const message = {
		fields: new NANOS({ final: false })
	};
	const data = new TextEncoder().encode('chunk data');
	
	await handleStreamFrame(context, message, data, mockOperator);
	
	// Verify data enqueued but stream not closed
	assertEquals(chunks.length, 1);
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	assertEquals(context.streamController.closed, false);
});

Deno.test("handleStreamFrame - final frame closes stream", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-4',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	// Set up streaming state
	context.state = RequestState.STREAMING_RESPONSE;
	context.keepAlive = false;
	
	const chunks = [];
	context.streamController = {
		enqueue: (data) => chunks.push(data),
		close: () => { context.streamController.closed = true; },
		closed: false
	};
	
	// Send final frame
	const message = {
		fields: new NANOS({ final: true, keepAlive: false })
	};
	const data = new TextEncoder().encode('final chunk');
	
	await handleStreamFrame(context, message, data, mockOperator);
	
	// Verify stream closed and state completed
	assertEquals(chunks.length, 1);
	assertEquals(context.state, RequestState.COMPLETED);
	assertEquals(context.streamController.closed, true);
});

// ============================================================================
// Bidirectional Connection Tests
// ============================================================================

Deno.test("handleFirstFrame - bidi upgrade transitions to waiting params", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-5',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);
	
	// Create bidi upgrade frame
	const message = {
		type: 'WEB_FRAME',
		id: 'test-req-5',
		fields: new NANOS({
			mode: 'bidi',
			status: 101,
			headers: new NANOS({ 'upgrade': 'websocket' }),
			final: false,
			keepAlive: true
		}),
	};
	
	await handleFirstFrame(context, message, null, mockOperator);
	
	// Verify state transition (waiting for params)
	assertEquals(context.state, RequestState.WAITING_BIDI_PARAMS);
	assertEquals(context.mode, 'bidi');
	assertEquals(context.status, 101);
	assertEquals(context.keepAlive, true);
});

Deno.test("handleBidiParams - stores params and transitions to active", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const mockRequest = new Request('https://example.com/ws', {
		headers: {
			'upgrade': 'websocket',
			'connection': 'upgrade',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'sec-websocket-version': '13'
		}
	});
	
	const context = new RequestContext(
		'test-req-6',
		mockProcess,
		'standard',
		null,
		mockRequest
	);
	
	// Set up state (after first frame)
	context.state = RequestState.WAITING_BIDI_PARAMS;
	context.mode = 'bidi';
	context.status = 101;
	
	// Mock WebSocket upgrade
	const mockSocket = {
		send: () => {},
		close: () => {},
		onmessage: null,
		onclose: null,
		onerror: null
	};
	
	const originalUpgrade = Deno.upgradeWebSocket;
	Deno.upgradeWebSocket = () => ({
		socket: mockSocket,
		response: new Response(null, { status: 101 })
	});
	
	try {
		// Create params frame
		const message = {
			type: 'WEB_FRAME',
			id: 'test-req-6',
			fields: new NANOS({
				initialCredits: 655360,
				maxChunkSize: 65536,
				maxBytesPerSecond: 10485760,
				idleTimeout: 60,
				maxBufferSize: 1048576
			}),
		};
		
		await handleBidiParams(context, message, null, mockOperator);
		
		// Verify params stored
		assertExists(context.protocolParams);
		assertEquals(context.protocolParams.initialCredits, 655360);
		assertEquals(context.protocolParams.maxChunkSize, 65536);
		
		// Verify state transition
		assertEquals(context.state, RequestState.BIDI_ACTIVE);
		
		// Verify response created
		const response = await context.responsePromise.promise;
		assertEquals(response.status, 101);
	} finally {
		Deno.upgradeWebSocket = originalUpgrade;
	}
});

Deno.test("handleBidiParams - rejects on missing params", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-7',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);
	
	context.state = RequestState.WAITING_BIDI_PARAMS;
	
	// Create params frame with missing required fields
	const message = {
		type: 'WEB_FRAME',
		id: 'test-req-7',
		fields: new NANOS({
			// Missing initialCredits and maxChunkSize
			maxBytesPerSecond: 10485760
		}),
	};
	
	await handleBidiParams(context, message, null, mockOperator);
	
	// Verify state completed and promise rejected
	assertEquals(context.state, RequestState.COMPLETED);
	
	try {
		await context.responsePromise.promise;
		throw new Error('Expected promise to be rejected');
	} catch (error) {
		assert(error.message.includes('Missing protocol parameters'));
	}
});

Deno.test("handleBidiFrame - forwards data to socket", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-8',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);
	
	// Set up bidi state
	context.state = RequestState.BIDI_ACTIVE;
	const sentData = [];
	context.bidiState = {
		socket: {
			send: (data) => sentData.push(data),
			close: () => {}
		}
	};
	
	// Send bidi frame
	const message = {
		fields: new NANOS({ final: false, keepAlive: true })
	};
	const data = new TextEncoder().encode('websocket data');
	
	await handleBidiFrame(context, message, data, mockOperator);
	
	// Verify data forwarded
	assertEquals(sentData.length, 1);
	assertEquals(sentData[0], data);
	assertEquals(context.state, RequestState.BIDI_ACTIVE);
});

Deno.test("handleBidiFrame - final frame closes connection", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-9',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);
	
	// Set up bidi state
	context.state = RequestState.BIDI_ACTIVE;
	let socketClosed = false;
	context.bidiState = {
		socket: {
			send: () => {},
			close: (code, reason) => {
				socketClosed = true;
				assertEquals(code, 1000);
				assertEquals(reason, 'Normal closure');
			}
		}
	};
	
	// Send final frame
	const message = {
		fields: new NANOS({ final: true, keepAlive: false })
	};
	const data = new TextEncoder().encode('final data');
	
	await handleBidiFrame(context, message, data, mockOperator);
	
	// Verify connection closed
	assert(socketClosed);
	assertEquals(context.state, RequestState.COMPLETED);
});

// ============================================================================
// Error Handling Tests
// ============================================================================

Deno.test("handleRequestError - rejects promise in WAITING_FIRST_FRAME", () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-10',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	const error = new Error('Test error');
	handleRequestError(context, error, mockOperator);
	
	// Verify state completed
	assertEquals(context.state, RequestState.COMPLETED);
	
	// Verify promise rejected
	context.responsePromise.promise.catch((err) => {
		assertEquals(err, error);
	});
});

Deno.test("handleRequestError - closes stream in STREAMING_RESPONSE", () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-11',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	context.state = RequestState.STREAMING_RESPONSE;
	let streamErrored = false;
	context.streamController = {
		error: (err) => {
			streamErrored = true;
			assertExists(err);
		}
	};
	
	const error = new Error('Stream error');
	handleRequestError(context, error, mockOperator);
	
	// Verify stream errored
	assert(streamErrored);
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test("handleRequestError - closes WebSocket in BIDI_ACTIVE", () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-12',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);
	
	context.state = RequestState.BIDI_ACTIVE;
	let socketClosed = false;
	context.bidiState = {
		socket: {
			close: (code, reason) => {
				socketClosed = true;
				assertEquals(code, 1011);
				assertEquals(reason, 'Internal error');
			}
		}
	};
	
	const error = new Error('Bidi error');
	handleRequestError(context, error, mockOperator);
	
	// Verify socket closed
	assert(socketClosed);
	assertEquals(context.state, RequestState.COMPLETED);
});

// ============================================================================
// State Machine Handler Tests
// ============================================================================

Deno.test("createRequestHandler - dispatches to correct state handler", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-13',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	const handler = createRequestHandler(context, mockOperator);
	
	// Test WAITING_FIRST_FRAME state
	const message = {
		type: 'WEB_FRAME',
		id: 'test-req-13',
		fields: new NANOS({
			mode: 'response',
			status: 200,
			headers: new NANOS({ 'content-type': 'text/plain' }),
			final: true,
			keepAlive: false
		}),
	};
	
	const data = new TextEncoder().encode('test');
	await handler(message, data);
	
	// Verify state transitioned
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test("createRequestHandler - handles errors", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-14',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	const handler = createRequestHandler(context, mockOperator);
	
	// Send error
	const error = new Error('Test error');
	await handler(error, null);
	
	// Verify error handled
	assertEquals(context.state, RequestState.COMPLETED);
	assert(mockOperator.logs.some(log => log.level === 'error' && log.msg.includes('Test error')));
	
	// Verify promise was rejected
	try {
		await context.responsePromise.promise;
		throw new Error('Expected promise to be rejected');
	} catch (err) {
		assertEquals(err.message, 'Test error');
	}
});

Deno.test("createRequestHandler - ignores messages in COMPLETED state", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-15',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	// Set to completed state
	context.state = RequestState.COMPLETED;
	
	const handler = createRequestHandler(context, mockOperator);
	
	// Send message
	const message = {
		type: 'WEB_FRAME',
		id: 'test-req-15',
		fields: new NANOS({ final: true })
	};
	
	await handler(message, null);
	
	// Verify message ignored (logged as debug)
	assert(mockOperator.logs.some(log => 
		log.level === 'debug' && log.msg.includes('Ignoring message for completed request')
	));
});

// ============================================================================
// State Transition Tests
// ============================================================================

Deno.test("State transitions - WAITING_FIRST_FRAME to COMPLETED", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-16',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	assertEquals(context.state, RequestState.WAITING_FIRST_FRAME);
	
	const message = {
		fields: new NANOS({
			mode: 'response',
			status: 200,
			headers: new NANOS(),
			final: true,
			keepAlive: false
		})
	};
	
	await handleFirstFrame(context, message, null, mockOperator);
	
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test("State transitions - WAITING_FIRST_FRAME to STREAMING_RESPONSE to COMPLETED", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-17',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);
	
	assertEquals(context.state, RequestState.WAITING_FIRST_FRAME);
	
	// First frame
	const firstMessage = {
		fields: new NANOS({
			mode: 'stream',
			status: 200,
			headers: new NANOS(),
			final: false,
			keepAlive: true
		})
	};
	
	await handleFirstFrame(context, firstMessage, null, mockOperator);
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	
	// Final frame
	const finalMessage = {
		fields: new NANOS({ final: true, keepAlive: false })
	};
	
	await handleStreamFrame(context, finalMessage, null, mockOperator);
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test("State transitions - WAITING_FIRST_FRAME to WAITING_BIDI_PARAMS to BIDI_ACTIVE", async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const mockRequest = new Request('https://example.com/ws', {
		headers: {
			'upgrade': 'websocket',
			'connection': 'upgrade',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'sec-websocket-version': '13'
		}
	});
	
	const context = new RequestContext(
		'test-req-18',
		mockProcess,
		'standard',
		null,
		mockRequest
	);
	
	assertEquals(context.state, RequestState.WAITING_FIRST_FRAME);
	
	// Mock WebSocket upgrade
	const mockSocket = {
		send: () => {},
		close: () => {},
		onmessage: null,
		onclose: null,
		onerror: null
	};
	
	const originalUpgrade = Deno.upgradeWebSocket;
	Deno.upgradeWebSocket = () => ({
		socket: mockSocket,
		response: new Response(null, { status: 101 })
	});
	
	try {
		// First frame (bidi upgrade)
		const firstMessage = {
			fields: new NANOS({
				mode: 'bidi',
				status: 101,
				headers: new NANOS(),
				final: false,
				keepAlive: true
			})
		};
		
		await handleFirstFrame(context, firstMessage, null, mockOperator);
		assertEquals(context.state, RequestState.WAITING_BIDI_PARAMS);
		
		// Params frame
		const paramsMessage = {
			fields: new NANOS({
				initialCredits: 655360,
				maxChunkSize: 65536,
				maxBytesPerSecond: 10485760,
				idleTimeout: 60,
				maxBufferSize: 1048576
			})
		};
		
		await handleBidiParams(context, paramsMessage, null, mockOperator);
		assertEquals(context.state, RequestState.BIDI_ACTIVE);
	} finally {
		Deno.upgradeWebSocket = originalUpgrade;
	}
});
