/**
 * E2E Tests for Auth Sub-Process (Option C) Integration
 *
 * Tests the complete auth sub-process flow:
 * - Auth sub-process spawning via authPool configuration
 * - Chain splitting: operator-resident providers run inline, external providers delegated
 * - External provider delegation via IPC (auth-req/auth-res protocol)
 * - Mixed chains: operator-resident prefix + external suffix
 * - Auth sub-process shutdown and cleanup
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	fetchWithTimeout,
} from './e2e-utils.esm.js';

// Path to the test external auth provider (relative to this test file)
// The auth sub-process will load this via AuthProviderLoader
const EXT_AUTH_PROVIDER = new URL('./ext-auth-provider.esm.js', import.meta.url).pathname;

const AUTH_ECHO_APP = '../examples/apps/auth-echo.esm.js';

const POOL_CONFIG = {
	fast: {
		minProcs: 1,
		maxProcs: 1,
		maxWorkers: 2,
		reqTimeout: 10,
	},
};

// Auth pool configuration for spawning the auth sub-process
const AUTH_POOL_CONFIG = {
	minProcs: 1,
	maxProcs: 1,
	maxWorkers: 1,
	reqTimeout: 10,
};

// ============================================================================
// Auth Sub-Process Spawning Tests
// ============================================================================

Deno.test({
	name: "E2E Auth Process - auth sub-process spawns when authPool is configured",
	async fn () {
		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			routes: [
				{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// Auth pool should be initialized
			assertExists(operator.authPoolManager);

			// Auth delegate should be set on operatorAuthn
			assertExists(operator.operatorAuthn._authDelegate);

			// Basic request should still work (no authn configured)
			const response = await fetchWithTimeout(`${baseUrl}/echo`);
			assertEquals(response.status, 200);
			const body = await response.json();
			assertEquals(body.authenticated, false);

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: "E2E Auth Process - no auth pool when authPool not configured",
	async fn () {
		const { operator } = await createTestServer({
			routes: [
				{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
			],
			pools: POOL_CONFIG,
		});

		try {
			await startTestServer(operator);

			// No auth pool should be initialized
			assertEquals(operator.authPoolManager, null);
			assertEquals(operator.operatorAuthn._authDelegate, null);

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ============================================================================
// External Provider Delegation Tests
// ============================================================================

Deno.test({
	name: "E2E Auth Process - external provider delegated to auth sub-process (valid token)",
	async fn () {
		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			authn: [
				{ provider: EXT_AUTH_PROVIDER },
			],
			routeGroups: {
				extRequired: {
					authn: ['@allow-known', '@deny-all'],
					routes: [
						{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
					],
				},
			},
			routes: [
				{ group: 'extRequired' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// Valid external token — auth sub-process authenticates
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { 'x-ext-token': 'valid-ext-token' },
			});

			assertEquals(response.status, 200);
			const body = await response.json();
			assertEquals(body.authenticated, true);
			assertExists(body.identity);
			assertEquals(body.identity.sub, 'ext-user');
			assertEquals(body.identity.provider, '@ext-test');

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: "E2E Auth Process - external provider denial from auth sub-process",
	async fn () {
		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			authn: [
				{ provider: EXT_AUTH_PROVIDER },
			],
			routes: [
				{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// Deny token — auth sub-process returns explicit denial
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { 'x-ext-token': 'deny-ext-token' },
			});

			// Explicit denial → 401 (before routing)
			assertEquals(response.status, 401);
			await response.body?.cancel();

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: "E2E Auth Process - external provider null result (no token) → null identity",
	async fn () {
		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			authn: [
				{ provider: EXT_AUTH_PROVIDER },
			],
			routeGroups: {
				extRequired: {
					authn: ['@allow-known', '@deny-all'],
					routes: [
						{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
					],
				},
			},
			routes: [
				{ group: 'extRequired' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// No token — external provider returns null → null identity → @allow-known skips → 404
			const response = await fetchWithTimeout(`${baseUrl}/echo`);
			assertEquals(response.status, 404);
			await response.body?.cancel();

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ============================================================================
// Mixed Chain Tests (operator-resident prefix + external suffix)
// ============================================================================

Deno.test({
	name: "E2E Auth Process - mixed chain: operator-resident JWT succeeds (no IPC needed)",
	async fn () {
		// JWT (operator-resident) + external provider
		// JWT succeeds → external provider never called → no IPC
		const NOW = Math.floor(Date.now() / 1000);
		const JWT_SECRET = 'e2e-auth-process-test-secret';

		// Create a simple JWT for testing
		const header = { alg: 'HS256', typ: 'JWT' };
		const payload = { sub: 'jwt-user', iat: NOW, exp: NOW + 3600 };
		const enc = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
		const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
		const keyBytes = new TextEncoder().encode(JWT_SECRET);
		const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const sigBytes = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signingInput));
		const token = `${signingInput}.${new Uint8Array(sigBytes).toBase64({ alphabet: 'base64url', omitPadding: true })}`;

		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			authn: [
				{ provider: '@jwt', secret: JWT_SECRET, algorithm: 'HS256' },
				{ provider: EXT_AUTH_PROVIDER },
			],
			routeGroups: {
				anyAuth: {
					authn: ['@allow-known', '@deny-all'],
					routes: [
						{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
					],
				},
			},
			routes: [
				{ group: 'anyAuth' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// JWT token — operator-resident JWT succeeds inline (no IPC to auth sub-process)
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { authorization: `Bearer ${token}` },
			});

			assertEquals(response.status, 200);
			const body = await response.json();
			assertEquals(body.authenticated, true);
			assertEquals(body.identity.sub, 'jwt-user');
			assertEquals(body.identity.provider, '@jwt');

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: "E2E Auth Process - mixed chain: JWT fails, external provider succeeds via IPC",
	async fn () {
		// JWT (operator-resident) + external provider
		// JWT returns null (no Authorization header) → external provider called via IPC
		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			authn: [
				{ provider: '@jwt', secret: 'some-secret', algorithm: 'HS256' },
				{ provider: EXT_AUTH_PROVIDER },
			],
			routeGroups: {
				anyAuth: {
					authn: ['@allow-known', '@deny-all'],
					routes: [
						{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
					],
				},
			},
			routes: [
				{ group: 'anyAuth' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// External token only — JWT returns null, external provider succeeds via IPC
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { 'x-ext-token': 'valid-ext-token' },
			});

			assertEquals(response.status, 200);
			const body = await response.json();
			assertEquals(body.authenticated, true);
			assertEquals(body.identity.sub, 'ext-user');
			assertEquals(body.identity.provider, '@ext-test');

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: "E2E Auth Process - mixed chain: JWT denial stops chain (external not called)",
	async fn () {
		// JWT (operator-resident) + external provider
		// JWT returns explicit denial → chain stops, external provider NOT called
		const { operator } = await createTestServer({
			authPool: AUTH_POOL_CONFIG,
			authn: [
				{ provider: '@jwt', secret: 'some-secret', algorithm: 'HS256' },
				{ provider: EXT_AUTH_PROVIDER },
			],
			routes: [
				{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// Malformed JWT → JWT returns explicit denial (401) → chain stops
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { authorization: 'Bearer invalid.jwt.token' },
			});

			// JWT explicit denial → 401 (before routing, external provider not called)
			assertEquals(response.status, 401);
			await response.body?.cancel();

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ============================================================================
// Auth Sub-Process Fallback Tests (no authPool configured)
// ============================================================================

Deno.test({
	name: "E2E Auth Process - external provider runs inline when no authPool (fallback)",
	async fn () {
		// No authPool configured → external provider runs inline in operator (fallback)
		const { operator } = await createTestServer({
			// No authPool
			authn: [
				{ provider: EXT_AUTH_PROVIDER },
			],
			routeGroups: {
				extRequired: {
					authn: ['@allow-known', '@deny-all'],
					routes: [
						{ path: '/echo', app: AUTH_ECHO_APP, pool: 'fast' },
					],
				},
			},
			routes: [
				{ group: 'extRequired' },
			],
			pools: POOL_CONFIG,
		});

		try {
			const baseUrl = await startTestServer(operator);

			// No auth pool — external provider runs inline
			assertEquals(operator.authPoolManager, null);

			// Valid external token — inline fallback authenticates
			const response = await fetchWithTimeout(`${baseUrl}/echo`, {
				headers: { 'x-ext-token': 'valid-ext-token' },
			});

			assertEquals(response.status, 200);
			const body = await response.json();
			assertEquals(body.authenticated, true);
			assertEquals(body.identity.sub, 'ext-user');

		} finally {
			await stopTestServer(operator);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});
