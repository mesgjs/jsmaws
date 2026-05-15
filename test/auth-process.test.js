/**
 * Tests for JSMAWS Auth Sub-Process and Auth Delegation
 *
 * Tests:
 * - OPR_AUTH_PROVIDERS set (operator-resident provider classification)
 * - splitAuthChain() (chain splitting at first external provider)
 * - OperatorAuthn with chain splitting and external delegation
 * - OperatorAuthDelegate (IPC delegation to auth sub-process)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { OPR_AUTH_PROVIDERS, splitAuthChain, OperatorAuthn } from "../src/operator-authn.esm.js";
import { OperatorAuthDelegate } from "../src/operator-auth-delegate.esm.js";

// ============================================================================
// OPR_AUTH_PROVIDERS Tests
// ============================================================================

Deno.test("OPR_AUTH_PROVIDERS - contains expected operator-resident providers", () => {
	assertEquals(OPR_AUTH_PROVIDERS.has('@test-identity'), true);
	assertEquals(OPR_AUTH_PROVIDERS.has('@jwt'), true);
	assertEquals(OPR_AUTH_PROVIDERS.has('@api-key'), true);
	assertEquals(OPR_AUTH_PROVIDERS.has('@basic'), true);
});

Deno.test("OPR_AUTH_PROVIDERS - does not contain external providers", () => {
	assertEquals(OPR_AUTH_PROVIDERS.has('@session'), false);
	assertEquals(OPR_AUTH_PROVIDERS.has('@oauth-is'), false);
	assertEquals(OPR_AUTH_PROVIDERS.has('./custom-provider.esm.js'), false);
});

// ============================================================================
// splitAuthChain Tests
// ============================================================================

Deno.test("splitAuthChain - empty chain returns empty arrays", () => {
	const { oprChain, extChain } = splitAuthChain([]);
	assertEquals(oprChain, []);
	assertEquals(extChain, []);
});

Deno.test("splitAuthChain - null chain returns empty arrays", () => {
	const { oprChain, extChain } = splitAuthChain(null);
	assertEquals(oprChain, []);
	assertEquals(extChain, []);
});

Deno.test("splitAuthChain - all operator-resident providers go to oprChain", () => {
	const chain = [
		{ provider: '@jwt', secret: 'abc' },
		{ provider: '@api-key', keys: 'key1' },
		{ provider: '@basic', users: { alice: 'pass' } },
	];
	const { oprChain, extChain } = splitAuthChain(chain);
	assertEquals(oprChain.length, 3);
	assertEquals(extChain.length, 0);
	assertEquals(oprChain[0].provider, '@jwt');
	assertEquals(oprChain[1].provider, '@api-key');
	assertEquals(oprChain[2].provider, '@basic');
});

Deno.test("splitAuthChain - all external providers go to extChain", () => {
	const chain = [
		{ provider: '@session', store: 'redis://localhost' },
		{ provider: '@oauth-is', introspectUrl: 'https://auth.example.com' },
	];
	const { oprChain, extChain } = splitAuthChain(chain);
	assertEquals(oprChain.length, 0);
	assertEquals(extChain.length, 2);
	assertEquals(extChain[0].provider, '@session');
	assertEquals(extChain[1].provider, '@oauth-is');
});

Deno.test("splitAuthChain - splits at first external provider", () => {
	const chain = [
		{ provider: '@jwt', secret: 'abc' },
		{ provider: '@api-key', keys: 'key1' },
		{ provider: '@session', store: 'redis://localhost' },
		{ provider: '@oauth-is', introspectUrl: 'https://auth.example.com' },
	];
	const { oprChain, extChain } = splitAuthChain(chain);
	assertEquals(oprChain.length, 2);
	assertEquals(extChain.length, 2);
	assertEquals(oprChain[0].provider, '@jwt');
	assertEquals(oprChain[1].provider, '@api-key');
	assertEquals(extChain[0].provider, '@session');
	assertEquals(extChain[1].provider, '@oauth-is');
});

Deno.test("splitAuthChain - custom path is treated as external", () => {
	const chain = [
		{ provider: '@jwt', secret: 'abc' },
		{ provider: './my-custom-provider.esm.js' },
	];
	const { oprChain, extChain } = splitAuthChain(chain);
	assertEquals(oprChain.length, 1);
	assertEquals(extChain.length, 1);
	assertEquals(oprChain[0].provider, '@jwt');
	assertEquals(extChain[0].provider, './my-custom-provider.esm.js');
});

Deno.test("splitAuthChain - external provider first means empty oprChain", () => {
	const chain = [
		{ provider: '@session', store: 'redis://localhost' },
		{ provider: '@jwt', secret: 'abc' },
	];
	const { oprChain, extChain } = splitAuthChain(chain);
	assertEquals(oprChain.length, 0);
	assertEquals(extChain.length, 2); // Both go to extChain (split at first external)
});

Deno.test("splitAuthChain - entries without provider are skipped in split logic", () => {
	const chain = [
		{ provider: '@jwt', secret: 'abc' },
		{}, // No provider — skipped
		{ provider: '@session', store: 'redis://localhost' },
	];
	const { oprChain, extChain } = splitAuthChain(chain);
	// The empty entry is before @session, so split is at index 2 (the @session entry)
	assertEquals(oprChain.length, 2); // @jwt + empty entry
	assertEquals(extChain.length, 1);
	assertEquals(extChain[0].provider, '@session');
});

// ============================================================================
// OperatorAuthn - Chain Splitting Tests
// ============================================================================

Deno.test("OperatorAuthn - runs operator-resident chain inline when no external providers", async () => {
	let calledWith = null;
	const mockLoader = {
		async load (spec) {
			return {
				async authCheck (ctx) {
					calledWith = spec;
					return { allow: true, identity: { sub: 'user-123' } };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer token' },
		topLevelAuthn: [{ provider: '@jwt', secret: 'abc' }],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-123');
	assertEquals(calledWith, '@jwt');
});

Deno.test("OperatorAuthn - delegates external chain when authDelegate is set", async () => {
	let delegateCalled = false;
	let delegateChain = null;

	const mockDelegate = {
		async runAuthn ({ authChain }) {
			delegateCalled = true;
			delegateChain = authChain;
			return { allow: true, identity: { sub: 'session-user' }, provider: '@session' };
		},
	};

	const auth = new OperatorAuthn({ authDelegate: mockDelegate });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { cookie: 'session=abc123' },
		topLevelAuthn: [{ provider: '@session', store: 'redis://localhost' }],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'session-user');
	assertEquals(delegateCalled, true);
	assertEquals(delegateChain.length, 1);
	assertEquals(delegateChain[0].provider, '@session');
});

Deno.test("OperatorAuthn - operator-resident success skips external delegation", async () => {
	let delegateCalled = false;
	const mockDelegate = {
		async runAuthn () {
			delegateCalled = true;
			return { allow: true, identity: { sub: 'session-user' }, provider: '@session' };
		},
	};

	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return { allow: true, identity: { sub: 'jwt-user' } };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader, authDelegate: mockDelegate });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer valid-token' },
		topLevelAuthn: [
			{ provider: '@jwt', secret: 'abc' },
			{ provider: '@session', store: 'redis://localhost' },
		],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'jwt-user');
	assertEquals(delegateCalled, false); // Delegate NOT called — JWT succeeded inline
});

Deno.test("OperatorAuthn - falls through to external when operator-resident exhausted", async () => {
	let delegateCalled = false;

	const mockDelegate = {
		async runAuthn ({ authChain }) {
			delegateCalled = true;
			return { allow: true, identity: { sub: 'session-user' }, provider: '@session' };
		},
	};

	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return null; // Did not authenticate
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader, authDelegate: mockDelegate });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { cookie: 'session=abc123' },
		topLevelAuthn: [
			{ provider: '@jwt', secret: 'abc' },
			{ provider: '@session', store: 'redis://localhost' },
		],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'session-user');
	assertEquals(delegateCalled, true);
});

Deno.test("OperatorAuthn - operator-resident denial stops chain (no external delegation)", async () => {
	let delegateCalled = false;

	const mockDelegate = {
		async runAuthn () {
			delegateCalled = true;
			return { allow: true, identity: { sub: 'session-user' }, provider: '@session' };
		},
	};

	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return { allow: false, denyStatus: 401, denyMessage: 'Invalid token' };
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader, authDelegate: mockDelegate });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer bad-token' },
		topLevelAuthn: [
			{ provider: '@jwt', secret: 'abc' },
			{ provider: '@session', store: 'redis://localhost' },
		],
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
	assertEquals(delegateCalled, false); // Delegate NOT called — JWT denied inline
});

Deno.test("OperatorAuthn - runs external chain inline when no authDelegate (fallback)", async () => {
	let calledWith = null;
	const mockLoader = {
		async load (spec) {
			return {
				async authCheck (_ctx) {
					calledWith = spec;
					return { allow: true, identity: { sub: 'session-user' } };
				},
			};
		},
	};

	// No authDelegate — external providers run inline as fallback
	const auth = new OperatorAuthn({ loader: mockLoader });
	const result = await auth.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { cookie: 'session=abc123' },
		topLevelAuthn: [{ provider: '@session', store: 'redis://localhost' }],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'session-user');
	assertEquals(calledWith, '@session');
});

Deno.test("OperatorAuthn - setAuthDelegate updates the delegate", async () => {
	let delegateCalled = false;
	const mockDelegate = {
		async runAuthn () {
			delegateCalled = true;
			return { allow: true, identity: { sub: 'session-user' }, provider: '@session' };
		},
	};

	const auth = new OperatorAuthn();
	// Initially no delegate
	assertEquals(auth._authDelegate, null);

	// Set delegate
	auth.setAuthDelegate(mockDelegate);
	assertEquals(auth._authDelegate, mockDelegate);

	// Clear delegate
	auth.setAuthDelegate(null);
	assertEquals(auth._authDelegate, null);
});

Deno.test("OperatorAuthn - caches result from external delegation", async () => {
	let delegateCallCount = 0;
	const mockDelegate = {
		async runAuthn () {
			delegateCallCount++;
			return { allow: true, identity: { sub: 'session-user' }, provider: '@session' };
		},
	};

	const mockLoader = {
		async load (_spec) {
			return {
				async authCheck (_ctx) {
					return null; // JWT did not authenticate
				},
			};
		},
	};

	const auth = new OperatorAuthn({ loader: mockLoader, authDelegate: mockDelegate });
	const opts = {
		method: 'GET',
		url: 'https://example.com/',
		headers: { authorization: 'Bearer some-token' },
		topLevelAuthn: [
			{ provider: '@jwt', secret: 'abc' },
			{ provider: '@session', store: 'redis://localhost' },
		],
	};

	// First call — runs delegate
	const result1 = await auth.runAuthn(opts);
	assertEquals(result1.allow, true);
	assertEquals(delegateCallCount, 1);

	// Second call with same credential — uses cache
	const result2 = await auth.runAuthn(opts);
	assertEquals(result2.allow, true);
	assertEquals(delegateCallCount, 1); // Not called again
});

// ============================================================================
// OperatorAuthDelegate Tests
// ============================================================================

Deno.test("OperatorAuthDelegate - sends auth-req and returns auth-res result", async () => {
	// Mock pool item with a mock reqChannelPool
	const mockChannel = {
		addedTypes: [],
		writtenMessages: [],
		readResult: null,

		async addMessageTypes (types) {
			this.addedTypes.push(...types);
		},
		async write (type, payload) {
			this.writtenMessages.push({ type, payload });
		},
		async read ({ only }) {
			return this.readResult;
		},
	};

	const mockPoolItem = {
		id: 'auth-1',
		usageCount: 0,
		item: {
			reqChannelPool: {
				async acquire () { return mockChannel; },
				async release (_ch) {},
			},
		},
		async decrementUsage () {},
	};

	const mockPoolManager = {
		async getAvailableItem () { return mockPoolItem; },
	};

	// Set up the mock channel to return a valid auth-res
	const authResult = {
		id: 'auth-1',
		allow: true,
		identity: { sub: 'oauth-user', provider: '@oauth-is' },
		provider: '@oauth-is',
		denyStatus: null,
		denyMessage: null,
		ttlSeconds: 300,
	};
	mockChannel.readResult = {
		messageType: 'auth-res',
		text: JSON.stringify(authResult),
		async process (cb) { await cb(); },
	};

	const delegate = new OperatorAuthDelegate(mockPoolManager, null);
	const result = await delegate.runAuthn({
		method: 'GET',
		url: 'https://example.com/api',
		headers: { authorization: 'Bearer oauth-token' },
		authChain: [{ provider: '@oauth-is', introspectUrl: 'https://auth.example.com' }],
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'oauth-user');
	assertEquals(result.provider, '@oauth-is');

	// Verify auth-req was sent
	assertEquals(mockChannel.writtenMessages.length, 1);
	assertEquals(mockChannel.writtenMessages[0].type, 'auth-req');
	const sentPayload = JSON.parse(mockChannel.writtenMessages[0].payload);
	assertEquals(sentPayload.method, 'GET');
	assertEquals(sentPayload.authChain.length, 1);
	assertEquals(sentPayload.authChain[0].provider, '@oauth-is');
});

Deno.test("OperatorAuthDelegate - returns 503 when no auth process available", async () => {
	const mockPoolManager = {
		async getAvailableItem () { return null; },
	};

	const delegate = new OperatorAuthDelegate(mockPoolManager, null);
	const result = await delegate.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: {},
		authChain: [{ provider: '@session' }],
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 503);
});

Deno.test("OperatorAuthDelegate - returns 503 when channel closes before response", async () => {
	const mockChannel = {
		async addMessageTypes () {},
		async write () {},
		async read () { return null; }, // Channel closed
	};

	const mockPoolItem = {
		id: 'auth-1',
		item: {
			reqChannelPool: {
				async acquire () { return mockChannel; },
				async release () {},
			},
		},
		async decrementUsage () {},
	};

	const mockPoolManager = {
		async getAvailableItem () { return mockPoolItem; },
	};

	const delegate = new OperatorAuthDelegate(mockPoolManager, null);
	const result = await delegate.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: {},
		authChain: [{ provider: '@session' }],
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 503);
});

Deno.test("OperatorAuthDelegate - returns denial result from auth process", async () => {
	const mockChannel = {
		async addMessageTypes () {},
		async write () {},
		async read () {
			return {
				text: JSON.stringify({
					id: 'auth-1',
					allow: false,
					identity: null,
					provider: null,
					denyStatus: 401,
					denyMessage: 'Session expired',
				}),
				async process (cb) { await cb(); },
			};
		},
	};

	const mockPoolItem = {
		id: 'auth-1',
		item: {
			reqChannelPool: {
				async acquire () { return mockChannel; },
				async release () {},
			},
		},
		async decrementUsage () {},
	};

	const mockPoolManager = {
		async getAvailableItem () { return mockPoolItem; },
	};

	const delegate = new OperatorAuthDelegate(mockPoolManager, null);
	const result = await delegate.runAuthn({
		method: 'GET',
		url: 'https://example.com/',
		headers: { cookie: 'session=expired' },
		authChain: [{ provider: '@session' }],
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
	assertEquals(result.denyMessage, 'Session expired');
});
