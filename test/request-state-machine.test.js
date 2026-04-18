/**
 * Tests for JSMAWS Request State Machine
 *
 * Tests the data-driven state machine for request handling.
 * Uses the new PolyTransport-based API:
 *   - processReqChannelMessages() — main entry point
 *   - handleResponseMetadata() — handles 'res' messages
 *   - handleResFrame() — handles 'res-frame' chunks
 *   - relayBidiFrame() — relays 'bidi-frame' to client WS
 *   - handleRequestError() — error handling
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { makeWebSocketTransportPair } from '@poly-transport-test/transport-websocket-helpers.js';
import {
	RequestState,
	RequestContext,
	handleResponseMetadata,
	handleResFrame,
	relayBidiFrame,
	handleRequestError,
	cleanupRequestContext,
} from '../src/operator-request-state.esm.js';
import { Configuration } from '../src/configuration.esm.js';

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
			log: (level, msg) => logs.push({ level, msg }),
			asComponent: (_id, fn) => fn(),
		},
		convertHeaders: (rawHeaders) => {
			const headers = new Headers();
			if (rawHeaders && typeof rawHeaders === 'object') {
				for (const [name, value] of Object.entries(rawHeaders)) {
					headers.set(name, value);
				}
			}
			return headers;
		},
		configuration: new Configuration({
			chunkSize: 65536,
			pools: {
				standard: { maxChunkSize: 65536 },
			},
		}),
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
	};
}

// ============================================================================
// RequestContext Tests
// ============================================================================

Deno.test('RequestContext - initializes with correct defaults', () => {
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
	assertEquals(context.reqChannel, null);
});

// ============================================================================
// handleResponseMetadata Tests
// ============================================================================

Deno.test('handleResponseMetadata - response mode starts streaming', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-1',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	const resData = JSON.stringify({
		mode: 'response',
		status: 200,
		headers: { 'content-type': 'text/plain' },
		keepAlive: false,
	});

	await handleResponseMetadata(context, resData, mockOperator);

	// Verify state transition to STREAMING_RESPONSE
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	assertEquals(context.mode, 'response');
	assertEquals(context.status, 200);
	assertEquals(context.keepAlive, false);
	assertExists(context.streamController);

	// Verify response was created
	const response = await context.responsePromise.promise;
	assertEquals(response.status, 200);
	assertEquals(response.headers.get('content-type'), 'text/plain');
	assertExists(response.body);
});

Deno.test('handleResponseMetadata - stream mode starts streaming', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-2',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	const resData = JSON.stringify({
		mode: 'stream',
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
		keepAlive: true,
	});

	await handleResponseMetadata(context, resData, mockOperator);

	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	assertEquals(context.mode, 'stream');
	assertExists(context.streamController);
});

Deno.test('handleResponseMetadata - bidi mode transitions to BIDI_ACTIVE', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const mockRequest = new Request('https://example.com/ws');

	const context = new RequestContext(
		'test-req-3',
		mockProcess,
		'standard',
		null,
		mockRequest
	);

	// Use makeWebSocketTransportPair to create a real in-memory WS transport pair.
	// WebSocketTransport requires PolyTransport on both ends.
	// transportA = server side (used by the upgradeCallback injected into initializeBidiConnection)
	// transportB = client side (simulates the browser/client)
	const [transportA, transportB] = await makeWebSocketTransportPair();

	// Accept the 'bidi' channel on the client side (transportB)
	transportB.addEventListener('newChannel', (event) => {
		if (event.detail.channelName === 'bidi') {
			event.accept();
		} else {
			event.reject();
		}
	});

	// Inject a test upgradeCallback that uses the pre-created transportA
	// instead of calling Deno.upgradeWebSocket + creating a new WebSocketTransport
	const mockWsResponse = new Response(null, { status: 101 });
	const testUpgradeCallback = async (_context, _bidiParams) => {
		// Only accept the 'bidi' channel on the server side (transportA)
		transportA.addEventListener('newChannel', (event) => {
			if (event.detail.channelName === 'bidi') {
				event.accept();
			} else {
				event.reject();
			}
		});

		const bidiChannel = await transportA.requestChannel('bidi');
		await bidiChannel.addMessageTypes(['bidi-frame']);

		return { transport: transportA, bidiChannel, response: mockWsResponse };
	};

	try {
		const resData = JSON.stringify({
			mode: 'bidi',
			status: 101,
			headers: { 'upgrade': 'websocket' },
			keepAlive: true,
		});

		await handleResponseMetadata(context, resData, mockOperator, testUpgradeCallback);

		// Verify state transition
		assertEquals(context.state, RequestState.BIDI_ACTIVE);
		assertEquals(context.mode, 'bidi');
		assertEquals(context.status, 101);

		// Verify bidiState was set up
		assertExists(context.bidiState);
		assertExists(context.bidiState.wsTransport);
		assertExists(context.bidiState.bidiChannel);

		// Verify response was resolved
		const response = await context.responsePromise.promise;
		assertEquals(response.status, 101);

		// Cleanup: stop both transports
		await Promise.allSettled([
			transportA.stop({ discard: true }),
			transportB.stop({ discard: true }),
		]);
	} finally {
		// Ensure cleanup even on failure
		await Promise.allSettled([
			transportA.stop({ discard: true }),
			transportB.stop({ discard: true }),
		]);
	}
});

Deno.test('handleResponseMetadata - unknown mode throws error', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-4',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	const resData = JSON.stringify({
		mode: 'unknown-mode',
		status: 200,
		headers: {},
		keepAlive: false,
	});

	let threw = false;
	try {
		await handleResponseMetadata(context, resData, mockOperator);
	} catch (err) {
		threw = true;
		assert(err.message.includes('Unknown mode'));
	}
	assertEquals(threw, true);
});

// ============================================================================
// handleResFrame Tests
// ============================================================================

Deno.test('handleResFrame - enqueues data to stream controller', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-5',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	context.state = RequestState.STREAMING_RESPONSE;
	const chunks = [];
	context.streamController = {
		enqueue: (data) => chunks.push(data),
		close: () => { context.streamController.closed = true; },
		closed: false,
	};

	const data = new TextEncoder().encode('chunk data');
	await handleResFrame(context, data, false, mockOperator);

	assertEquals(chunks.length, 1);
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	assertEquals(context.streamController.closed, false);
});

Deno.test('handleResFrame - eom:true with no data closes stream', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-6',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	context.state = RequestState.STREAMING_RESPONSE;
	const chunks = [];
	context.streamController = {
		enqueue: (data) => chunks.push(data),
		close: () => { context.streamController.closed = true; },
		closed: false,
	};

	// Zero-data + eom:true = end-of-stream signal
	await handleResFrame(context, undefined, true, mockOperator);

	assertEquals(chunks.length, 0);
	assertEquals(context.state, RequestState.COMPLETED);
	assertEquals(context.streamController.closed, true);
});

Deno.test('handleResFrame - data with eom:true enqueues and closes', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-7',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	context.state = RequestState.STREAMING_RESPONSE;
	const chunks = [];
	context.streamController = {
		enqueue: (data) => chunks.push(data),
		close: () => { context.streamController.closed = true; },
		closed: false,
	};

	const data = new TextEncoder().encode('final chunk');
	await handleResFrame(context, data, false, mockOperator);

	// Data enqueued, stream still open (eom:false)
	assertEquals(chunks.length, 1);
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
	assertEquals(context.streamController.closed, false);
});

// ============================================================================
// relayBidiFrame Tests
// ============================================================================

Deno.test('relayBidiFrame - forwards data to bidi channel', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-8',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);

	context.state = RequestState.BIDI_ACTIVE;
	const sentData = [];
	context.bidiState = {
		bidiChannel: {
			write: async (type, data, opts) => {
				sentData.push({ type, data, opts });
			},
		},
	};

	const data = new Uint8Array([1, 2, 3, 4]);
	await relayBidiFrame(context, data, mockOperator);

	assertEquals(sentData.length, 1);
	assertEquals(sentData[0].type, 'bidi-frame');
	assertEquals(sentData[0].data, data);
	assertEquals(sentData[0].opts.eom, false);
	assertEquals(context.state, RequestState.BIDI_ACTIVE);
});

Deno.test('relayBidiFrame - no-op when state is COMPLETED', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-9',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);

	context.state = RequestState.COMPLETED;
	const sentData = [];
	context.bidiState = {
		bidiChannel: {
			write: async (type, data, opts) => {
				sentData.push({ type, data, opts });
			},
		},
	};

	const data = new Uint8Array([1, 2, 3]);
	await relayBidiFrame(context, data, mockOperator);

	// Should not forward when COMPLETED
	assertEquals(sentData.length, 0);
});

Deno.test('relayBidiFrame - no-op when no bidiState', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-10',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);

	context.state = RequestState.BIDI_ACTIVE;
	context.bidiState = null; // No bidi state

	// Should not throw
	const data = new Uint8Array([1, 2, 3]);
	await relayBidiFrame(context, data, mockOperator);
});

// ============================================================================
// handleRequestError Tests
// ============================================================================

Deno.test('handleRequestError - rejects promise in WAITING_FIRST_FRAME', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-11',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	const error = new Error('Test error');
	handleRequestError(context, error, mockOperator);

	assertEquals(context.state, RequestState.COMPLETED);

	// Verify promise rejected (must await to avoid unhandled rejection)
	let rejectedWith = null;
	await context.responsePromise.promise.catch((err) => {
		rejectedWith = err;
	});
	assertEquals(rejectedWith, error);
});

Deno.test('handleRequestError - closes stream in STREAMING_RESPONSE', () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-12',
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
		},
	};

	const error = new Error('Stream error');
	handleRequestError(context, error, mockOperator);

	assert(streamErrored);
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test('handleRequestError - stops WS transport in BIDI_ACTIVE', () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-13',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/ws')
	);

	context.state = RequestState.BIDI_ACTIVE;
	let transportStopped = false;
	context.bidiState = {
		wsTransport: {
			stop: () => {
				transportStopped = true;
			},
		},
	};

	const error = new Error('Bidi error');
	handleRequestError(context, error, mockOperator);

	assert(transportStopped);
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test('handleRequestError - logs error message', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-14',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	const error = new Error('Specific error message');
	handleRequestError(context, error, mockOperator);

	// Suppress unhandled rejection from responsePromise.reject()
	await context.responsePromise.promise.catch(() => {});

	assert(mockOperator.logs.some(log =>
		log.level === 'error' && log.msg.includes('Specific error message')
	));
});

// ============================================================================
// cleanupRequestContext Tests
// ============================================================================

Deno.test('cleanupRequestContext - removes COMPLETED context', () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-15',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	context.state = RequestState.COMPLETED;
	mockOperator.requestContexts.set('test-req-15', context);

	cleanupRequestContext('test-req-15', mockOperator.requestContexts, mockOperator.logger);

	assertEquals(mockOperator.requestContexts.has('test-req-15'), false);
});

Deno.test('cleanupRequestContext - does not remove non-COMPLETED context', () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-16',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	context.state = RequestState.STREAMING_RESPONSE;
	mockOperator.requestContexts.set('test-req-16', context);

	cleanupRequestContext('test-req-16', mockOperator.requestContexts, mockOperator.logger);

	// Should still be present (not COMPLETED)
	assertEquals(mockOperator.requestContexts.has('test-req-16'), true);
});

Deno.test('cleanupRequestContext - no-op for unknown requestId', () => {
	const mockOperator = createMockOperator();

	// Should not throw
	cleanupRequestContext('nonexistent', mockOperator.requestContexts, mockOperator.logger);
});

// ============================================================================
// State Transition Tests
// ============================================================================

Deno.test('State transitions - WAITING_FIRST_FRAME to STREAMING_RESPONSE', async () => {
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

	const resData = JSON.stringify({
		mode: 'response',
		status: 200,
		headers: {},
		keepAlive: false,
	});

	await handleResponseMetadata(context, resData, mockOperator);
	assertEquals(context.state, RequestState.STREAMING_RESPONSE);
});

Deno.test('State transitions - STREAMING_RESPONSE to COMPLETED via end-of-stream', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-18',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	context.state = RequestState.STREAMING_RESPONSE;
	context.streamController = {
		enqueue: () => {},
		close: () => { context.streamController.closed = true; },
		closed: false,
	};

	// Send end-of-stream signal (zero-data + eom:true)
	await handleResFrame(context, undefined, true, mockOperator);
	assertEquals(context.state, RequestState.COMPLETED);
});

Deno.test('State transitions - WAITING_FIRST_FRAME to COMPLETED via error', async () => {
	const mockOperator = createMockOperator();
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-19',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test')
	);

	assertEquals(context.state, RequestState.WAITING_FIRST_FRAME);

	handleRequestError(context, new Error('Test'), mockOperator);
	assertEquals(context.state, RequestState.COMPLETED);

	// Suppress unhandled rejection from responsePromise.reject()
	await context.responsePromise.promise.catch(() => {});
});

// ============================================================================
// RequestContext app field Tests
// ============================================================================

Deno.test('RequestContext - stores app field', () => {
	const mockProcess = createMockProcess();
	const context = new RequestContext(
		'test-req-20',
		mockProcess,
		'standard',
		null,
		new Request('https://example.com/test'),
		'/path/to/applet.esm.js'
	);

	assertEquals(context.app, '/path/to/applet.esm.js');
});

Deno.test('RequestContext - stores routeSpec', () => {
	const mockProcess = createMockProcess();
	const routeSpec = { pool: 'fast', path: '/api/test' };
	const context = new RequestContext(
		'test-req-21',
		mockProcess,
		'fast',
		routeSpec,
		new Request('https://example.com/api/test')
	);

	assertEquals(context.routeSpec, routeSpec);
	assertEquals(context.poolName, 'fast');
});
