/**
 * JSMAWS :env: Value Scheme Handler
 * Resolves ':env:VAR_NAME' value references from OS environment variables.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { parseValueRef } from '../value-resolver.esm.js';

/**
 * Scheme handler for ':env:' value references.
 * Reads named OS environment variables from the operator process's environment.
 *
 * If the variable is not set, logs a warning and returns undefined.
 * A present-but-empty variable qualifies as "set" and returns ''.
 */
export class EnvScheme {
	/**
	 * @param {Object} _rawConfig - Raw configuration (unused by this scheme)
	 */
	constructor (_rawConfig) {
		// No config needed — env vars are read directly from Deno.env
	}

	/**
	 * Resolve an ':env:VAR_NAME' value reference.
	 * @param {string} ref - Full value reference string (e.g., ':env:JWT_SECRET')
	 * @returns {Promise<string|undefined>} Resolved value, or undefined if not set
	 */
	// deno-lint-ignore require-await
	async resolve (ref) {
		const parsed = parseValueRef(ref);
		const varName = parsed?.ref;

		if (!varName) {
			console.warn(`[EnvScheme] Missing variable name in value reference '${ref}'`);
			return undefined;
		}

		const value = Deno.env.get(varName);
		if (value === undefined) {
			console.warn(`[EnvScheme] Environment variable '${varName}' is not set`);
		}
		return value;
	}

	/**
	 * No-op cleanup (env vars are read on demand, no handles to close).
	 */
	// deno-lint-ignore require-await
	async done () {
		// No-op
	}
}
