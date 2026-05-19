/**
 * Tests for JSMAWS Authentication Chain Runner
 * Tests the runAuthnChain() function and related helpers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runAuthnChain, parseCookies, buildAuthContext } from "../src/authn-chain.esm.js";

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
	});

	assertEquals(ctx.method, 'GET');
	assertEquals(ctx.url, 'https://example.com/api/users');
	assertEquals(ctx.headers.authorization, 'Bearer token123');
	assertEquals(ctx.cookies.session, 'abc');
});

Deno.test("buildAuthContext - handles missing headers", () => {
	const ctx = buildAuthContext({
		method: 'GET',
		url: 'https://example.com/',
		headers: null,
	});

	assertEquals(ctx.headers, {});
	assertEquals(ctx.cookies, {});
});

// ============================================================================
// runAuthnChain Tests - No Auth
// ============================================================================

Deno.test("runAuthnChain - allows when no auth chain", async () => {
	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthnChain(ctx, []);

	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
	assertEquals(result.provider, null);
});

Deno.test("runAuthnChain - allows when auth chain is null", async () => {
	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthnChain(ctx, null);

	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
	assertEquals(result.provider, null);
});

// ============================================================================
// runAuthnChain Tests - First Success Stops Chain
// ============================================================================

Deno.test("runAuthnChain - stops at first success (does not accumulate identity)", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (spec) {
			return {
				async authCheck (_ctx) {
					callCount++;
					if (spec === 'provider1') {
						return { allow: true, identity: { sub: 'user-from-provider1' } };
					}
					return { allow: true, identity: { sub: 'user-from-provider2' } };
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthnChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	// First provider succeeded — chain stopped
	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-from-provider1');
	assertEquals(result.provider, 'provider1');
	assertEquals(callCount, 1); // Only first provider called
});

Deno.test("runAuthnChain - tries next provider when first returns null", async () => {
	const mockLoader = {
		async load (spec) {
			return {
				async authCheck (_ctx) {
					if (spec === 'provider1') {
						return null; // Did not authenticate
					}
					return { allow: true, identity: { sub: 'user-from-provider2' } };
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthnChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-from-provider2');
	assertEquals(result.provider, 'provider2');
});

Deno.test("runAuthnChain - allows with null identity when all providers return null", async () => {
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
	const result = await runAuthnChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	// All providers exhausted without success — allow with null identity
	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
	assertEquals(result.provider, null);
});

// ============================================================================
// runAuthnChain Tests - Denial
// ============================================================================

Deno.test("runAuthnChain - short-circuits on explicit denial", async () => {
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
	const result = await runAuthnChain(ctx, [
		{ provider: 'provider1' },
		{ provider: 'provider2' },
	], mockLoader);

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
	assertEquals(callCount, 1); // Only first provider called
});

Deno.test("runAuthnChain - returns 500 on provider load error", async () => {
	const mockLoader = {
		async load (_spec) {
			throw new Error('Module not found');
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthnChain(ctx, [{ provider: 'bad-provider' }], mockLoader);

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 500);
});

Deno.test("runAuthnChain - returns 500 on provider runtime error", async () => {
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
	const result = await runAuthnChain(ctx, [{ provider: 'error-provider' }], mockLoader);

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 500);
});

// ============================================================================
// runAuthnChain Tests - provider in result
// ============================================================================

Deno.test("runAuthnChain - includes provider in success result", async () => {
	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return { allow: true, identity: { sub: 'user-123' } };
				},
			};
		},
	};

	const ctx = buildAuthContext({ method: 'GET', url: 'https://example.com/', headers: {} });
	const result = await runAuthnChain(ctx, [{ provider: '@jwt' }], mockLoader);

	assertEquals(result.allow, true);
	assertEquals(result.provider, '@jwt');
});

// ============================================================================
// OperatorAuthn Tests
// ============================================================================

import { OperatorAuthn } from "../src/operator-authn.esm.js";

Deno.test("OperatorAuthn - allows when no authn configured", async () => {
	const auth = new OperatorAuthn();
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: {},
		topLevelAuthn: [],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity, null);
	assertEquals(result.provider, null);
});

Deno.test("OperatorAuthn - runs top-level authn chain", async () => {
	let usedSpec = null;
	const mockLoader = {
		async load (spec) {
			usedSpec = spec;
			return {
				async authCheck (_ctx) {
					return { allow: true, identity: { sub: 'user', provider: spec } };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer token' },
		topLevelAuthn: [{ provider: 'top-level-provider' }],
	});

	assertEquals(result.allow, true);
	assertEquals(usedSpec, 'top-level-provider');
	assertEquals(result.provider, 'top-level-provider');
});

Deno.test("OperatorAuthn - caches successful authn results", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				// Provider implements extractCacheKey so the operator can cache results
				extractCacheKey (ctx, _config) {
					const auth = ctx.headers?.authorization ?? '';
					return auth ? `mock:${auth}` : null;
				},
				async authCheck (_ctx) {
					callCount++;
					return { allow: true, identity: { sub: 'user-123' }, cacheKey: 'mock:Bearer cached-token' };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer cached-token' },
		topLevelAuthn: [{ provider: 'provider1' }],
	};

	// First call — runs authn
	const result1 = await auth.runAuthn(opts);
	assertEquals(result1.allow, true);
	assertEquals(callCount, 1);

	// Second call with same credential — uses cache
	const result2 = await auth.runAuthn(opts);
	assertEquals(result2.allow, true);
	assertEquals(callCount, 1); // Not called again
});

Deno.test("OperatorAuthn - does not cache denial results", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				extractCacheKey (ctx, _config) {
					const auth = ctx.headers?.authorization ?? '';
					return auth ? `mock:${auth}` : null;
				},
				async authCheck (_ctx) {
					callCount++;
					return { allow: false, denyStatus: 401, denyMessage: 'Unauthorized' };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer bad-token' },
		topLevelAuthn: [{ provider: 'provider1' }],
	};

	// First call — runs authn
	await auth.runAuthn(opts);
	assertEquals(callCount, 1);

	// Second call — denial not cached, runs authn again
	await auth.runAuthn(opts);
	assertEquals(callCount, 2);
});

Deno.test("OperatorAuthn - clearCache invalidates cached results", async () => {
	let callCount = 0;
	const mockLoader = {
		async load (_spec) {
			return {
				extractCacheKey (ctx, _config) {
					const auth = ctx.headers?.authorization ?? '';
					return auth ? `mock:${auth}` : null;
				},
				async authCheck (_ctx) {
					callCount++;
					return { allow: true, identity: { sub: 'user-123' }, cacheKey: 'mock:Bearer token' };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer token' },
		topLevelAuthn: [{ provider: 'provider1' }],
	};

	// First call — runs authn and caches
	await auth.runAuthn(opts);
	assertEquals(callCount, 1);

	// Clear cache
	auth.clearCache();

	// Second call — cache cleared, runs authn again
	await auth.runAuthn(opts);
	assertEquals(callCount, 2);
});
