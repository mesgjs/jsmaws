/**
 * Value Resolver Tests
 * Tests for ValueResolver, parseValueRef, and all scheme handlers
 * (EnvScheme, FileScheme, KvScheme)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import {
	assertEquals,
	assertExists,
	assertStrictEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
	ValueResolver,
	parseValueRef,
	DELETE_SENTINEL,
} from '../src/value-resolver.esm.js';
import { EnvScheme } from '../src/schemes/env-scheme.esm.js';
import { FileScheme } from '../src/schemes/file-scheme.esm.js';
import { KvScheme } from '../src/schemes/kv-scheme.esm.js';
import { registerValueSchemes } from '../src/schemes/index.esm.js';

// Register all schemes once for the test suite
registerValueSchemes();

// --- parseValueRef ------------------------------------------------------------

Deno.test('parseValueRef - returns null for non-string', () => {
	assertEquals(parseValueRef(42), null);
	assertEquals(parseValueRef(null), null);
	assertEquals(parseValueRef(undefined), null);
	assertEquals(parseValueRef({}), null);
});

Deno.test('parseValueRef - returns null for string not starting with colon', () => {
	assertEquals(parseValueRef('hello'), null);
	assertEquals(parseValueRef('env:VAR'), null);
	assertEquals(parseValueRef(''), null);
});

Deno.test('parseValueRef - returns null for malformed (no closing colon)', () => {
	assertEquals(parseValueRef(':env'), null);
	assertEquals(parseValueRef(':'), null);
});

Deno.test('parseValueRef - parses :env:VAR_NAME', () => {
	const result = parseValueRef(':env:JWT_SECRET');
	assertEquals(result, { scheme: 'env', selector: 'default', ref: 'JWT_SECRET' });
});

Deno.test('parseValueRef - parses :file:/path/to/file', () => {
	const result = parseValueRef(':file:/run/secrets/key');
	assertEquals(result, { scheme: 'file', selector: 'default', ref: '/run/secrets/key' });
});

Deno.test('parseValueRef - parses :: (literal empty)', () => {
	const result = parseValueRef('::');
	assertEquals(result, { scheme: '', selector: 'default', ref: '' });
});

Deno.test('parseValueRef - parses :::value (literal colon-prefixed)', () => {
	const result = parseValueRef(':::value');
	assertEquals(result, { scheme: '', selector: 'default', ref: ':value' });
});

Deno.test('parseValueRef - parses :delete:', () => {
	const result = parseValueRef(':delete:');
	assertEquals(result, { scheme: 'delete', selector: 'default', ref: '' });
});

Deno.test('parseValueRef - parses :kv:key/path', () => {
	const result = parseValueRef(':kv:secrets/jwt-signing-key');
	assertEquals(result, { scheme: 'kv', selector: 'default', ref: 'secrets/jwt-signing-key' });
});

Deno.test('parseValueRef - parses :kv.production:key/path (with selector)', () => {
	const result = parseValueRef(':kv.production:secrets/key');
	assertEquals(result, { scheme: 'kv', selector: 'production', ref: 'secrets/key' });
});

Deno.test('parseValueRef - empty selector defaults to "default"', () => {
	// :kv.:key is malformed selector but should still parse
	const result = parseValueRef(':kv.:key');
	assertEquals(result, { scheme: 'kv', selector: 'default', ref: 'key' });
});

// --- ValueResolver - built-in schemes ----------------------------------------

Deno.test('ValueResolver - plain string (no colon prefix) passes through unchanged', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: 'plain value' });
	assertEquals(result.key, 'plain value');
});

Deno.test('ValueResolver - :: (literal) resolves to empty string', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: '::' });
	assertEquals(result.key, '');
});

Deno.test('ValueResolver - :::value resolves to :value', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: ':::value' });
	assertEquals(result.key, ':value');
});

Deno.test('ValueResolver - ::hello resolves to hello', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: '::hello' });
	assertEquals(result.key, 'hello');
});

Deno.test('ValueResolver - :delete: resolves to DELETE_SENTINEL', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: ':delete:' });
	assertStrictEquals(result.key, DELETE_SENTINEL);
});

Deno.test('ValueResolver - non-string values pass through unchanged', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, {
		num: 42,
		bool: true,
		nil: null,
	});
	assertEquals(result.num, 42);
	assertEquals(result.bool, true);
	assertEquals(result.nil, null);
});

Deno.test('ValueResolver - recursively resolves nested objects', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, {
		outer: {
			inner: '::literal-value',
		},
	});
	assertEquals(result.outer.inner, 'literal-value');
});

Deno.test('ValueResolver - recursively resolves arrays', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, {
		items: ['::first', '::second', 'plain'],
	});
	assertEquals(result.items, ['first', 'second', 'plain']);
});

Deno.test('ValueResolver - throws on unknown scheme', async () => {
	const resolver = new ValueResolver();
	let threw = false;
	try {
		await resolver.resolveObject({}, { key: ':unknown:ref' });
	} catch (err) {
		threw = true;
		assertEquals(err instanceof Error, true);
		assertEquals(err.message.includes('unknown'), true);
	}
	assertEquals(threw, true, 'Should throw for unknown scheme');
});

// --- ValueResolver - :env: scheme --------------------------------------------

Deno.test('ValueResolver - :env: resolves set environment variable', async () => {
	Deno.env.set('JSMAWS_TEST_VAR', 'test-value-123');
	try {
		const resolver = new ValueResolver();
		const result = await resolver.resolveObject({}, { key: ':env:JSMAWS_TEST_VAR' });
		assertEquals(result.key, 'test-value-123');
	} finally {
		Deno.env.delete('JSMAWS_TEST_VAR');
	}
});

Deno.test('ValueResolver - :env: returns undefined for unset variable', async () => {
	// Ensure the variable is not set
	Deno.env.delete('JSMAWS_TEST_UNSET_VAR');
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: ':env:JSMAWS_TEST_UNSET_VAR' });
	assertEquals(result.key, undefined);
});

Deno.test('ValueResolver - :env: returns empty string for empty variable', async () => {
	Deno.env.set('JSMAWS_TEST_EMPTY_VAR', '');
	try {
		const resolver = new ValueResolver();
		const result = await resolver.resolveObject({}, { key: ':env:JSMAWS_TEST_EMPTY_VAR' });
		assertEquals(result.key, '');
	} finally {
		Deno.env.delete('JSMAWS_TEST_EMPTY_VAR');
	}
});

// --- EnvScheme - direct tests -------------------------------------------------

Deno.test('EnvScheme - resolve returns env var value', async () => {
	Deno.env.set('JSMAWS_TEST_DIRECT', 'direct-value');
	try {
		const scheme = new EnvScheme({});
		const result = await scheme.resolve(':env:JSMAWS_TEST_DIRECT');
		assertEquals(result, 'direct-value');
	} finally {
		Deno.env.delete('JSMAWS_TEST_DIRECT');
	}
});

Deno.test('EnvScheme - resolve returns undefined for missing var', async () => {
	Deno.env.delete('JSMAWS_TEST_MISSING');
	const scheme = new EnvScheme({});
	const result = await scheme.resolve(':env:JSMAWS_TEST_MISSING');
	assertEquals(result, undefined);
});

Deno.test('EnvScheme - done() is a no-op', async () => {
	const scheme = new EnvScheme({});
	// Should not throw
	await scheme.done();
});

// --- FileScheme - direct tests ------------------------------------------------

Deno.test('FileScheme - resolve reads file contents', async () => {
	// Create a temp file
	const tmpFile = await Deno.makeTempFile({ suffix: '.txt' });
	try {
		await Deno.writeTextFile(tmpFile, 'secret-content\n');
		const scheme = new FileScheme({});
		const result = await scheme.resolve(`:file:${tmpFile}`);
		assertEquals(result, 'secret-content\n');
	} finally {
		await Deno.remove(tmpFile);
	}
});

Deno.test('FileScheme - resolve returns undefined for missing file', async () => {
	const scheme = new FileScheme({});
	const result = await scheme.resolve(':file:/nonexistent/path/to/file.txt');
	assertEquals(result, undefined);
});

Deno.test('FileScheme - resolve uses configDir for relative paths', async () => {
	const tmpDir = await Deno.makeTempDir();
	const tmpFile = `${tmpDir}/relative-secret.txt`;
	try {
		await Deno.writeTextFile(tmpFile, 'relative-content');
		const scheme = new FileScheme({ configDir: tmpDir });
		const result = await scheme.resolve(':file:relative-secret.txt');
		assertEquals(result, 'relative-content');
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('FileScheme - done() is a no-op', async () => {
	const scheme = new FileScheme({});
	// Should not throw
	await scheme.done();
});

Deno.test('ValueResolver - :file: resolves absolute path', async () => {
	const tmpFile = await Deno.makeTempFile({ suffix: '.txt' });
	try {
		await Deno.writeTextFile(tmpFile, 'file-scheme-value');
		const resolver = new ValueResolver();
		const result = await resolver.resolveObject({}, { key: `:file:${tmpFile}` });
		assertEquals(result.key, 'file-scheme-value');
	} finally {
		await Deno.remove(tmpFile);
	}
});

Deno.test('ValueResolver - :file: returns undefined for missing file', async () => {
	const resolver = new ValueResolver();
	const result = await resolver.resolveObject({}, { key: ':file:/nonexistent/path.txt' });
	assertEquals(result.key, undefined);
});

// --- KvScheme - direct tests --------------------------------------------------

Deno.test('KvScheme - resolve reads value from default KV store', async () => {
	const tmpDir = await Deno.makeTempDir();
	const kvPath = `${tmpDir}/test.db`;
	try {
		// Pre-populate the KV store
		const kv = await Deno.openKv(kvPath);
		await kv.set(['secrets', 'jwt-key'], 'my-jwt-secret');
		kv.close();

		const scheme = new KvScheme({ kvStore: kvPath });
		const result = await scheme.resolve(':kv:secrets/jwt-key');
		await scheme.done();
		assertEquals(result, 'my-jwt-secret');
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('KvScheme - resolve returns undefined for missing key', async () => {
	const tmpDir = await Deno.makeTempDir();
	const kvPath = `${tmpDir}/test.db`;
	try {
		const kv = await Deno.openKv(kvPath);
		kv.close();

		const scheme = new KvScheme({ kvStore: kvPath });
		const result = await scheme.resolve(':kv:nonexistent/key');
		await scheme.done();
		assertEquals(result, undefined);
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('KvScheme - resolve returns undefined for unconfigured selector', async () => {
	const scheme = new KvScheme({}); // No kvStores configured
	const result = await scheme.resolve(':kv:some/key');
	await scheme.done();
	assertEquals(result, undefined);
});

Deno.test('KvScheme - resolve reads from named selector', async () => {
	const tmpDir = await Deno.makeTempDir();
	const kvPath = `${tmpDir}/named.db`;
	try {
		const kv = await Deno.openKv(kvPath);
		await kv.set(['api', 'key'], 'named-store-value');
		kv.close();

		const scheme = new KvScheme({ kvStores: { production: kvPath } });
		const result = await scheme.resolve(':kv.production:api/key');
		await scheme.done();
		assertEquals(result, 'named-store-value');
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('KvScheme - kvStore alias normalizes to kvStores.default', async () => {
	const tmpDir = await Deno.makeTempDir();
	const kvPath = `${tmpDir}/alias.db`;
	try {
		const kv = await Deno.openKv(kvPath);
		await kv.set(['test', 'value'], 'alias-works');
		kv.close();

		// Use kvStore (singular alias) instead of kvStores
		const scheme = new KvScheme({ kvStore: kvPath });
		const result = await scheme.resolve(':kv:test/value');
		await scheme.done();
		assertEquals(result, 'alias-works');
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('KvScheme - done() closes all open stores', async () => {
	const tmpDir = await Deno.makeTempDir();
	const kvPath = `${tmpDir}/close-test.db`;
	try {
		const kv = await Deno.openKv(kvPath);
		kv.close();

		const scheme = new KvScheme({ kvStore: kvPath });
		// Trigger store open by resolving a key
		await scheme.resolve(':kv:any/key');
		// done() should close without throwing
		await scheme.done();
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

Deno.test('KvScheme - coerces non-string KV values to string', async () => {
	const tmpDir = await Deno.makeTempDir();
	const kvPath = `${tmpDir}/coerce.db`;
	try {
		const kv = await Deno.openKv(kvPath);
		await kv.set(['num'], 42);
		await kv.set(['bool'], true);
		kv.close();

		const scheme = new KvScheme({ kvStore: kvPath });
		const numResult = await scheme.resolve(':kv:num');
		const boolResult = await scheme.resolve(':kv:bool');
		await scheme.done();
		assertEquals(numResult, '42');
		assertEquals(boolResult, 'true');
	} finally {
		await Deno.remove(tmpDir, { recursive: true });
	}
});

// --- ValueResolver - handler lifecycle ---------------------------------------

Deno.test('ValueResolver - done() is called on all instantiated handlers', async () => {
	let doneCalled = false;

	class TrackingScheme {
		constructor (_rawConfig) {}
		// deno-lint-ignore require-await
		async resolve (_ref) { return 'tracked'; }
		async done () { doneCalled = true; }
	}

	// Register a temporary tracking scheme
	ValueResolver.registerScheme('tracking-test', TrackingScheme);

	const resolver = new ValueResolver();
	await resolver.resolveObject({}, { key: ':tracking-test:ref' });

	assertEquals(doneCalled, true, 'done() should be called after resolution pass');
});

Deno.test('ValueResolver - handler instance is reused within a pass', async () => {
	let instanceCount = 0;

	class CountingScheme {
		constructor (_rawConfig) { instanceCount++; }
		// deno-lint-ignore require-await
		async resolve (_ref) { return 'counted'; }
		// deno-lint-ignore require-await
		async done () {}
	}

	ValueResolver.registerScheme('counting-test', CountingScheme);

	instanceCount = 0;
	const resolver = new ValueResolver();
	await resolver.resolveObject({}, {
		a: ':counting-test:ref1',
		b: ':counting-test:ref2',
		c: ':counting-test:ref3',
	});

	assertEquals(instanceCount, 1, 'Only one handler instance should be created per pass');
});

Deno.test('ValueResolver - done() called even if resolution throws', async () => {
	let doneCalled = false;

	class ThrowingScheme {
		constructor (_rawConfig) {}
		async resolve (_ref) { throw new Error('Intentional resolve error'); }
		async done () { doneCalled = true; }
	}

	ValueResolver.registerScheme('throwing-test', ThrowingScheme);

	const resolver = new ValueResolver();
	let threw = false;
	try {
		await resolver.resolveObject({}, { key: ':throwing-test:ref' });
	} catch (_err) {
		threw = true;
	}

	assertEquals(threw, true, 'Should propagate the error');
	assertEquals(doneCalled, true, 'done() should be called even after error');
});

// --- registerValueSchemes -----------------------------------------------------

Deno.test('registerValueSchemes - env scheme is registered', async () => {
	// If env scheme is registered, :env: references should resolve
	Deno.env.set('JSMAWS_SCHEME_REG_TEST', 'registered');
	try {
		const resolver = new ValueResolver();
		const result = await resolver.resolveObject({}, { key: ':env:JSMAWS_SCHEME_REG_TEST' });
		assertEquals(result.key, 'registered');
	} finally {
		Deno.env.delete('JSMAWS_SCHEME_REG_TEST');
	}
});

Deno.test('registerValueSchemes - file scheme is registered', async () => {
	const tmpFile = await Deno.makeTempFile({ suffix: '.txt' });
	try {
		await Deno.writeTextFile(tmpFile, 'file-registered');
		const resolver = new ValueResolver();
		const result = await resolver.resolveObject({}, { key: `:file:${tmpFile}` });
		assertEquals(result.key, 'file-registered');
	} finally {
		await Deno.remove(tmpFile);
	}
});
