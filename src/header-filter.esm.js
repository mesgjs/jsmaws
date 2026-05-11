/**
 * JSMAWS Header/Cookie Filter
 * Applies requestFilter and responseFilter rules to headers and cookies.
 *
 * Filter modes:
 *   allowHeaders=[...]  - Allowlist: only listed headers pass through (case-insensitive)
 *   denyHeaders=[...]   - Denylist: all headers except listed ones pass through (case-insensitive)
 *   allowCookies=[...]  - Allowlist: only listed cookies pass through (case-sensitive)
 *   denyCookies=[...]   - Denylist: all cookies except listed ones pass through (case-sensitive)
 *
 * When both allow* and deny* are specified, allowlist takes precedence; deny further restricts.
 * Patterns support simple wildcards: 'x-internal-*' matches 'x-internal-foo', etc.
 *
 * Security note: All keys matching a header name (case-insensitively) are processed to
 * prevent header injection via duplicate headers with different casing.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Test whether a name matches a pattern.
 * Supports simple '*' suffix wildcards (e.g. 'x-internal-*').
 * @param {string} name - Name to test
 * @param {string} pattern - Pattern (may end with '*')
 * @returns {boolean}
 */
function matchesPattern (name, pattern) {
	if (pattern.endsWith('*')) {
		return name.startsWith(pattern.slice(0, -1));
	}
	return name === pattern;
}

/**
 * Test whether a name matches any pattern in a list.
 * @param {string} name - Name to test
 * @param {string[]} patterns - List of patterns
 * @returns {boolean}
 */
function matchesAny (name, patterns) {
	for (const pattern of patterns) {
		if (matchesPattern(name, pattern)) return true;
	}
	return false;
}

/**
 * Normalize a filter spec field to an array of strings.
 * Accepts arrays (from SLID toObject) or plain objects (from SLID).
 * @param {Array|Object|undefined} spec
 * @returns {string[]}
 */
function toStringArray (spec) {
	if (!spec) return [];
	if (Array.isArray(spec)) return spec.map(String);
	if (typeof spec === 'object') return Object.values(spec).map(String);
	return [String(spec)];
}

/**
 * Filter a headers plain object according to filter rules.
 * Header names are compared case-insensitively.
 *
 * @param {Object} headers - Input headers (plain object, header names as keys)
 * @param {Object} filterSpec - Filter specification object with optional fields:
 *   allowHeaders, denyHeaders (arrays of patterns, case-insensitive)
 * @returns {Object} Filtered headers (plain object)
 */
export function filterHeaders (headers, filterSpec) {
	if (!headers || !filterSpec) return headers ?? {};

	const allowHeaders = toStringArray(filterSpec.allowHeaders).map(s => s.toLowerCase());
	const denyHeaders = toStringArray(filterSpec.denyHeaders).map(s => s.toLowerCase());

	const hasAllow = allowHeaders.length > 0;
	const hasDeny = denyHeaders.length > 0;

	if (!hasAllow && !hasDeny) return { ...headers };

	const result = {};
	for (const [name, value] of Object.entries(headers)) {
		const lname = name.toLowerCase();

		if (hasAllow) {
			// Allowlist mode: only pass if in allowlist
			if (!matchesAny(lname, allowHeaders)) continue;
		}

		if (hasDeny) {
			// Denylist mode: skip if in denylist
			if (matchesAny(lname, denyHeaders)) continue;
		}

		result[name] = value;
	}

	return result;
}

/**
 * Filter cookies from a Cookie header string according to filter rules.
 * Cookie names are compared case-sensitively.
 *
 * @param {string} cookieHeader - Value of the Cookie header (may be empty/undefined)
 * @param {Object} filterSpec - Filter specification object with optional fields:
 *   allowCookies, denyCookies (arrays of patterns, case-sensitive)
 * @returns {string} Filtered Cookie header value
 */
