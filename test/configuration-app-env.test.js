/**
 * Configuration.getEffectiveAppEnv() Tests
 * Tests for the appEnv merge hierarchy: global → pool → route
 * and the :delete: / wildcard-delete semantics.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Configuration } from '../src/configuration.esm.js';
import { DELETE_SENTINEL } from '../src/value-resolver.esm.js';

// --- No appEnv configured -----------------------------------------------------

Deno.test('getEffectiveAppEnv - returns empty object when no appEnv at any scope', () => {
	const config = new Configuration({
		pools: { standard: { minProcs: 1 } },
	});
	const result = config.getEffectiveAppEnv(null, 'standard');
	assertEquals(result, {});
});

Deno.test('getEffectiveAppEnv - returns empty object with null routeSpec and no global appEnv', () => {
	const config = new Configuration({});
	const result = config.getEffectiveAppEnv(null);
	assertEquals(result, {});
});

// --- Global appEnv only -------------------------------------------------------

Deno.test('getEffectiveAppEnv - global appEnv is returned when no pool/route override', () => {
	const config = new Configuration({
		appEnv: {
			appVersion: '1.0.0',
			publicApiUrl: 'https://api.example.com/v1',
		},
		pools: { standard: { minProcs: 1 } },
	});
	const result = config.getEffectiveAppEnv(null, 'standard');
	assertEquals(result, {
		appVersion: '1.0.0',
		publicApiUrl: 'https://api.example.com/v1',
	});
});

Deno.test('getEffectiveAppEnv - global appEnv values are coerced to strings', () => {
	const config = new Configuration({
		appEnv: {
			maxRetries: 3,
			featureEnabled: true,
			ratio: 0.5,
		},
	});
	const result = config.getEffectiveAppEnv(null);
	assertEquals(result, {
		maxRetries: '3',
		featureEnabled: 'true',
		ratio: '0.5',
	});
});

// --- Pool appEnv override -----------------------------------------------------

Deno.test('getEffectiveAppEnv - pool appEnv overrides global', () => {
	const config = new Configuration({
		appEnv: {
			publicApiUrl: 'https://api.example.com/v1',
			appVersion: '1.0.0',
		},
		pools: {
			standard: {
				appEnv: {
					publicApiUrl: 'https://api.example.com/v2',
				},
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'standard');
	assertEquals(result, {
		publicApiUrl: 'https://api.example.com/v2',
		appVersion: '1.0.0',
	});
});

Deno.test('getEffectiveAppEnv - pool appEnv adds new keys', () => {
	const config = new Configuration({
		appEnv: { appVersion: '1.0.0' },
		pools: {
			admin: {
				appEnv: { adminMode: 'true' },
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'admin');
	assertEquals(result, {
		appVersion: '1.0.0',
		adminMode: 'true',
	});
});

Deno.test('getEffectiveAppEnv - pool appEnv with :delete: removes global key', () => {
	const config = new Configuration({
		appEnv: {
			appVersion: '1.0.0',
			featureNewUI: 'true',
		},
		pools: {
			standard: {
				appEnv: {
					featureNewUI: DELETE_SENTINEL,
				},
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'standard');
	assertEquals(result, { appVersion: '1.0.0' });
	assertEquals('featureNewUI' in result, false);
});

Deno.test('getEffectiveAppEnv - pool appEnv with wildcard :delete: clears all global keys', () => {
	const config = new Configuration({
		appEnv: {
			appVersion: '1.0.0',
			featureNewUI: 'true',
			publicApiUrl: 'https://api.example.com/v1',
		},
		pools: {
			restricted: {
				appEnv: {
					'*': DELETE_SENTINEL,
					safeMode: 'true',
				},
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'restricted');
	// All global keys cleared; only pool-defined key remains
	assertEquals(result, { safeMode: 'true' });
	assertEquals('appVersion' in result, false);
	assertEquals('featureNewUI' in result, false);
	assertEquals('publicApiUrl' in result, false);
});

Deno.test('getEffectiveAppEnv - wildcard :delete: processed before other entries in same block', () => {
	// Even if * appears after other keys visually, it should be processed first
	const config = new Configuration({
		appEnv: { globalKey: 'global-value' },
		pools: {
			test: {
				appEnv: {
					newKey: 'new-value',
					'*': DELETE_SENTINEL,  // wildcard after newKey — should still clear first
				},
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'test');
	// globalKey cleared by wildcard; newKey added after wildcard
	assertEquals(result, { newKey: 'new-value' });
	assertEquals('globalKey' in result, false);
});

// --- Route appEnv override ----------------------------------------------------

Deno.test('getEffectiveAppEnv - route appEnv overrides pool and global', () => {
	const config = new Configuration({
		appEnv: {
			appVersion: '1.0.0',
			publicApiUrl: 'https://api.example.com/v1',
		},
		pools: {
			standard: {
				appEnv: {
					publicApiUrl: 'https://api.example.com/v2',
				},
			},
		},
	});
	const routeSpec = {
		pool: 'standard',
		appEnv: {
			stripeKey: 'pk_live_123',
			maxRetries: '3',
		},
	};
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, {
		appVersion: '1.0.0',
		publicApiUrl: 'https://api.example.com/v2',
		stripeKey: 'pk_live_123',
		maxRetries: '3',
	});
});

Deno.test('getEffectiveAppEnv - route appEnv with :delete: removes pool key', () => {
	const config = new Configuration({
		appEnv: { appVersion: '1.0.0' },
		pools: {
			standard: {
				appEnv: { adminMode: 'true' },
			},
		},
	});
	const routeSpec = {
		pool: 'standard',
		appEnv: { adminMode: DELETE_SENTINEL },
	};
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, { appVersion: '1.0.0' });
	assertEquals('adminMode' in result, false);
});

Deno.test('getEffectiveAppEnv - route appEnv with wildcard :delete: clears all prior keys', () => {
	const config = new Configuration({
		appEnv: { appVersion: '1.0.0', featureNewUI: 'true' },
		pools: {
			standard: {
				appEnv: { adminMode: 'true' },
			},
		},
	});
	const routeSpec = {
		pool: 'standard',
		appEnv: {
			'*': DELETE_SENTINEL,
			routeSpecific: 'only-this',
		},
	};
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, { routeSpecific: 'only-this' });
	assertEquals('appVersion' in result, false);
	assertEquals('featureNewUI' in result, false);
	assertEquals('adminMode' in result, false);
});

// --- Pool name resolution -----------------------------------------------------

Deno.test('getEffectiveAppEnv - uses routeSpec.pool when poolName not provided', () => {
	const config = new Configuration({
		appEnv: { global: 'yes' },
		pools: {
			fast: {
				appEnv: { poolKey: 'fast-pool' },
			},
		},
	});
	const routeSpec = { pool: 'fast' };
	const result = config.getEffectiveAppEnv(routeSpec);
	assertEquals(result, { global: 'yes', poolKey: 'fast-pool' });
});

Deno.test('getEffectiveAppEnv - explicit poolName takes precedence over routeSpec.pool', () => {
	const config = new Configuration({
		pools: {
			fast: { appEnv: { poolKey: 'fast' } },
			slow: { appEnv: { poolKey: 'slow' } },
		},
	});
	const routeSpec = { pool: 'slow' };
	// Explicit poolName 'fast' should win
	const result = config.getEffectiveAppEnv(routeSpec, 'fast');
	assertEquals(result, { poolKey: 'fast' });
});

Deno.test('getEffectiveAppEnv - defaults to standard pool when no poolName or routeSpec.pool', () => {
	const config = new Configuration({
		pools: {
			standard: { appEnv: { defaultPool: 'yes' } },
		},
	});
	const result = config.getEffectiveAppEnv(null);
	assertEquals(result, { defaultPool: 'yes' });
});

Deno.test('getEffectiveAppEnv - missing pool is treated as no pool appEnv', () => {
	const config = new Configuration({
		appEnv: { globalKey: 'global' },
		pools: {},
	});
	const result = config.getEffectiveAppEnv(null, 'nonexistent');
	assertEquals(result, { globalKey: 'global' });
});

// --- Full three-tier merge ----------------------------------------------------

Deno.test('getEffectiveAppEnv - full three-tier merge example from design doc', () => {
	// Simulates the example from arch/env-secrets-design.md §5.4
	const config = new Configuration({
		appEnv: {
			appVersion: '2.3.1',
			featureNewUI: 'true',
			publicApiUrl: 'https://api.example.com/v1',
		},
		pools: {
			standard: {
				appEnv: {
					publicApiUrl: 'https://api.example.com/v2',
					featureNewUI: DELETE_SENTINEL,
				},
			},
		},
	});
	const routeSpec = {
		pool: 'standard',
		appEnv: {
			stripePublishableKey: 'pk_live_abc',
			maxRetries: '3',
			tenantId: 'acme-corp',
		},
	};
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, {
		appVersion: '2.3.1',
		publicApiUrl: 'https://api.example.com/v2',
		stripePublishableKey: 'pk_live_abc',
		maxRetries: '3',
		tenantId: 'acme-corp',
	});
	assertEquals('featureNewUI' in result, false);
});

// --- Edge cases ---------------------------------------------------------------

Deno.test('getEffectiveAppEnv - null appEnv blocks are skipped', () => {
	const config = new Configuration({
		appEnv: null,
		pools: {
			standard: { appEnv: null },
		},
	});
	const routeSpec = { pool: 'standard', appEnv: null };
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, {});
});

Deno.test('getEffectiveAppEnv - empty appEnv blocks are skipped', () => {
	const config = new Configuration({
		appEnv: {},
		pools: {
			standard: { appEnv: {} },
		},
	});
	const routeSpec = { pool: 'standard', appEnv: {} };
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, {});
});

Deno.test('getEffectiveAppEnv - :delete: on non-existent key is a no-op', () => {
	const config = new Configuration({
		appEnv: { existingKey: 'value' },
		pools: {
			standard: {
				appEnv: {
					nonExistentKey: DELETE_SENTINEL,
				},
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'standard');
	// Deleting a non-existent key should not cause errors
	assertEquals(result, { existingKey: 'value' });
});

Deno.test('getEffectiveAppEnv - wildcard :delete: with no prior keys is a no-op', () => {
	const config = new Configuration({
		pools: {
			standard: {
				appEnv: {
					'*': DELETE_SENTINEL,
					newKey: 'new-value',
				},
			},
		},
	});
	const result = config.getEffectiveAppEnv(null, 'standard');
	assertEquals(result, { newKey: 'new-value' });
});

Deno.test('getEffectiveAppEnv - route appEnv can re-add key deleted at pool level', () => {
	const config = new Configuration({
		appEnv: { key: 'global-value' },
		pools: {
			standard: {
				appEnv: { key: DELETE_SENTINEL },
			},
		},
	});
	const routeSpec = {
		pool: 'standard',
		appEnv: { key: 'route-value' },
	};
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result, { key: 'route-value' });
});

Deno.test('getEffectiveAppEnv - string coercion at each scope level', () => {
	const config = new Configuration({
		appEnv: { numKey: 42 },
		pools: {
			standard: {
				appEnv: { boolKey: false },
			},
		},
	});
	const routeSpec = {
		pool: 'standard',
		appEnv: { floatKey: 3.14 },
	};
	const result = config.getEffectiveAppEnv(routeSpec, 'standard');
	assertEquals(result.numKey, '42');
	assertEquals(result.boolKey, 'false');
	assertEquals(result.floatKey, '3.14');
});
