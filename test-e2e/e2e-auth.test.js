/**
 * E2E Tests for Authentication Integration
 *
 * Tests the complete authentication flow through the actual server.
 *
 * Architecture (per auth-revisions-20260510.md 2026-05-11-A/B):
 * - Top-level authn runs before routing; stops at first successful identification
 * - Route-group authn is a scalar filter on the already-computed identity
 * - @allow-known: allows if identity is present (presents identity)
 * - @allow-all: always allows (suppresses identity)
 * - @deny-all: always skips the group (results in 404)
 * - Provider name (e.g. '@jwt'): allows if identity came from that provider
 * - Implied [@allow-known @allow-all] at end of filter
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
	// Route group with @allow-known filter: only allows if identity is present
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'valid-key-1,valid-key-2' },
		],
		routeGroups: {
			apiKeyRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'apiKeyRequired' },
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

Deno.test("E2E Auth - API key: invalid key results in 404 (group skipped, no identity)", async () => {
	// Route group with @allow-known filter: skips group when no identity
	// Invalid key → null (try next) → all exhausted → null identity → @allow-known skips group → 404
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'valid-key-1' },
		],
		routeGroups: {
			apiKeyRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'apiKeyRequired' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`, {
			headers: { 'x-api-key': 'invalid-key' },
		});

		// Invalid key → null identity → @allow-known skips group → 404
		assertEquals(response.status, 404);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - API key: missing key results in 404 (no identity)", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'valid-key-1' },
		],
		routeGroups: {
			apiKeyRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'apiKeyRequired' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		// No x-api-key header → null identity → @allow-known skips → @deny-all skips group → 404
		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 404);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - API key: keyMap resolves subject", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keyMap: { 'key-abc': 'alice', 'key-def': 'bob' } },
		],
		routeGroups: {
			apiKeyRequired: {
				authn: '@allow-known',
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'apiKeyRequired' },
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
		routeGroups: {
			basicRequired: {
				authn: '@allow-known',
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'basicRequired' },
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

Deno.test("E2E Auth - Basic: wrong password results in 404 (null identity)", async () => {
	// Wrong password → null (try next) → all exhausted → null identity → @allow-known skips → @deny-all skips → 404
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@basic', users: { alice: 'secret' } },
		],
		routeGroups: {
			basicRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'basicRequired' },
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

		assertEquals(response.status, 404);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - Basic: missing Authorization results in 404 (null identity)", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@basic', users: { alice: 'secret' }, realm: 'MyApp' },
		],
		routeGroups: {
			basicRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'basicRequired' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		assertEquals(response.status, 404);
		await response.body?.cancel();

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
		routeGroups: {
			jwtRequired: {
				authn: '@allow-known',
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'jwtRequired' },
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

Deno.test("E2E Auth - JWT: invalid token (bad signature) returns 401 (explicit denial)", async () => {
	// Bad signature → allow: false → 401 (explicit denial, not null)
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

		// Bad signature → allow: false → 401 (explicit denial before routing)
		assertEquals(response.status, 401);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: missing token results in 404 (null identity, group skipped)", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET },
		],
		routeGroups: {
			jwtRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'jwtRequired' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/echo`);

		// No token → null identity → @allow-known skips group → 404
		assertEquals(response.status, 404);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - JWT: expired token results in 404 (null identity, not malicious)", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW - 7200, exp: NOW - 3600 }, // Expired 1 hour ago
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET },
		],
		routeGroups: {
			jwtRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'jwtRequired' },
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

		// Expired → null (not malicious) → null identity → @allow-known skips → 404
		assertEquals(response.status, 404);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

// ============================================================================
// Route Group authn Filter Tests
// ============================================================================

Deno.test("E2E Auth - route group @allow-known requires identity", async () => {
	// Top-level: API key auth
	// Route group 'protectedGroup': @allow-known (only allows if identity present)
	// /protected uses route group authn (@allow-known, key required)
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'required-key' },
		],
		routeGroups: {
			protectedGroup: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/protected', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'protectedGroup' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Without key — null identity → @allow-known skips group → 404
		const noKeyResponse = await fetchWithTimeout(`${baseUrl}/protected`);
		assertEquals(noKeyResponse.status, 404);
		await noKeyResponse.body?.cancel();

		// With valid key — identity present → @allow-known presents identity → 200
		const withKeyResponse = await fetchWithTimeout(`${baseUrl}/protected`, {
			headers: { 'x-api-key': 'required-key' },
		});
		assertEquals(withKeyResponse.status, 200);
		const body = await withKeyResponse.json();
		assertEquals(body.identity.sub, 'required-key');

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - route group @allow-all allows all (suppresses identity)", async () => {
	// Top-level: API key auth
	// Route group 'publicGroup': @allow-all (allows all, suppresses identity)
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@api-key', keys: 'required-key' },
		],
		routeGroups: {
			publicGroup: {
				authn: '@allow-all',
				routes: [
					{ path: '/public', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'publicGroup' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		// Without key — @allow-all allows, identity suppressed
		const noKeyResponse = await fetchWithTimeout(`${baseUrl}/public`);
		assertEquals(noKeyResponse.status, 200);
		const noKeyBody = await noKeyResponse.json();
		assertEquals(noKeyBody.authenticated, false); // Identity suppressed
		assertEquals(noKeyBody.identity, null);

		// With valid key — @allow-all still suppresses identity
		const withKeyResponse = await fetchWithTimeout(`${baseUrl}/public`, {
			headers: { 'x-api-key': 'required-key' },
		});
		assertEquals(withKeyResponse.status, 200);
		const withKeyBody = await withKeyResponse.json();
		assertEquals(withKeyBody.authenticated, false); // Identity suppressed by @allow-all
		assertEquals(withKeyBody.identity, null);

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - route group @deny-all skips group (results in 404)", async () => {
	const { operator } = await createTestServer({
		routeGroups: {
			deniedGroup: {
				authn: '@deny-all',
				routes: [
					{ path: '/denied', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'deniedGroup' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/denied`);

		// @deny-all skips the group → 404 (no other routes)
		assertEquals(response.status, 404);
		await response.body?.cancel();

	} finally {
		await stopTestServer(operator);
	}
});

Deno.test("E2E Auth - route group role check passes when user has required role", async () => {
	const token = await createTestJwt(
		{ sub: 'admin-user', roles: ['admin', 'user'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET, algorithm: 'HS256' },
		],
		routeGroups: {
			adminGroup: {
				role: 'admin',
				routes: [
					{ path: '/admin', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'adminGroup' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/admin`, {
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

Deno.test("E2E Auth - route group role check skips group when user lacks required role", async () => {
	const token = await createTestJwt(
		{ sub: 'regular-user', roles: ['user'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const { operator } = await createTestServer({
		authn: [
			{ provider: '@jwt', secret: JWT_SECRET, algorithm: 'HS256' },
		],
		routeGroups: {
			adminGroup: {
				role: 'admin',
				routes: [
					{ path: '/admin', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'adminGroup' },
		],
		pools: POOL_CONFIG,
	});

	try {
		const baseUrl = await startTestServer(operator);

		const response = await fetchWithTimeout(`${baseUrl}/admin`, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});

		// User lacks 'admin' role → group skipped → 404
		assertEquals(response.status, 404);
		await response.body?.cancel();

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
		routeGroups: {
			apiKeyRequired: {
				authn: ['@allow-known', '@deny-all'],
				routes: [
					{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
				],
			},
		},
		routes: [
			{ group: 'apiKeyRequired' },
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

// ============================================================================
// @test-identity Provider Tests
// ============================================================================

Deno.test("E2E Auth - @test-identity always succeeds with configurable identity", async () => {
	const { operator } = await createTestServer({
		authn: [
			{ provider: '@test-identity', identity: { sub: 'test-user', roles: ['tester'] } },
		],
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
		assertEquals(body.authenticated, true);
		assertEquals(body.identity.sub, 'test-user');
		assertEquals(body.identity.provider, '@test-identity');

	} finally {
		await stopTestServer(operator);
	}
});
