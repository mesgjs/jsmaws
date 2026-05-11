/**
 * JSMAWS Operator Auth Cache
 * LRU cache with TTL-based eviction for auth results.
 *
 * Used by both Option D (operator-embedded auth) and Option C (auth service process)
 * to cache AuthResult objects keyed by credential string.
 *
 * Cache properties:
 * - LRU eviction when maxSize is reached
 * - TTL-based expiration (from auth result or configurable default)
 * - Invalidated on config reload
 * - Thread-safe: uses a Map with synchronous operations
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * LRU cache entry
 */
class CacheEntry {
	constructor (key, value, expiresAt) {
		this.key = key;
		this.value = value;
		this.expiresAt = expiresAt; // Unix timestamp in ms, or Infinity for no expiry
	}

	isExpired () {
		return this.expiresAt !== Infinity && Date.now() > this.expiresAt;
	}
}

/**
 * OperatorAuthCache
 * LRU cache with TTL-based eviction for AuthResult objects.
 */
export class OperatorAuthCache {
	/**
	 * @param {Object} [opts]
	 * @param {number} [opts.maxSize=1000] - Maximum number of entries
	 * @param {number} [opts.defaultTtlSeconds=300] - Default TTL in seconds (0 = no default TTL)
	 */
	constructor ({ maxSize = 1000, defaultTtlSeconds = 300 } = {}) {
		this.maxSize = maxSize;
		this.defaultTtlSeconds = defaultTtlSeconds;
		// Map preserves insertion order; we use it as an LRU cache by
		// deleting and re-inserting on access (move-to-end pattern).
		this._map = new Map(); // key → CacheEntry
	}

	/**
	 * Clear all entries from the cache.
	 * Called on config reload to invalidate stale auth results.
	 */
	clear () {
		this._map.clear();
	}

	/**
	 * Remove a specific entry from the cache.
	 * @param {string} key - Credential key
	 */
	delete (key) {
		this._map.delete(key);
	}

	/**
	 * Remove all expired entries from the cache.
	 * Can be called periodically to reclaim memory.
	 * @returns {number} Number of entries removed
	 */
	evictExpired () {
		let count = 0;
		for (const [key, entry] of this._map) {
			if (entry.isExpired()) {
				this._map.delete(key);
				count++;
			}
		}
		return count;
	}

	/**
	 * Look up a cached auth result by credential key.
	 * Returns null on cache miss or expired entry.
	 *
	 * @param {string} key - Credential key (full credential string)
	 * @returns {Object|null} Cached AuthResult or null
	 */
	get (key) {
		const entry = this._map.get(key);
		if (!entry) return null;

		if (entry.isExpired()) {
			this._map.delete(key);
			return null;
		}

		// Move to end (LRU: most recently used)
		this._map.delete(key);
		this._map.set(key, entry);

		return entry.value;
	}

	/**
	 * Store an auth result in the cache.
	 *
	 * TTL is determined by (in priority order):
	 * 1. authResult.ttlSeconds (explicit TTL from auth provider)
	 * 2. JWT exp claim: authResult.identity?.claims?.exp (Unix timestamp)
	 * 3. this.defaultTtlSeconds (cache-level default)
	 * 4. No expiry (Infinity) if defaultTtlSeconds is 0
	 *
	 * @param {string} key - Credential key (full credential string)
	 * @param {Object} authResult - AuthResult to cache
	 */
	set (key, authResult) {
		// Determine TTL
		let expiresAt = Infinity;

		if (authResult.ttlSeconds != null && authResult.ttlSeconds > 0) {
			// Explicit TTL from auth provider
			expiresAt = Date.now() + authResult.ttlSeconds * 1000;
		} else if (authResult.identity?.claims?.exp) {
			// JWT exp claim (Unix timestamp in seconds)
			expiresAt = authResult.identity.claims.exp * 1000;
		} else if (this.defaultTtlSeconds > 0) {
			// Cache-level default TTL
			expiresAt = Date.now() + this.defaultTtlSeconds * 1000;
		}

		// Evict LRU entry if at capacity
		if (this._map.size >= this.maxSize && !this._map.has(key)) {
			// Delete the oldest entry (first in Map insertion order)
			const oldestKey = this._map.keys().next().value;
			this._map.delete(oldestKey);
		}

		// Remove existing entry (if any) before re-inserting to update LRU order
		this._map.delete(key);
		this._map.set(key, new CacheEntry(key, authResult, expiresAt));
	}

	/**
	 * Get the number of entries currently in the cache.
	 */
	get size () {
		return this._map.size;
	}
}
