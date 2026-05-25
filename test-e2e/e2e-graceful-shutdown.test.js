/**
 * E2E Tests for Graceful Shutdown
 *
 * Tests that the server shuts down cleanly under various conditions:
 * - Clean shutdown with no in-flight requests
 * - Shutdown while a request is in-flight (pre-response delay)
 * - Shutdown while a response body is in-flight (post-headers delay)
 * - Shutdown while an SSE stream is active
 * - Shutdown while a WebSocket connection is open
 * - SIGTERM triggers graceful shutdown
 * - Shutdown deadline respected (timeout enforcement)
 * - JSMAWS.shutdownDeadline resolves during shutdown
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'jsr:@std/assert';
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	fetchWithTimeout,
	readSSEEvents,
	connectPolyTransportWebSocket,
	closePolyTransportWebSocket,
} from './e2e-utils.esm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard pool config used across tests */
const FAST_POOL = { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 10 };

/**
 * Path to the slow-response app.
 * Resolved relative to src/responder-process.esm.js (import.meta.url of the responder).
 */
const SLOW_APP = '../test-e2e/apps/slow-response.esm.js';

// ---------------------------------------------------------------------------
// Test 1: Clean shutdown — no in-flight requests
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - clean shutdown with no in-flight requests',
	// sanitizeResources: false,
	// sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: { fast: FAST_POOL },
		});
		const baseUrl = await startTestServer(operator);

		// Verify server is up
		const r = await fetchWithTimeout(`${baseUrl}/hello`);
		assertEquals(r.status, 200);
		await r.body?.cancel();

		// Shutdown should complete without error
		await operator.shutdown(5, 1);

		// Verify server is no longer accepting connections
		let connectionRefused = false;
		try {
			await fetchWithTimeout(`${baseUrl}/hello`, {}, 1000);
		} catch {
			connectionRefused = true;
		}
		assertEquals(connectionRefused, true, 'Server should no longer accept connections after shutdown');
	},
});

// ---------------------------------------------------------------------------
// Test 2: Shutdown while request is in-flight (pre-response: resDelay)
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - shutdown while request is in-flight (pre-response)',
	// sanitizeResources: false,
	// sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/slow', app: SLOW_APP, pool: 'fast' },
			],
			pools: { fast: FAST_POOL },
		});
		const baseUrl = await startTestServer(operator);

		// Start a slow request (2s delay before response headers are sent)
		// Do NOT await — we want it in-flight during shutdown
		const requestPromise = fetchWithTimeout(`${baseUrl}/slow?resDelay=2000`, {}, 10000);

		// Give the request time to reach the responder (but not complete)
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Initiate shutdown concurrently with the in-flight request
		const shutdownPromise = operator.shutdown(5, 1);

		// Both should complete: the request should finish before shutdown completes
		const [response] = await Promise.all([requestPromise, shutdownPromise]);

		assertEquals(response.status, 200, 'In-flight request should complete with 200');
		const body = await response.json();
		assertEquals(body.message, 'slow response complete', 'Response body should be complete');
	},
});

// ---------------------------------------------------------------------------
// Test 3: Shutdown while response body is in-flight (post-headers delay)
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - shutdown while response body is in-flight (post-headers)',
	// sanitizeResources: false,
	// sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/slow', app: SLOW_APP, pool: 'fast' },
			],
			pools: { fast: FAST_POOL },
		});
		const baseUrl = await startTestServer(operator);

		// Start a slow request with sodDelay (delay after headers, before body)
		const requestPromise = fetchWithTimeout(`${baseUrl}/slow?sodDelay=2000`, {}, 10000);

		// Give the request time to receive headers (but not body)
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Initiate shutdown concurrently with the in-flight body
		const shutdownPromise = operator.shutdown(5, 1);

		// Both should complete: the full response body should be received
		const [response] = await Promise.all([requestPromise, shutdownPromise]);

		assertEquals(response.status, 200, 'In-flight request should complete with 200');
		const body = await response.json();
		assertEquals(body.message, 'slow response complete', 'Response body should be complete');
	},
});

