/**
 * E2E Tests for Authentication Integration
 *
 * Tests the complete authentication flow through the actual server:
 * - API key authentication
 * - HTTP Basic authentication
 * - JWT authentication
 * - Identity pass-through to mod-apps
 * - Route group authn overrides
 * - No auth (unauthenticated allowed)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	fetchWithTimeout,
} from './e2e-utils.esm.js';

// ============================================================================
// JWT Test Helpers
// ============================================================================

/**
 * Create a signed HS256 JWT for testing.
 */
async function createTestJwt (payload, secret) {
	const header = { alg: 'HS256', typ: 'JWT' };
	const headerB64 = encodeBase64Url(JSON.stringify(header));
	const payloadB64 = encodeBase64Url(JSON.stringify(payload));
	const signingInput = `${headerB64}.${payloadB64}`;

	const keyBytes = new TextEncoder().encode(secret);
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signatureBytes = await crypto.subtle.sign(
		'HMAC',
		cryptoKey,
		new TextEncoder().encode(signingInput)
	);

	const signatureB64 = encodeBase64Url(new Uint8Array(signatureBytes));
	return `${signingInput}.${signatureB64}`;
}

/**
 * Base64url encode a Uint8Array or string
 */
function encodeBase64Url (data) {
	if (data instanceof Uint8Array) return data.toBase64({ alphabet: 'base64url', omitPadding: true });
	return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const NOW = Math.floor(Date.now() / 1000);
const JWT_SECRET = 'e2e-test-jwt-secret';

// ============================================================================
// Common test configuration
// ============================================================================

const AUTH_ECHO_APP = '../examples/apps/auth-echo.esm.js';
const POOL_CONFIG = {
	fast: {
		minProcs: 1,
		maxProcs: 1,
		maxWorkers: 2,
		reqTimeout: 10,
	},
};

// ============================================================================
// No Auth Tests
// ============================================================================

Deno.test("E2E Auth - unauthenticated request allowed when no authn configured", async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.authenticated, false);
		assertEquals(body.identity, null);

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// API Key Auth Tests
// ============================================================================

Deno.test("E2E Auth - API key: valid key allows request and passes identity", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'valid-key-1,valid-key-2' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: { 'x-api-key': 'valid-key-1' },
		});

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.authenticated, true);
		assertExists(body.identity);
		assertEquals(body.identity.sub, 'valid-key-1');
		assertEquals(body.identity.provider, '@api-key');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - API key: invalid key returns 401", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'valid-key-1' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: { 'x-api-key': 'invalid-key' },
		});

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - API key: missing key returns 401", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'valid-key-1' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		// No x-api-key header
		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - API key: keyMap resolves subject", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keyMap: { 'key-abc': 'alice', 'key-def': 'bob' } },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: { 'x-api-key': 'key-abc' },
		});

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.identity.sub, 'alice');

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// HTTP Basic Auth Tests
// ============================================================================

Deno.test("E2E Auth - Basic: valid credentials allow request and pass identity", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@basic', users: { alice: 'secret', bob: 'pass' }, realm: 'TestApp' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: `Basic ${btoa('alice:secret')}`,
			},
		});

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.authenticated, true);
		assertEquals(body.identity.sub, 'alice');
		assertEquals(body.identity.provider, '@basic');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - Basic: wrong password returns 401", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@basic', users: { alice: 'secret' } },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: `Basic ${btoa('alice:wrong')}`,
			},
		});

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - Basic: missing Authorization returns 401", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@basic', users: { alice: 'secret' }, realm: 'MyApp' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// JWT Auth Tests
// ============================================================================

Deno.test("E2E Auth - JWT: valid token allows request and passes identity", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', roles: ['user'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET, algorithm: 'HS256' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.authenticated, true);
		assertEquals(body.identity.sub, 'user-123');
		assertEquals(body.identity.provider, '@jwt');
		assertEquals(body.identity.roles, ['user']);

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: invalid token returns 401", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: 'Bearer invalid.jwt.token',
			},
		});

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: missing token returns 401", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: expired token returns 401", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW - 7200, exp: NOW - 3600 }, // Expired 1 hour ago
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});

		assertEquals(response.status, 401);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: role check passes when user has required role", async () => {
	const token = await createTestJwt(
		{ sub: 'admin-user', roles: ['admin', 'user'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET, roles: ['admin'] },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});

		assertEquals(response.status, 200);
		const body = await response.json();
		assertEquals(body.identity.sub, 'admin-user');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: role check fails when user lacks required role (403)", async () => {
	const token = await createTestJwt(
		{ sub: 'regular-user', roles: ['user'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET, roles: ['admin'] },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});

		assertEquals(response.status, 403);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// Route Group authn Override Tests
// ============================================================================

Deno.test("E2E Auth - route group authn overrides top-level authn", async () => {
	// Top-level: API key auth
	// Route group 'publicGroup': @allow-all (overrides top-level for /public)
	// /protected uses top-level authn (API key required)
	// /public uses route group authn (@allow-all, no key needed)
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'required-key' },
		],
		routeGroups: {
			publicGroup: {
				authn: [
					{ provider: '@allow-all' },
				],
				routes: [
					{ path: '/public', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'publicGroup' },
			{ path: '/protected', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		// /public uses route group authn (@allow-all) — no key needed
		const publicResponse = await fetchWithTimeout(`${baseUrl}/public`);
		assertEquals(publicResponse.status, 200);
		const publicBody = await publicResponse.json();
		assertEquals(publicBody.authenticated, false); // @allow-all returns null identity

		// /protected uses top-level authn (@api-key) — key required
		const protectedResponse = await fetchWithTimeout(`${baseUrl}/protected`);
		assertEquals(protectedResponse.status, 401);
		await protectedResponse.body?.cancel(); // Consume body to avoid leak

		// /protected with valid key — allowed
		const protectedWithKeyResponse = await fetchWithTimeout(`${baseUrl}/protected`, {
			headers: { 'x-api-key': 'required-key' },
		});
		assertEquals(protectedWithKeyResponse.status, 200);
		const protectedBody = await protectedWithKeyResponse.json();
		assertEquals(protectedBody.identity.sub, 'required-key');

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// @deny-all Tests
// ============================================================================

Deno.test("E2E Auth - @deny-all blocks all requests", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@deny-all', status: 403, message: 'Access Denied' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 403);
		await response.body?.cancel(); // Consume body to avoid leak

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// Auth Cache Tests
// ============================================================================

Deno.test("E2E Auth - auth result is cached for repeated requests", async () => {
	// Verify that repeated requests with the same credentials succeed consistently
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'cached-key' },
		],
		routes: [
			{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Make multiple requests with the same API key
		for (let i = 0; i < 3; i++) {
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { 'x-api-key': 'cached-key' },
			});
			assertEquals(response.status, 200);
			const body = await response.json();
			assertEquals(body.identity.sub, 'cached-key');
		}

	} finally {
		await stopTestServer(operator);
	}
});
