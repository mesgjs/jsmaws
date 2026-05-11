/**
 * Tests for JSMAWS Auth Middleware
 * Tests the runAuthChain() function and related helpers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runAuthChain, parseCookies, buildAuthContext } from "../src/auth-middleware.esm.js";

// ============================================================================
// parseCookies Tests
// ============================================================================

Deno.test("parseCookies - parses empty string", () => {
	assertEquals(parseCookies(''), {});
});

Deno.test("parseCookies - parses null/undefined", () => {
	assertEquals(parseCookies(null), {});
	assertEquals(parseCookies(undefined), {});
});

Deno.test("parseCookies - parses single cookie", () => {
	assertEquals(parseCookies('session=abc123'), { session: 'abc123' });
});

Deno.test("parseCookies - parses multiple cookies", () => {
	assertEquals(parseCookies('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' });
});

Deno.test("parseCookies - handles cookie with equals in value", () => {
	const result = parseCookies('token=abc=def');
	assertEquals(result.token, 'abc=def');
});

// ============================================================================
// buildAuthContext Tests
// ============================================================================

Deno.test("buildAuthContext - builds context from request info", () => {
	const ctx = buildAuthContext({
		method: 'GET',
		url: 'https://example.com/api/users',
		headers: { authorization: 'Bearer token123', cookie: 'session=abc' },
		routeSpec: { path: 'api/users', pool: 'standard' },
		poolName: 'standard',
	});

	assertEquals(ctx.method, 'GET');
	assertEquals(ctx.url, 'https://example.com/api/users');
	assertEquals(ctx.headers.authorization, 'Bearer token123');
	assertEquals(ctx.cookies.session, 'abc');
	assertEquals(ctx.poolName, 'standard');
	assertExists(ctx.routeSpec);
});

Deno.test("buildAuthContext - handles missing headers", () => {
	const ctx = buildAuthContext({
		method: 'GET',
		url: 'https://example.com/',
		headers: null,
		routeSpec: null,
		poolName: null,
	});

	assertEquals(ctx.headers, {});
	assertEquals(ctx.cookies, {});
	assertEquals(ctx.poolName, 'standard');
	assertEquals(ctx.routeSpec, null);
});

// ============================================================================
// runAuthChain Tests - No Auth
// ============================================================================

Deno.test("runAuthChain - allows when no auth chain", async () => {
	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, []);

	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
	assertEquals(result.addHeaders, {});
});

Deno.test("runAuthChain - allows when auth chain is null", async () => {
	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, null);

	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
});

// ============================================================================
// runAuthChain Tests - First Success Stops Chain
// ============================================================================

Deno.test("runAuthChain - stops at first success (does not accumulate identity)", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (spec) {
			return {
				async authCheck (ctx) {
					callCount++;
					if (spec === 'provider1') {
						return { allow: true, identity: { sub: 'user-from-provider1' }, addHeaders: {} };
					}
					return { allow: true, identity: { sub: 'user-from-provider2' }, addHeaders: {} };
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	// First provider succeeded — chain stopped
	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-from-provider1');
	assertEquals(callCount, 1); // Only first provider called
});

Deno.test("runAuthChain - tries next provider when first returns null", async () => {
	const mockLoader = {
		async load (spec) {
			return {
				async authCheck (ctx) {
					if (spec === 'provider1') {
						return null; // Did not authenticate
					}
					return { allow: true, identity: { sub: 'user-from-provider2' }, addHeaders: {} };
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-from-provider2');
});

Deno.test("runAuthChain - allows with null identity when all providers return null", async () => {
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return null; // Did not authenticate
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	// All providers exhausted without success — allow with null identity
	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
});

// ============================================================================
// runAuthChain Tests - Denial
// ============================================================================

Deno.test("runAuthChain - short-circuits on explicit denial", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					callCount++;
					return { allow: false, denyStatus: 401, denyMessage: 'Unauthorized' };
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
	assertEquals(callCount, 1); // Only first provider called
});

Deno.test("runAuthChain - returns 500 on provider load error", async () => {
	const mockLoader = {
		async load (_spec) {
			throw new Error('Module not found');
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [{ provider: 'bad-provider' }], mockLoader);

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 500);
});

Deno.test("runAuthChain - returns 500 on provider runtime error", async () => {
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					throw new Error('Runtime error');
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [{ provider: 'error-provider' }], mockLoader);

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 500);
});

// ============================================================================
// runAuthChain Tests - addHeaders
// ============================================================================

Deno.test("runAuthChain - returns addHeaders from successful provider", async () => {
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return {
						allow: true,
						identity: { sub: 'user-123' },
						addHeaders: { 'x-user-id': 'user-123', 'x-user-role': 'admin' },
					};
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [{ provider: 'provider1' }], mockLoader);

	assertEquals(result.allow, true);
	assertEquals(result.addHeaders['x-user-id'], 'user-123');
	assertEquals(result.addHeaders['x-user-role'], 'admin');
});

Deno.test("runAuthChain - returns empty addHeaders when provider returns none", async () => {
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return { allow: true, identity: { sub: 'user-123' } }; // No addHeaders
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthChain(ctx, [{ provider: 'provider1' }], mockLoader);

	assertEquals(result.allow, true);
	assertEquals(result.addHeaders, {});
});

// ============================================================================
// OperatorAuth Tests
// ============================================================================

import { OperatorAuth } from "../src/operator-auth.esm.js";

Deno.test("OperatorAuth - allows when no authn configured", async () => {
	const auth = new OperatorAuth();
	const result = await auth.runAuth({
		method: 'GET',
		url: 'https://example.com/',
		headers: {},
		routeSpec: null,
		poolName: 'standard',
		routeGroup: null,
		topLevelAuthn: [],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
});

Deno.test("OperatorAuth - uses route-group authn over top-level authn", async () => {
	let usedChain = null;
	const mockLoader = {
		async load (spec) {
			usedChain = spec;
			return {
				async authCheck (_ctx) {
					return { allow: true, identity: { sub: 'user', provider: spec }, addHeaders: {} };
				},
			};
		},
	};

	const auth = new OperatorAuth({ loader: mockLoader });
	const result = await auth.runAuth({
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer token' },
		routeSpec: null,
		poolName: 'standard',
		routeGroup: { authn: [{ provider: 'group-provider' }] },
		topLevelAuthn: [{ provider: 'top-level-provider' }],
	});

	assertEquals(result.allow, true);
	assertEquals(usedChain, 'group-provider'); // Route-group authn was used
});

Deno.test("OperatorAuth - falls back to top-level authn when no route-group authn", async () => {
	let usedChain = null;
	const mockLoader = {
		async load (spec) {
			usedChain = spec;
			return {
				async authCheck (_ctx) {
					return { allow: true, identity: { sub: 'user', provider: spec }, addHeaders: {} };
				},
			};
		},
	};

	const auth = new OperatorAuth({ loader: mockLoader });
	const result = await auth.runAuth({
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer token' },
		routeSpec: null,
		poolName: 'standard',
		routeGroup: { requestFilter: {} }, // Route group without authn
		topLevelAuthn: [{ provider: 'top-level-provider' }],
	});

	assertEquals(result.allow, true);
	assertEquals(usedChain, 'top-level-provider'); // Top-level authn was used
});

Deno.test("OperatorAuth - caches successful auth results", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					callCount++;
					return { allow: true, identity: { sub: 'user-123' }, addHeaders: {} };
				},
			};
		},
	};

	const auth = new OperatorAuth({ loader: mockLoader });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer cached-token' },
		routeSpec: null,
		poolName: 'standard',
		routeGroup: null,
		topLevelAuthn: [{ provider: 'provider1' }],
	};

	// First call — runs auth
	const result1 = await auth.runAuth(opts);
	assertEquals(result1.allow, true);
	assertEquals(callCount, 1);

	// Second call with same credential — uses cache
	const result2 = await auth.runAuth(opts);
	assertEquals(result2.allow, true);
	assertEquals(callCount, 1); // Not called again
});

Deno.test("OperatorAuth - does not cache denial results", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					callCount++;
					return { allow: false, denyStatus: 401, denyMessage: 'Unauthorized' };
				},
			};
		},
	};

	const auth = new OperatorAuth({ loader: mockLoader });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer bad-token' },
		routeSpec: null,
		poolName: 'standard',
		routeGroup: null,
		topLevelAuthn: [{ provider: 'provider1' }],
	};

	// First call — runs auth
	await auth.runAuth(opts);
	assertEquals(callCount, 1);

	// Second call — denial not cached, runs auth again
	await auth.runAuth(opts);
	assertEquals(callCount, 2);
});

Deno.test("OperatorAuth - clearCache invalidates cached results", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					callCount++;
					return { allow: true, identity: { sub: 'user-123' }, addHeaders: {} };
				},
			};
		},
	};

	const auth = new OperatorAuth({ loader: mockLoader });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer token' },
		routeSpec: null,
		poolName: 'standard',
		routeGroup: null,
		topLevelAuthn: [{ provider: 'provider1' }],
	};

	// First call — runs auth and caches
	await auth.runAuth(opts);
	assertEquals(callCount, 1);

	// Clear cache
	auth.clearCache();

	// Second call — cache cleared, runs auth again
	await auth.runAuth(opts);
	assertEquals(callCount, 2);
});
