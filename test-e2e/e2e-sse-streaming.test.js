/**
 * E2E Tests for SSE Streaming Responses
 * Tests Server-Sent Events with the sse-clock applet
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { NANOS } from '../src/vendor.esm.js';
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	fetchWithTimeout,
	readSSEEvents,
} from './e2e-utils.esm.js';

Deno.test('E2E - SSE streaming with sse-clock applet', async () => {
	// Create test configuration with SSE route
	const testConfig = {
		noSSL: true,
		httpPort: 0,
		pools: {
			stream: {
				minProcs: 1,
				maxProcs: 1,
				maxWorkers: 2,
			}
		},
		routes: [
			{
				path: '/clock',
				app: '../examples/applets/sse-clock.esm.js',
				pool: 'stream',
			}
		]
	};

	const { operator } = await createTestServer(testConfig);
	const baseUrl = await startTestServer(operator);

	try {
		// Make SSE request
		const response = await fetchWithTimeout(`${baseUrl}/clock`, {}, 15000);

		// Verify response headers
		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'text/event-stream');
		assertEquals(response.headers.get('cache-control'), 'no-cache');
		assertEquals(response.headers.get('connection'), 'keep-alive');

		// Read SSE events (applet sends 10 events)
		const events = await readSSEEvents(response, 10, 15000);

		// Verify we received all 10 events
		assertEquals(events.length, 10, 'Should receive 10 SSE events');

		// Verify event structure
		for (let i = 0; i < events.length; i++) {
			const event = events[i];
			assertEquals(event.event, 'message', `Event ${i + 1} should be 'message' type`);
			
			// Parse event data
			const data = JSON.parse(event.data);
			assertExists(data.timestamp, `Event ${i + 1} should have timestamp`);
			assertEquals(data.count, i + 1, `Event ${i + 1} should have correct count`);
			assertEquals(data.message, `Update ${i + 1} of 10`, `Event ${i + 1} should have correct message`);
		}

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E - SSE streaming handles early client disconnect', async () => {
	// Create test configuration
	const testConfig = {
		noSSL: true,
		httpPort: 0,
		pools: {
			stream: {
				minProcs: 1,
				maxProcs: 1,
				maxWorkers: 2,
			}
		},
		routes: [
			{
				path: '/clock',
				app: '../examples/applets/sse-clock.esm.js',
				pool: 'stream',
			}
		]
	};

	const { operator } = await createTestServer(testConfig);
	const baseUrl = await startTestServer(operator);

	try {
		// Make SSE request
		const response = await fetchWithTimeout(`${baseUrl}/clock`, {}, 15000);
		assertEquals(response.status, 200);

		// Read only first 3 events, then disconnect
		// readSSEEvents() will properly close the stream after reading
		const events = await readSSEEvents(response, 3, 5000);
		assertEquals(events.length, 3, 'Should receive first 3 events');

		// Verify first 3 events
		for (let i = 0; i < 3; i++) {
			const data = JSON.parse(events[i].data);
			assertEquals(data.count, i + 1);
		}

		// Connection should close gracefully (no errors)
		// Server should handle the early disconnect without issues

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E - SSE streaming with multiple concurrent clients', async () => {
	// Create test configuration
	const testConfig = {
		noSSL: true,
		httpPort: 0,
		pools: {
			stream: {
				minProcs: 2,
				maxProcs: 2,
				maxWorkers: 2,
			}
		},
		routes: [
			{
				path: '/clock',
				app: '../examples/applets/sse-clock.esm.js',
				pool: 'stream',
			}
		]
	};

	const { operator } = await createTestServer(testConfig);
	const baseUrl = await startTestServer(operator);

	try {
		// Start 3 concurrent SSE connections
		const requests = [
			fetchWithTimeout(`${baseUrl}/clock`, {}, 15000),
			fetchWithTimeout(`${baseUrl}/clock`, {}, 15000),
			fetchWithTimeout(`${baseUrl}/clock`, {}, 15000),
		];

		const responses = await Promise.all(requests);

		// Verify all responses are successful
		for (const response of responses) {
			assertEquals(response.status, 200);
			assertEquals(response.headers.get('content-type'), 'text/event-stream');
		}

		// Read events from all connections
		const eventPromises = responses.map(response => 
			readSSEEvents(response, 10, 15000)
		);

		const allEvents = await Promise.all(eventPromises);

		// Verify each connection received all 10 events
		for (let clientIdx = 0; clientIdx < allEvents.length; clientIdx++) {
			const events = allEvents[clientIdx];
			assertEquals(events.length, 10, `Client ${clientIdx + 1} should receive 10 events`);

			// Verify event sequence
			for (let i = 0; i < events.length; i++) {
				const data = JSON.parse(events[i].data);
				assertEquals(data.count, i + 1, `Client ${clientIdx + 1} event ${i + 1} should have correct count`);
			}
		}

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E - SSE streaming respects pool configuration', async () => {
	// Create test configuration with stream pool
	const testConfig = {
		noSSL: true,
		httpPort: 0,
		pools: {
			stream: {
				minProcs: 1,
				maxProcs: 1,
				maxWorkers: 1,
				conTimeout: 30, // Connection timeout for streaming
			}
		},
		routes: [
			{
				path: '/clock',
				app: '../examples/applets/sse-clock.esm.js',
				pool: 'stream',
			}
		]
	};

	const { operator } = await createTestServer(testConfig);
	const baseUrl = await startTestServer(operator);

	try {
		// Verify pool is configured correctly
		const poolManager = operator.poolManagers.get('stream');
		assertExists(poolManager, 'Stream pool should exist');

		// Make SSE request
		const response = await fetchWithTimeout(`${baseUrl}/clock`, {}, 15000);
		assertEquals(response.status, 200);

		// Read all events
		const events = await readSSEEvents(response, 10, 15000);
		assertEquals(events.length, 10);

	} finally {
		await stopTestServer(operator);
	}
});
