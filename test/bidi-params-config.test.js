/**
 * Tests for bidirectional parameters configuration
 * Tests the getBidiParams() method with hierarchy: route > pool > global
 *
 * After the PolyTransport refactoring, getBidiParams() returns only { maxChunkSize }.
 * All credit-based flow control parameters (initialCredits, maxBytesPerSecond,
 * idleTimeout, maxBufferSize) are obsolete and have been removed.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Configuration } from '../src/configuration.esm.js';

// ─── Global defaults ──────────────────────────────────────────────────────────

Deno.test('getBidiParams - returns global chunkSize as maxChunkSize', () => {
	const config = new Configuration({ chunkSize: 65536 });
	const params = config.getBidiParams({});
	assertEquals(params.maxChunkSize, 65536);
});

Deno.test('getBidiParams - defaults to 65536 when chunkSize not set', () => {
	const config = new Configuration({});
	const params = config.getBidiParams({});
	assertEquals(params.maxChunkSize, 65536);
});

Deno.test('getBidiParams - returns only maxChunkSize (no credit-based params)', () => {
	const config = new Configuration({ chunkSize: 65536 });
	const params = config.getBidiParams({});
	// Only maxChunkSize should be present
	assertEquals(Object.keys(params).length, 1);
	assertEquals('maxChunkSize' in params, true);
	assertEquals('initialCredits' in params, false);
	assertEquals('maxBytesPerSecond' in params, false);
	assertEquals('idleTimeout' in params, false);
	assertEquals('maxBufferSize' in params, false);
});

// ─── Pool override ────────────────────────────────────────────────────────────

Deno.test('getBidiParams - pool maxChunkSize overrides global', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			fast: {
				maxChunkSize: 32768,
			},
		},
	});
	const params = config.getBidiParams({ poolName: 'fast' });
	assertEquals(params.maxChunkSize, 32768);
});

Deno.test('getBidiParams - missing pool falls back to global chunkSize', () => {
	const config = new Configuration({
		chunkSize: 65536,
	});
	const params = config.getBidiParams({ poolName: 'nonexistent' });
	assertEquals(params.maxChunkSize, 65536);
});

Deno.test('getBidiParams - pool without maxChunkSize uses global chunkSize', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 4,
				// No maxChunkSize
			},
		},
	});
	const params = config.getBidiParams({ poolName: 'standard' });
	assertEquals(params.maxChunkSize, 65536);
});

// ─── Route override ───────────────────────────────────────────────────────────

Deno.test('getBidiParams - route maxChunkSize overrides pool and global', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			fast: {
				maxChunkSize: 32768,
			},
		},
	});
	const routeSpec = { pool: 'fast', maxChunkSize: 16384 };
	const params = config.getBidiParams({ routeSpec });
	assertEquals(params.maxChunkSize, 16384);
});

Deno.test('getBidiParams - route without maxChunkSize uses pool maxChunkSize', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			fast: {
				maxChunkSize: 32768,
			},
		},
	});
	const routeSpec = { pool: 'fast' };
	const params = config.getBidiParams({ routeSpec });
	assertEquals(params.maxChunkSize, 32768);
});

Deno.test('getBidiParams - route without maxChunkSize and no pool uses global', () => {
	const config = new Configuration({ chunkSize: 65536 });
	const routeSpec = { path: '/api/test' };
	const params = config.getBidiParams({ routeSpec });
	assertEquals(params.maxChunkSize, 65536);
});

// ─── poolName extraction from routeSpec ──────────────────────────────────────

Deno.test('getBidiParams - extracts poolName from routeSpec.pool', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			stream: {
				maxChunkSize: 131072,
			},
		},
	});
	// Don't pass poolName explicitly — should extract from routeSpec
	const routeSpec = { pool: 'stream' };
	const params = config.getBidiParams({ routeSpec });
	assertEquals(params.maxChunkSize, 131072);
});

Deno.test('getBidiParams - explicit poolName takes precedence over routeSpec.pool', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			fast: { maxChunkSize: 32768 },
			stream: { maxChunkSize: 131072 },
		},
	});
	// Explicit poolName should win over routeSpec.pool
	const routeSpec = { pool: 'stream' };
	const params = config.getBidiParams({ poolName: 'fast', routeSpec });
	// poolName is 'fast' (explicit), but routeSpec.maxChunkSize is undefined,
	// so pool maxChunkSize (32768) is used
	assertEquals(params.maxChunkSize, 32768);
});

// ─── Default pool fallback ────────────────────────────────────────────────────

Deno.test('getBidiParams - defaults to standard pool when no poolName or routeSpec', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			standard: {
				maxChunkSize: 32768,
			},
		},
	});
	// No poolName or routeSpec — should default to 'standard'
	const params = config.getBidiParams({});
	assertEquals(params.maxChunkSize, 32768);
});

Deno.test('getBidiParams - null routeSpec uses pool config', () => {
	const config = new Configuration({
		chunkSize: 65536,
		pools: {
			stream: {
				maxChunkSize: 131072,
			},
		},
	});
	const params = config.getBidiParams({ poolName: 'stream', routeSpec: null });
	assertEquals(params.maxChunkSize, 131072);
});

// ─── fromSLID factory ─────────────────────────────────────────────────────────

Deno.test('getBidiParams - works with fromSLID factory', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=65536
		pools=[
			fast=[
				maxChunkSize=32768
			]
		]
	)]`);
	const params = config.getBidiParams({ poolName: 'fast' });
	assertEquals(params.maxChunkSize, 32768);
});

Deno.test('getBidiParams - fromSLID global chunkSize', () => {
	const config = Configuration.fromSLID(`[(
		chunkSize=32768
	)]`);
	const params = config.getBidiParams({});
	assertEquals(params.maxChunkSize, 32768);
});

// ─── Hierarchy summary ────────────────────────────────────────────────────────

Deno.test('getBidiParams - full hierarchy: route > pool > global', () => {
	const config = new Configuration({
		chunkSize: 65536,       // global
		pools: {
			custom: {
				maxChunkSize: 32768,  // pool
			},
		},
	});

	// Global only
	assertEquals(config.getBidiParams({}).maxChunkSize, 65536);

	// Pool overrides global
	assertEquals(config.getBidiParams({ poolName: 'custom' }).maxChunkSize, 32768);

	// Route overrides pool
	const routeSpec = { pool: 'custom', maxChunkSize: 16384 };
	assertEquals(config.getBidiParams({ routeSpec }).maxChunkSize, 16384);
});
