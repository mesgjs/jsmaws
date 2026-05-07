/**
 * E2E Tests for Basic HTTP Request/Response
 * 
 * Tests the complete request flow through the actual server with real mod-apps.
 * No mocks - this tests the entire system end-to-end.
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	fetchWithTimeout
} from './e2e-utils.esm.js';

Deno.test("E2E - Simple GET request to hello-world mod-app", async () => {
	// Create test configuration with hello-world route
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', method: ['get'], app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: {
				minProcs: 1,
				maxProcs: 1,
				maxWorkers: 2,
				reqTimeout: 5
			}
		}
	});

	try {
		// Start the server
		const baseUrl = await startTestServer(operator);

		// Make request to hello-world mod-app
		const response = await fetchWithTimeout(`${baseUrl}/hello`);

		// Verify response
		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'application/json');

		const body = await response.json();
		assertExists(body.message);
		assertEquals(body.message, 'Hello, World!');
		assertEquals(body.method, 'GET');
		assertEquals(body.path, '/hello');
		assertExists(body.timestamp);

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E - GET request with query parameters", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: { minProcs: 2, maxProcs: 2 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Request with query parameters
		const response = await fetchWithTimeout(`${baseUrl}/hello?name=Alice&greeting=Hi`);

		assertEquals(response.status, 200);

		const body = await response.json();
		assertEquals(body.message, 'Hi, Alice!');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E - POST request with JSON body", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', method: ['post'], app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);

		// POST request with JSON body
		const response = await fetchWithTimeout(`${baseUrl}/hello`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				name: 'Bob',
				greeting: 'Howdy'
			})
		});

		assertEquals(response.status, 200);

		const body = await response.json();
		assertEquals(body.message, 'Howdy, Bob!');
		assertEquals(body.method, 'POST');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E - POST request with form-encoded body", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', method: ['post'], app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);

		// POST request with form-encoded body
		const params = new URLSearchParams();
		params.append('name', 'Charlie');
		params.append('greeting', 'Hey');

		const response = await fetchWithTimeout(`${baseUrl}/hello`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: params.toString()
		});

		assertEquals(response.status, 200);

		const body = await response.json();
		assertEquals(body.message, 'Hey, Charlie!');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E - 404 for non-existent route", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Request non-existent route
		const response = await fetchWithTimeout(`${baseUrl}/nonexistent`);

		assertEquals(response.status, 404);
		assertEquals(response.headers.get('content-type'), 'application/json');

		const body = await response.json();
		assertEquals(body.error, '404 Not Found');
		assertEquals(body.path, '/nonexistent');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E - Multiple concurrent requests", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: {
				minProcs: 1,
				maxProcs: 3,
				maxWorkers: 4,
			}
		}
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Make multiple concurrent requests
		const requests = [];
		for (let i = 0; i < 10; i++) {
			requests.push(
				fetchWithTimeout(`${baseUrl}/hello?name=User${i}`)
			);
		}

		const responses = await Promise.all(requests);

		// Verify all responses
		for (let i = 0; i < 10; i++) {
			assertEquals(responses[i].status, 200);
			const body = await responses[i].json();
			assertEquals(body.message, `Hello, User${i}!`);
		}

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E - Request with custom headers", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/hello', app: '../examples/apps/hello-world.esm.js', pool: 'fast' }
		],
		pools: {
			fast: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Request with custom headers
		const response = await fetchWithTimeout(`${baseUrl}/hello`, {
			headers: {
				'X-Custom-Header': 'test-value',
				'User-Agent': 'E2E-Test/1.0'
			}
		});

		assertEquals(response.status, 200);

		const body = await response.json();
		assertExists(body.message);

	} finally {
		await stopTestServer(operator);
	}
});
