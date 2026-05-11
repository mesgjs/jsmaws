/**
 * JSMAWS Value Scheme Registration
 * Barrel file that imports all scheme handler classes and registers them
 * with the ValueResolver. Call registerValueSchemes() once during
 * JSMAWS initialization (in src/operator.esm.js).
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { ValueResolver } from '../value-resolver.esm.js';
import { EnvScheme } from './env-scheme.esm.js';
import { FileScheme } from './file-scheme.esm.js';
import { KvScheme } from './kv-scheme.esm.js';

/**
 * Register all supported value scheme handlers with the ValueResolver.
 * A scheme handler may be registered multiple times if scheme aliases are necessary.
 * Must be called once during JSMAWS initialization before any config resolution.
 */
export function registerValueSchemes () {
	const register = ValueResolver.registerScheme.bind(ValueResolver);

	register('env', EnvScheme);
	register('file', FileScheme);
	register('kv', KvScheme);
}
