/**
 * Tests for JSMAWS Built-in Auth Providers
 * Tests @jwt, @api-key, and @basic providers
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ============================================================================
// JWT Test Helpers
// ============================================================================

/**
 * Base64url encode a Uint8Array or string
 */
function encodeBase64Url (data) {
	if (data instanceof Uint8Array) return data.toBase64({ alphabet: 'base64url', omitPadding: true });
	return btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Create a signed HS256 JWT for testing.
 * @param {Object} payload - JWT payload claims
 * @param {string} secret - HMAC secret
 * @param {Object} [headerOverrides] - Optional header field overrides
 * @returns {Promise<string>} Signed JWT string
 */
async function createTestJwt (payload, secret, headerOverrides = {}) {
	const header = { alg: 'HS256', typ: 'JWT', ...headerOverrides };
	const headerB64 = encodeBase64Url(JSON.stringify(header));
	const payloadB64 = encodeBase64Url(JSON.stringify(payload));
	const signingInput = `${headerB64}.${payloadB64}`;

	const keyBytes = new TextEncoder().encode(secret);
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signatureBytes = await crypto.subtle.sign(
		'HMAC',
		cryptoKey,
		new TextEncoder().encode(signingInput)
	);

	const signatureB64 = encodeBase64Url(new Uint8Array(signatureBytes));
	return `${signingInput}.${signatureB64}`;
}

// ============================================================================
// @jwt Provider Tests
// ============================================================================

import jwtProvider from "../src/auth/jwt.esm.js";

const JWT_SECRET = 'test-secret-key-for-unit-tests';
const NOW = Math.floor(Date.now() / 1000);

Deno.test("@jwt - allows valid HS256 JWT", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET, algorithm: 'HS256' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-123');
	assertEquals(result.identity.provider, '@jwt');
	assertEquals(result.identity.roles, []);
});

Deno.test("@jwt - returns null when no Authorization header", async () => {
	const result = await jwtProvider.authCheck({
		headers: {},
		config: { secret: JWT_SECRET },
	});

	assertEquals(result, null);
});

Deno.test("@jwt - returns null when Authorization is not Bearer", async () => {
	const result = await jwtProvider.authCheck({
		headers: { authorization: 'Basic dXNlcjpwYXNz' },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result, null);
});

Deno.test("@jwt - returns null when Bearer token is empty", async () => {
	const result = await jwtProvider.authCheck({
		headers: { authorization: 'Bearer ' },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result, null);
});

Deno.test("@jwt - returns allow: false when signature is invalid (malicious credential)", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW, exp: NOW + 3600 },
		'wrong-secret'
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
});

Deno.test("@jwt - returns null for expired token (not malicious)", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW - 7200, exp: NOW - 3600 }, // Expired 1 hour ago
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result, null);
});

Deno.test("@jwt - returns null for not-yet-valid token (nbf in future)", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW, nbf: NOW + 3600, exp: NOW + 7200 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result, null);
});

Deno.test("@jwt - allows token without exp (no expiration)", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'user-123');
});

Deno.test("@jwt - extracts roles from default 'roles' claim", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', roles: ['admin', 'user'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.roles, ['admin', 'user']);
});

Deno.test("@jwt - extracts roles from custom claimsField", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', permissions: ['read', 'write'], iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET, claimsField: 'permissions' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.roles, ['read', 'write']);
});