export function filterCookieHeader (cookieHeader, filterSpec) {
	if (!cookieHeader || !filterSpec) return cookieHeader ?? '';

	const allowCookies = toStringArray(filterSpec.allowCookies);
	const denyCookies = toStringArray(filterSpec.denyCookies);

	const hasAllow = allowCookies.length > 0;
	const hasDeny = denyCookies.length > 0;

	if (!hasAllow && !hasDeny) return cookieHeader;

	const parts = cookieHeader.split(';');
	const kept = [];

	for (const part of parts) {
		const eqIdx = part.indexOf('=');
		const name = (eqIdx >= 0 ? part.slice(0, eqIdx) : part).trim();
		if (!name) continue;

		if (hasAllow && !matchesAny(name, allowCookies)) continue;
		if (hasDeny && matchesAny(name, denyCookies)) continue;

		kept.push(part.trim());
	}

	return kept.join('; ');
}

/**
 * Apply a requestFilter spec to a headers object.
 * Filters both regular headers and ALL Cookie headers (case-insensitive key matching).
 *
 * Security: All keys matching 'cookie' (case-insensitively) are processed to prevent
 * header injection via duplicate headers with different casing.
 *
 * @param {Object} headers - Input headers (plain object)
 * @param {Object|null} requestFilter - requestFilter spec from route config
 * @returns {Object} Filtered headers (plain object)
 */
export function applyRequestFilter (headers, requestFilter) {
	if (!requestFilter) return { ...headers };

	// Filter regular headers (all Cookie variants handled below)
	const filtered = filterHeaders(headers, requestFilter);

	// Filter cookies within ALL Cookie headers (case-insensitive key matching).
	// Process every key that matches 'cookie' to prevent injection via duplicate
	// headers with different casing (e.g. 'Cookie', 'COOKIE', 'cookie').
	if (requestFilter.allowCookies || requestFilter.denyCookies) {
		for (const key of Object.keys(filtered)) {
			if (key.toLowerCase() === 'cookie') {
				const filteredCookie = filterCookieHeader(filtered[key], requestFilter);
				if (filteredCookie) {
					filtered[key] = filteredCookie;
				} else {
					delete filtered[key];
				}
			}
		}
	}

	return filtered;
}

/**
 * Apply a responseFilter spec to a response headers object.
 * Filters both regular headers and ALL Set-Cookie headers (case-insensitive key matching).
 *
 * Security: All keys matching 'set-cookie' (case-insensitively) are processed to prevent
 * injection via duplicate headers with different casing.
 *
 * @param {Object} headers - Response headers (plain object, may have Set-Cookie as array)
 * @param {Object|null} responseFilter - responseFilter spec from route config
 * @returns {Object} Filtered response headers (plain object)
 */
export function applyResponseFilter (headers, responseFilter) {
	if (!responseFilter) return { ...headers };

	// Filter regular headers
	const filtered = filterHeaders(headers, responseFilter);

	// Filter Set-Cookie headers by cookie name.
	// Process every key that matches 'set-cookie' (case-insensitively) to prevent
	// injection via duplicate headers with different casing.
	if (responseFilter.allowCookies || responseFilter.denyCookies) {
		const allowCookies = toStringArray(responseFilter.allowCookies);
		const denyCookies = toStringArray(responseFilter.denyCookies);
		const hasAllow = allowCookies.length > 0;
		const hasDeny = denyCookies.length > 0;

		for (const key of Object.keys(filtered)) {
			if (key.toLowerCase() !== 'set-cookie') continue;

			const setCookieValues = Array.isArray(filtered[key])
				? filtered[key]
				: [filtered[key]];

			const keptCookies = setCookieValues.filter(cookieStr => {
				// Extract cookie name from "name=value; ..." format
				const eqIdx = cookieStr.indexOf('=');
				const name = (eqIdx >= 0 ? cookieStr.slice(0, eqIdx) : cookieStr).trim();
				if (!name) return false;

				if (hasAllow && !matchesAny(name, allowCookies)) return false;
				if (hasDeny && matchesAny(name, denyCookies)) return false;
				return true;
			});

			if (keptCookies.length === 0) {
				delete filtered[key];
			} else if (keptCookies.length === 1) {
				filtered[key] = keptCookies[0];
			} else {
				filtered[key] = keptCookies;
			}
		}
	}

	return filtered;
}
