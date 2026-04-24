/**
 * Timeout Configuration Tests
 * Tests for the three-tier timeout hierarchy (global → pool → route)
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Configuration } from '../src/configuration.esm.js';
import { NANOS } from '@nanos';

/**
 * Helper to create a test configuration
 */
function createTestConfig(configData) {
	const slid = NANOS.parseSLID(`[( ${configData} )]`);
	return new Configuration(slid);
}

Deno.test('getTimeoutConfig - global defaults only (no matching pool)', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
	`);

	// Use a pool name not present in the default pool config
	const timeouts = config.getTimeoutConfig('nonexistent');

	assertEquals(timeouts.reqTimeout, 30);
	assertEquals(timeouts.idleTimeout, 60);
	assertEquals(timeouts.conTimeout, 300);
});

Deno.test('getTimeoutConfig - pool overrides global', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
				idleTimeout=20
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('standard');

	assertEquals(timeouts.reqTimeout, 10);  // Pool override
	assertEquals(timeouts.idleTimeout, 20); // Pool override
	assertEquals(timeouts.conTimeout, 300); // Global default
});

Deno.test('getTimeoutConfig - route overrides pool and global', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
				idleTimeout=20
			]
		]
		routing=[
			routes=[
				[
					path=/api/slow
					pool=standard
					reqTimeout=120
				]
			]
		]
	`);

	const routeSpec = { reqTimeout: 120 };
	const timeouts = config.getTimeoutConfig('standard', routeSpec);

	assertEquals(timeouts.reqTimeout, 120); // Route override
	assertEquals(timeouts.idleTimeout, 20); // Pool override
	assertEquals(timeouts.conTimeout, 300); // Global default
});

Deno.test('getTimeoutConfig - zero disables timeout', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			stream=[
				reqTimeout=0
				idleTimeout=0
				conTimeout=0
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('stream');

	assertEquals(timeouts.reqTimeout, 0);  // Disabled
	assertEquals(timeouts.idleTimeout, 0); // Disabled
	assertEquals(timeouts.conTimeout, 0);  // Disabled
});

Deno.test('getTimeoutConfig - route zero overrides pool non-zero', () => {
	const config = createTestConfig(`
		reqTimeout=30
		pools=[
			standard=[
				reqTimeout=10
			]
		]
		routing=[
			routes=[
				[
					path=/api/stream
					pool=standard
					reqTimeout=0
				]
			]
		]
	`);

	const routeSpec = { reqTimeout: 0 };
	const timeouts = config.getTimeoutConfig('standard', routeSpec);

	assertEquals(timeouts.reqTimeout, 0); // Route explicitly disables
});

Deno.test('getTimeoutConfig - pool zero overrides global non-zero', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		pools=[
			stream=[
				reqTimeout=0
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('stream');

	assertEquals(timeouts.reqTimeout, 0);  // Pool explicitly disables
	assertEquals(timeouts.idleTimeout, 60); // Global default
});

Deno.test('getTimeoutConfig - missing pool uses global', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
	`);

	const timeouts = config.getTimeoutConfig('nonexistent');

	assertEquals(timeouts.reqTimeout, 30);
	assertEquals(timeouts.idleTimeout, 60);
	assertEquals(timeouts.conTimeout, 300);
});

Deno.test('getTimeoutConfig - partial pool config', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			fast=[
				reqTimeout=5
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('fast');

	assertEquals(timeouts.reqTimeout, 5);   // Pool override
	assertEquals(timeouts.idleTimeout, 60); // Global default
	assertEquals(timeouts.conTimeout, 300); // Global default
});

Deno.test('getTimeoutConfig - partial route config', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
				idleTimeout=20
			]
		]
	`);

	const routeSpec = { conTimeout: 600 };
	const timeouts = config.getTimeoutConfig('standard', routeSpec);

	assertEquals(timeouts.reqTimeout, 10);  // Pool override
	assertEquals(timeouts.idleTimeout, 20); // Pool override
	assertEquals(timeouts.conTimeout, 600); // Route override
});

Deno.test('getTimeoutConfig - all three tiers different', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
				idleTimeout=20
				conTimeout=200
			]
		]
	`);

	const routeSpec = { reqTimeout: 120, idleTimeout: 90, conTimeout: 600 };
	const timeouts = config.getTimeoutConfig('standard', routeSpec);

	assertEquals(timeouts.reqTimeout, 120); // Route wins
	assertEquals(timeouts.idleTimeout, 90); // Route wins
	assertEquals(timeouts.conTimeout, 600); // Route wins
});

Deno.test('getTimeoutConfig - empty route spec', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('standard');

	assertEquals(timeouts.reqTimeout, 10);  // Pool override
	assertEquals(timeouts.idleTimeout, 60); // Global default
	assertEquals(timeouts.conTimeout, 300); // Global default
});

Deno.test('getTimeoutConfig - null route spec', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('standard', null);

	assertEquals(timeouts.reqTimeout, 10);  // Pool override
	assertEquals(timeouts.idleTimeout, 60); // Global default
	assertEquals(timeouts.conTimeout, 300); // Global default
});

Deno.test('getTimeoutConfig - undefined route spec', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('standard', undefined);

	assertEquals(timeouts.reqTimeout, 10);  // Pool override
	assertEquals(timeouts.idleTimeout, 60); // Global default
	assertEquals(timeouts.conTimeout, 300); // Global default
});

Deno.test('getTimeoutConfig - fast pool typical config', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			fast=[
				reqTimeout=5
				idleTimeout=10
				conTimeout=60
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('fast');

	assertEquals(timeouts.reqTimeout, 5);
	assertEquals(timeouts.idleTimeout, 10);
	assertEquals(timeouts.conTimeout, 60);
});

Deno.test('getTimeoutConfig - stream pool typical config', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			stream=[
				reqTimeout=0
				idleTimeout=300
				conTimeout=3600
			]
		]
	`);

	const timeouts = config.getTimeoutConfig('stream');

	assertEquals(timeouts.reqTimeout, 0);     // Disabled for streaming
	assertEquals(timeouts.idleTimeout, 300);  // 5 minutes between frames
	assertEquals(timeouts.conTimeout, 3600);  // 1 hour total connection
});

Deno.test('getTimeoutConfig - route disables all timeouts', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			standard=[
				reqTimeout=10
				idleTimeout=20
				conTimeout=200
			]
		]
	`);

	const routeSpec = { reqTimeout: 0, idleTimeout: 0, conTimeout: 0 };
	const timeouts = config.getTimeoutConfig('standard', routeSpec);

	assertEquals(timeouts.reqTimeout, 0);
	assertEquals(timeouts.idleTimeout, 0);
	assertEquals(timeouts.conTimeout, 0);
});

Deno.test('getTimeoutConfig - mixed zero and non-zero', () => {
	const config = createTestConfig(`
		reqTimeout=30
		idleTimeout=60
		conTimeout=300
		pools=[
			mixed=[
				reqTimeout=0
				idleTimeout=20
			]
		]
	`);

	const routeSpec = { conTimeout: 0 };
	const timeouts = config.getTimeoutConfig('mixed', routeSpec);

	assertEquals(timeouts.reqTimeout, 0);   // Pool disables
	assertEquals(timeouts.idleTimeout, 20); // Pool override
	assertEquals(timeouts.conTimeout, 0);   // Route disables
});