Deno.test("@jwt - includes other claims in identity.claims", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iss: 'test-issuer', custom: 'value', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${token}` },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.claims.iss, 'test-issuer');
	assertEquals(result.identity.claims.custom, 'value');
});

Deno.test("@jwt - returns allow: false for malformed JWT (wrong number of parts)", async () => {
	const result = await jwtProvider.authCheck({
		headers: { authorization: 'Bearer not.a.valid.jwt.token' },
		config: { secret: JWT_SECRET },
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
});

Deno.test("@jwt - reads JWT from named cookie when cookie config is set", async () => {
	const token = await createTestJwt(
		{ sub: 'cookie-user', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: {},
		cookies: { 'auth-token': token },
		config: { secret: JWT_SECRET, cookie: 'auth-token' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'cookie-user');
	assertEquals(result.identity.provider, '@jwt');
});

Deno.test("@jwt - returns null when cookie config is set but cookie is absent", async () => {
	const result = await jwtProvider.authCheck({
		headers: {},
		cookies: {},
		config: { secret: JWT_SECRET, cookie: 'auth-token' },
	});

	assertEquals(result, null);
});

Deno.test("@jwt - cookie takes precedence over Authorization header when cookie config is set", async () => {
	const cookieToken = await createTestJwt(
		{ sub: 'cookie-user', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);
	const headerToken = await createTestJwt(
		{ sub: 'header-user', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const result = await jwtProvider.authCheck({
		headers: { authorization: `Bearer ${headerToken}` },
		cookies: { 'auth-token': cookieToken },
		config: { secret: JWT_SECRET, cookie: 'auth-token' },
	});

	// cookie config is set → reads from cookie, ignores Authorization header
	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'cookie-user');
});

Deno.test("@jwt - extractCacheKey returns key for Bearer token", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const key = jwtProvider.extractCacheKey(
		{ headers: { authorization: `Bearer ${token}` }, cookies: {} },
		{ secret: JWT_SECRET }
	);

	assertEquals(typeof key, 'string');
	assertEquals(key.startsWith('@jwt::Bearer '), true);
});

Deno.test("@jwt - extractCacheKey returns key for cookie JWT", async () => {
	const token = await createTestJwt(
		{ sub: 'user-123', iat: NOW, exp: NOW + 3600 },
		JWT_SECRET
	);

	const key = jwtProvider.extractCacheKey(
		{ headers: {}, cookies: { 'auth-token': token } },
		{ secret: JWT_SECRET, cookie: 'auth-token' }
	);

	assertEquals(typeof key, 'string');
	assertEquals(key.startsWith('@jwt:auth-token:'), true);
});

Deno.test("@jwt - extractCacheKey returns null when no credential present", () => {
	const key = jwtProvider.extractCacheKey(
		{ headers: {}, cookies: {} },
		{ secret: JWT_SECRET }
	);

	assertEquals(key, null);
});

// ============================================================================
// @api-key Provider Tests
// ============================================================================

import apiKeyProvider from "../src/auth/api-key.esm.js";

Deno.test("@api-key - allows valid key from keys list", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'secret-key-1' },
		config: { keys: 'secret-key-1,secret-key-2' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'secret-key-1');
	assertEquals(result.identity.provider, '@api-key');
	assertEquals(result.identity.roles, []);
});

Deno.test("@api-key - returns null for invalid key (try next provider)", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'invalid-key' },
		config: { keys: 'secret-key-1,secret-key-2' },
	});

	assertEquals(result, null);
});

Deno.test("@api-key - returns null when header is missing (provider did not recognize request)", () => {
	const result = apiKeyProvider.authCheck({
		headers: {},
		config: { keys: 'secret-key-1' },
	});

	assertEquals(result, null);
});

Deno.test("@api-key - uses custom header name", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-custom-key': 'my-api-key' },
		config: { header: 'x-custom-key', keys: 'my-api-key' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'my-api-key');
});

Deno.test("@api-key - header name is lowercased for lookup", () => {
	// Headers are always lowercase per Fetch API; provider normalizes config header name to lowercase
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'secret-key-1' },
		config: { keys: 'secret-key-1' },
	});

	assertEquals(result.allow, true);
});

Deno.test("@api-key - uses keyMap to resolve subject", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'key-abc' },
		config: { keyMap: { 'key-abc': 'alice', 'key-def': 'bob' } },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'alice');
});

Deno.test("@api-key - returns null for key not in keyMap", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'unknown-key' },
		config: { keyMap: { 'key-abc': 'alice' } },
	});

	assertEquals(result, null);
});

Deno.test("@api-key - accepts keys as array", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'key-two' },
		config: { keys: ['key-one', 'key-two', 'key-three'] },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'key-two');
});

Deno.test("@api-key - accepts keyMap as JSON string", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'key-abc' },
		config: { keyMap: '{"key-abc":"alice","key-def":"bob"}' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'alice');
});

Deno.test("@api-key - returns null when no keys or keyMap configured", () => {
	const result = apiKeyProvider.authCheck({
		headers: { 'x-api-key': 'any-key' },
		config: {},
	});

	assertEquals(result, null);
});

// ============================================================================
// @basic Provider Tests
// ============================================================================

import basicProvider from "../src/auth/basic.esm.js";

/**
 * Create a Basic auth header value for username:password
 */
function makeBasicAuth (username, password) {
	return `Basic ${btoa(`${username}:${password}`)}`;
}

Deno.test("@basic - allows valid credentials", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'secret') },
		config: { users: { alice: 'secret', bob: 'pass' } },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'alice');
	assertEquals(result.identity.provider, '@basic');
	assertEquals(result.identity.roles, []);
});

Deno.test("@basic - returns null for wrong password (try next provider)", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'wrong') },
		config: { users: { alice: 'secret' } },
	});

	assertEquals(result, null);
});

Deno.test("@basic - returns null for unknown username (try next provider)", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('unknown', 'secret') },
		config: { users: { alice: 'secret' } },
	});

	assertEquals(result, null);
});

Deno.test("@basic - returns null when no Authorization header (provider did not recognize request)", () => {
	const result = basicProvider.authCheck({
		headers: {},
		config: { users: { alice: 'secret' }, realm: 'TestApp' },
	});

	assertEquals(result, null);
});

Deno.test("@basic - returns null when Authorization is not Basic (provider did not recognize request)", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: 'Bearer some-token' },
		config: { users: { alice: 'secret' } },
	});

	assertEquals(result, null);
});

Deno.test("@basic - returns allow: false for malformed base64 (structurally invalid credential)", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: 'Basic not-valid-base64!!!' },
		config: { users: { alice: 'secret' } },
	});

	assertEquals(result.allow, false);
	assertEquals(result.denyStatus, 401);
});

Deno.test("@basic - accepts users as comma-separated 'user:pass' string", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('bob', 'pass123') },
		config: { users: 'alice:secret,bob:pass123' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'bob');
});

Deno.test("@basic - accepts users as JSON string", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'secret') },
		config: { users: '{"alice":"secret","bob":"pass"}' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'alice');
});

Deno.test("@basic - supports base64-encoded passwords (base64=@t)", () => {
	// Password 'secret' base64-encoded is 'c2VjcmV0'
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'secret') },
		config: { users: { alice: btoa('secret') }, base64: '@t' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'alice');
});

Deno.test("@basic - supports base64=true (boolean)", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'secret') },
		config: { users: { alice: btoa('secret') }, base64: true },
	});

	assertEquals(result.allow, true);
});

Deno.test("@basic - returns null when base64 password doesn't match (try next provider)", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'wrong') },
		config: { users: { alice: btoa('secret') }, base64: '@t' },
	});

	assertEquals(result, null);
});

Deno.test("@basic - handles password with colon (base64 encoding)", () => {
	// Password 'pass:word' contains a colon — use base64 to avoid parsing issues
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'pass:word') },
		config: { users: { alice: btoa('pass:word') }, base64: '@t' },
	});

	assertEquals(result.allow, true);
	assertEquals(result.identity.sub, 'alice');
});

Deno.test("@basic - returns null when no users configured", () => {
	const result = basicProvider.authCheck({
		headers: { authorization: makeBasicAuth('alice', 'secret') },
		config: {},
	});

	assertEquals(result, null);
});

Deno.test("@basic - extractCacheKey returns key for Basic credential", () => {
	const key = basicProvider.extractCacheKey(
		{ headers: { authorization: makeBasicAuth('alice', 'secret') } },
		{}
	);

	assertEquals(typeof key, 'string');
	assertEquals(key.startsWith('@basic:Basic '), true);
});

Deno.test("@basic - extractCacheKey returns null when no Authorization header", () => {
	const key = basicProvider.extractCacheKey(
		{ headers: {} },
		{}
	);

	assertEquals(key, null);
});

Deno.test("@basic - extractCacheKey returns null when Authorization is not Basic", () => {
	const key = basicProvider.extractCacheKey(
		{ headers: { authorization: 'Bearer some-token' } },
		{}
	);

	assertEquals(key, null);
});

// ============================================================================
// @api-key extractCacheKey Tests
// ============================================================================

Deno.test("@api-key - extractCacheKey returns key for API key header", () => {
	const key = apiKeyProvider.extractCacheKey(
		{ headers: { 'x-api-key': 'my-secret-key' } },
		{}
	);

	assertEquals(key, '@api-key:x-api-key:my-secret-key');
});

Deno.test("@api-key - extractCacheKey uses custom header name", () => {
	const key = apiKeyProvider.extractCacheKey(
		{ headers: { 'x-custom-key': 'my-secret-key' } },
		{ header: 'x-custom-key' }
	);

	assertEquals(key, '@api-key:x-custom-key:my-secret-key');
});

Deno.test("@api-key - extractCacheKey returns null when header is absent", () => {
	const key = apiKeyProvider.extractCacheKey(
		{ headers: {} },
		{}
	);

	assertEquals(key, null);
});
