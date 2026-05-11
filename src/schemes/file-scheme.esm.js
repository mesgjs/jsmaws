/**
 * JSMAWS :file: Value Scheme Handler
 * Resolves ':file:/path' value references from file contents.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { parseValueRef } from '../value-resolver.esm.js';

/**
 * Scheme handler for ':file:' value references.
 * Reads the entire contents of the specified file.
 *
 * - Absolute paths are used as-is.
 * - Relative paths are resolved relative to the config file's directory
 *   (configDir, injected into rawConfig by the operator before resolution).
 * - Deno.realPath() is used to resolve symlinks and canonicalize the path.
 * - Any additional processing is up to the user.
 */
export class FileScheme {
	#configDir;

	/**
	 * @param {Object} rawConfig - Raw configuration; reads configDir for relative path resolution
	 */
	constructor (rawConfig) {
		// configDir is set by the operator when it prepares the config for resolution
		this.#configDir = rawConfig?.configDir ?? Deno.cwd();
	}

	/**
	 * Resolve a ':file:/path' value reference.
	 * @param {string} ref - Full value reference string (e.g., ':file:/run/secrets/jwt-key')
	 * @returns {Promise<string|undefined>} File contents, or undefined on error
	 */
	async resolve (ref) {
		const parsed = parseValueRef(ref);
		const filePath = parsed?.ref;

		if (!filePath) {
			console.warn(`[FileScheme] Missing file path in value reference '${ref}'`);
			return undefined;
		}

		// Resolve to absolute path (relative paths are relative to configDir)
		const basePath = filePath.startsWith('/')
			? filePath
			: `${this.#configDir}/${filePath}`;

		// Use Deno.realPath() to resolve symlinks and canonicalize
		// (consistent with static-content path traversal prevention)
		let resolvedPath;
		try {
			resolvedPath = await Deno.realPath(basePath);
		} catch (err) {
			console.error(`[FileScheme] Cannot resolve path '${basePath}': ${err.message}`);
			return undefined;
		}

		try {
			return await Deno.readTextFile(resolvedPath);
		} catch (err) {
			console.error(`[FileScheme] Failed to read file '${resolvedPath}': ${err.message}`);
			return undefined;
		}
	}

	/**
	 * No-op cleanup (files are read on demand, no handles to close).
	 */
	// deno-lint-ignore require-await
	async done () {
		// No-op
	}
}