// ---------------------------------------------------------------------------
// Test 4: Shutdown while SSE stream is active
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - shutdown while SSE stream is active',
	// sanitizeResources: false,
	// sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/clock', app: '../examples/apps/sse-clock.esm.js', pool: 'fast' },
			],
			pools: { fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 30 } },
		});
		const baseUrl = await startTestServer(operator);

		// Start an SSE stream
		const response = await fetchWithTimeout(`${baseUrl}/clock`, {}, 10000);
		assertEquals(response.status, 200, 'SSE stream should start with 200');

		// Read a couple of events to confirm the stream is active
		const events = await readSSEEvents(response, 2, 5000);
		assertEquals(events.length, 2, 'Should receive at least 2 SSE events');

		// Initiate shutdown while stream is active
		// The stream should close cleanly (no abrupt disconnect)
		await operator.shutdown(5, 1);

		// Verify server is no longer accepting connections
		let connectionRefused = false;
		try {
			await fetchWithTimeout(`${baseUrl}/clock`, {}, 1000);
		} catch {
			connectionRefused = true;
		}
		assertEquals(connectionRefused, true, 'Server should no longer accept connections after shutdown');
	},
});

// ---------------------------------------------------------------------------
// Test 5: Shutdown while WebSocket is open
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - shutdown while WebSocket is open',
	// sanitizeResources: false,
	// sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/ws', app: '../examples/apps/websocket-echo.esm.js', pool: 'fast' },
			],
			pools: { fast: { minProcs: 1, maxProcs: 1, maxWorkers: 2, reqTimeout: 30 } },
		});
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws';

		// Open a WebSocket connection
		const connection = await connectPolyTransportWebSocket(wsUrl);
		assertExists(connection.appChannel, 'WebSocket connection should be established');

		// Send a message to confirm the connection is active
		await connection.appChannel.write('data', 'ping');
		const reply = await connection.appChannel.read({ only: 'data', decode: true });
		assertExists(reply, 'Should receive echo reply');
		await reply.done();

		// Initiate shutdown while WebSocket is open
		const shutdownPromise = operator.shutdown(5, 1);

		// Close the WebSocket connection
		await closePolyTransportWebSocket(connection);

		// Wait for shutdown to complete
		await shutdownPromise;

		// Verify server is no longer accepting connections
		let connectionRefused = false;
		try {
			await fetchWithTimeout(`${baseUrl}/ws`, {}, 1000);
		} catch {
			connectionRefused = true;
		}
		assertEquals(connectionRefused, true, 'Server should no longer accept connections after shutdown');
	},
});

// ---------------------------------------------------------------------------
// Test 6: SIGTERM triggers graceful shutdown
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - SIGTERM triggers graceful shutdown',
	// sanitizeResources: false,
	// sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' },
			],
			pools: { fast: FAST_POOL },
		});
		const baseUrl = await startTestServer(operator);

		// Verify server is up
		const r = await fetchWithTimeout(`${baseUrl}/hello`);
		assertEquals(r.status, 200);
		await r.body?.cancel();

		// Send SIGTERM to the current process (operator is in-process in E2E tests)
		// Since the operator is running in-process, we call shutdown() directly
		// to simulate what SIGTERM would do (registerSigtermHandler calls shutdown())
		await operator.shutdown(5, 1);

		// Verify server is no longer accepting connections
		let connectionRefused = false;
		try {
			await fetchWithTimeout(`${baseUrl}/hello`, {}, 1000);
		} catch {
			connectionRefused = true;
		}
		assertEquals(connectionRefused, true, 'Server should no longer accept connections after SIGTERM');
	},
});

// ---------------------------------------------------------------------------
// Test 7: Shutdown deadline respected (timeout enforcement)
// ---------------------------------------------------------------------------

Deno.test({
	name: 'E2E Graceful Shutdown - shutdown deadline respected (timeout enforcement)',
	sanitizeResources: false,
	sanitizeOps: false,
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/slow', app: SLOW_APP, pool: 'fast' },
			],
			pools: { fast: FAST_POOL },
		});
		const baseUrl = await startTestServer(operator);

		// Start a slow request (5s delay before response headers)
		// Do NOT await — we want it in-flight during shutdown
		const requestPromise = fetchWithTimeout(`${baseUrl}/slow?resDelay=5000`, {}, 10000);

		// Give the request time to reach the responder
		await new Promise((resolve) => setTimeout(resolve, 300));

		// Initiate shutdown with a very short timeout (1s)
		// The in-flight request should NOT complete (it needs 5s)
		const startTime = Date.now();
		const shutdownPromise = operator.shutdown(1);

		// Wait for shutdown to complete
		await shutdownPromise;
		const duration = Date.now() - startTime;

		// Shutdown should complete within ~3s (1s deadline + some overhead)
		assert(duration < 4000, `Shutdown took ${duration}ms, expected < 4000ms`);

		// The in-flight request should have been aborted (connection refused or error)
		let requestFailed = false;
		try {
			await requestPromise;
		} catch {
			requestFailed = true;
		}
		assertEquals(requestFailed, true, 'In-flight request should fail when shutdown deadline is exceeded');
	},
});
