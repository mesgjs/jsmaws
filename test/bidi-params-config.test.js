/**
 * Tests for bidirectional flow control parameters configuration
 * Tests the getBidiParams() method with hierarchy: route > pool > global
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Configuration } from '../src/configuration.esm.js';
import { NANOS } from '../src/vendor.esm.js';

Deno.test('getBidiParams - global defaults', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
	)]`);

	const params = config.getBidiParams({});

	assertEquals(params.initialCredits, 655360); // 10 * 65536
	assertEquals(params.maxChunkSize, 65536);
	assertEquals(params.maxBytesPerSecond, 10485760);
	assertEquals(params.idleTimeout, 60);
	assertEquals(params.maxBufferSize, 1048576);
});

Deno.test('getBidiParams - pool overrides global', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
					idleTimeout=300
				]
			]
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'stream' });

	assertEquals(params.initialCredits, 1310720); // 20 * 65536
	assertEquals(params.maxChunkSize, 65536);
	assertEquals(params.maxBytesPerSecond, 10485760); // Inherited from global
	assertEquals(params.idleTimeout, 300); // Overridden
	assertEquals(params.maxBufferSize, 1048576); // Inherited from global
});

Deno.test('getBidiParams - route overrides pool and global', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
					idleTimeout=300
				]
			]
		]
	)]`);

	const routeSpec = NANOS.parseSLID(`[(
		pool=stream
		bidiFlowControl=[
			idleTimeout=600
		]
	)]`);

	const params = config.getBidiParams({ routeSpec });

	assertEquals(params.initialCredits, 1310720); // 20 * 65536 from pool
	assertEquals(params.maxChunkSize, 65536);
	assertEquals(params.maxBytesPerSecond, 10485760); // From global
	assertEquals(params.idleTimeout, 600); // Overridden by route
	assertEquals(params.maxBufferSize, 1048576); // From global
});

Deno.test('getBidiParams - pool maxChunkSize override', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
		]
		pools=[
			fast=[
				maxChunkSize=32768
				bidiFlowControl=[
					initialCredits=5
				]
			]
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'fast' });

	assertEquals(params.initialCredits, 163840); // 5 * 32768
	assertEquals(params.maxChunkSize, 32768); // Overridden
});

Deno.test('getBidiParams - route maxChunkSize override', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
		]
		pools=[
			fast=[
				maxChunkSize=32768
				bidiFlowControl=[
					initialCredits=5
				]
			]
		]
	)]`);

	const routeSpec = NANOS.parseSLID(`[(
		pool=fast
		maxChunkSize=16384
		bidiFlowControl=[
			initialCredits=10
		]
	)]`);

	const params = config.getBidiParams({ routeSpec });

	assertEquals(params.initialCredits, 163840); // 10 * 16384
	assertEquals(params.maxChunkSize, 16384); // Overridden by route
});

Deno.test('getBidiParams - extract poolName from routeSpec', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
				]
			]
		]
	)]`);

	const routeSpec = NANOS.parseSLID(`[(
		pool=stream
	)]`);

	// Don't pass poolName explicitly - should extract from routeSpec
	const params = config.getBidiParams({ routeSpec });

	assertEquals(params.initialCredits, 1310720); // 20 * 65536 from stream pool
});

Deno.test('getBidiParams - defaults to standard pool', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
		]
		pools=[
			standard=[
				bidiFlowControl=[
					initialCredits=15
				]
			]
		]
	)]`);

	// No poolName or routeSpec - should default to 'standard'
	const params = config.getBidiParams({});

	assertEquals(params.initialCredits, 983040); // 15 * 65536 from standard pool
});

Deno.test('getBidiParams - null routeSpec uses pool config', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
				]
			]
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'stream', routeSpec: null });

	assertEquals(params.initialCredits, 1310720); // 20 * 65536 from pool
});

Deno.test('getBidiParams - missing pool uses global defaults', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'nonexistent' });

	// Should fall back to global defaults
	assertEquals(params.initialCredits, 655360); // 10 * 65536
	assertEquals(params.maxChunkSize, 65536);
	assertEquals(params.maxBytesPerSecond, 10485760);
	assertEquals(params.idleTimeout, 60);
	assertEquals(params.maxBufferSize, 1048576);
});

Deno.test('getBidiParams - partial pool config inherits globals', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
				]
			]
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'stream' });

	assertEquals(params.initialCredits, 1310720); // 20 * 65536 overridden
	assertEquals(params.maxChunkSize, 65536); // Inherited
	assertEquals(params.maxBytesPerSecond, 10485760); // Inherited
	assertEquals(params.idleTimeout, 60); // Inherited
	assertEquals(params.maxBufferSize, 1048576); // Inherited
});

Deno.test('getBidiParams - typical stream pool configuration', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
					idleTimeout=300
				]
			]
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'stream' });

	assertEquals(params.initialCredits, 1310720); // 20 * 64KB = 1.28MB
	assertEquals(params.idleTimeout, 300); // 5 minutes
});

Deno.test('getBidiParams - typical fast pool configuration', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			fast=[
				maxChunkSize=32768
				bidiFlowControl=[
					initialCredits=5
					maxBytesPerSecond=5242880
				]
			]
		]
	)]`);

	const params = config.getBidiParams({ poolName: 'fast' });

	assertEquals(params.initialCredits, 163840); // 5 * 32KB = 160KB
	assertEquals(params.maxChunkSize, 32768); // 32KB
	assertEquals(params.maxBytesPerSecond, 5242880); // 5MB/s
});

Deno.test('getBidiParams - route-specific chat configuration', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			stream=[
				bidiFlowControl=[
					initialCredits=20
					idleTimeout=300
				]
			]
		]
	)]`);

	const routeSpec = NANOS.parseSLID(`[(
		pool=stream
		bidiFlowControl=[
			idleTimeout=600
		]
	)]`);

	const params = config.getBidiParams({ routeSpec });

	assertEquals(params.initialCredits, 1310720); // From pool
	assertEquals(params.idleTimeout, 600); // Overridden for chat
});

Deno.test('getBidiParams - all parameters can be overridden at each level', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		bidiFlowControl=[
			initialCredits=10
			maxBytesPerSecond=10485760
			idleTimeout=60
			maxBufferSize=1048576
		]
		pools=[
			custom=[
				maxChunkSize=32768
				bidiFlowControl=[
					initialCredits=15
					maxBytesPerSecond=5242880
					idleTimeout=120
					maxBufferSize=524288
				]
			]
		]
	)]`);

	const routeSpec = NANOS.parseSLID(`[(
		pool=custom
		maxChunkSize=16384
		bidiFlowControl=[
			initialCredits=25
			maxBytesPerSecond=2621440
			idleTimeout=180
			maxBufferSize=262144
		]
	)]`);

	const params = config.getBidiParams({ routeSpec });

	// All values from route level
	assertEquals(params.initialCredits, 409600); // 25 * 16384
	assertEquals(params.maxChunkSize, 16384);
	assertEquals(params.maxBytesPerSecond, 2621440);
	assertEquals(params.idleTimeout, 180);
	assertEquals(params.maxBufferSize, 262144);
});
