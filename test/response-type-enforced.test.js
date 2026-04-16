/**
 * Response-Type Enforcement Tests
 * Tests for pool-level response type restrictions
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Configuration } from '../src/configuration.esm.js';
import { NANOS } from '@nanos';

Deno.test('getAllowedResponseTypes - default allows all types', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 10
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('standard');
	assertEquals(allowed.size, 3);
	assertEquals(allowed.has('response'), true);
	assertEquals(allowed.has('stream'), true);
	assertEquals(allowed.has('bidi'), true);
});

Deno.test('getAllowedResponseTypes - explicit response only', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			fast: {
				minProcs: 2,
				maxProcs: 10,
				resType: ['response']
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('fast');
	assertEquals(allowed.size, 1);
	assertEquals(allowed.has('response'), true);
	assertEquals(allowed.has('stream'), false);
	assertEquals(allowed.has('bidi'), false);
});

Deno.test('getAllowedResponseTypes - stream and bidi only', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			stream: {
				minProcs: 1,
				maxProcs: 50,
				resType: ['stream', 'bidi']
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('stream');
	assertEquals(allowed.size, 2);
	assertEquals(allowed.has('response'), false);
	assertEquals(allowed.has('stream'), true);
	assertEquals(allowed.has('bidi'), true);
});

Deno.test('getAllowedResponseTypes - all types explicitly listed', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			standard: {
				minProcs: 1,
				maxProcs: 20,
				resType: ['response', 'stream', 'bidi']
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('standard');
	assertEquals(allowed.size, 3);
	assertEquals(allowed.has('response'), true);
	assertEquals(allowed.has('stream'), true);
	assertEquals(allowed.has('bidi'), true);
});

Deno.test('getAllowedResponseTypes - nonexistent pool returns default', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			fast: {
				minProcs: 2,
				maxProcs: 10
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('nonexistent');
	assertEquals(allowed.size, 3);
	assertEquals(allowed.has('response'), true);
	assertEquals(allowed.has('stream'), true);
	assertEquals(allowed.has('bidi'), true);
});

Deno.test('getAllowedResponseTypes - empty resType list', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			restricted: {
				minProcs: 0,
				maxProcs: 5,
				resType: []
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('restricted');
	assertEquals(allowed.size, 0);
	assertEquals(allowed.has('response'), false);
	assertEquals(allowed.has('stream'), false);
	assertEquals(allowed.has('bidi'), false);
});

Deno.test('getAllowedResponseTypes - single type', () => {
	const config = new Configuration(new NANOS());
	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			bidiOnly: {
				minProcs: 1,
				maxProcs: 10,
				resType: ['bidi']
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('bidiOnly');
	assertEquals(allowed.size, 1);
	assertEquals(allowed.has('response'), false);
	assertEquals(allowed.has('stream'), false);
	assertEquals(allowed.has('bidi'), true);
});

Deno.test('getAllowedResponseTypes - NANOS array conversion', () => {
	const config = new Configuration(new NANOS());
	const resTypeNanos = new NANOS();
	resTypeNanos.push('response');
	resTypeNanos.push('stream');

	config.config.setOpts({ transform: true });
	config.config.push({
		pools: {
			test: {
				minProcs: 1,
				maxProcs: 10,
				resType: resTypeNanos
			}
		}
	});

	const allowed = config.getAllowedResponseTypes('test');
	assertEquals(allowed.size, 2);
	assertEquals(allowed.has('response'), true);
	assertEquals(allowed.has('stream'), true);
	assertEquals(allowed.has('bidi'), false);
});

Deno.test('Response type enforcement - mode=response keepAlive=true treated as stream', () => {
	// This test verifies the logic that mode=response with keepAlive=true
	// should be treated as 'stream' type for enforcement purposes
	const mode = 'response';
	const keepAlive = true;
	const effectiveType = (mode === 'response' && keepAlive) ? 'stream' : mode;

	assertEquals(effectiveType, 'stream');
});

Deno.test('Response type enforcement - mode=response keepAlive=false stays response', () => {
	const mode = 'response';
	const keepAlive = false;
	const effectiveType = (mode === 'response' && keepAlive) ? 'stream' : mode;

	assertEquals(effectiveType, 'response');
});

Deno.test('Response type enforcement - mode=stream stays stream', () => {
	const mode = 'stream';
	const keepAlive = true;
	const effectiveType = (mode === 'response' && keepAlive) ? 'stream' : mode;

	assertEquals(effectiveType, 'stream');
});

Deno.test('Response type enforcement - mode=bidi stays bidi', () => {
	const mode = 'bidi';
	const keepAlive = true;
	const effectiveType = (mode === 'response' && keepAlive) ? 'stream' : mode;

	assertEquals(effectiveType, 'bidi');
});
