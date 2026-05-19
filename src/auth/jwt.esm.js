/**
 * JSMAWS Built-in Auth Provider: @jwt
 * Verifies JSON Web Tokens (JWT) in the Authorization: Bearer header or a named cookie.
 *
 * Supported algorithms: HS256, HS384, HS512, RS256, RS384, RS512
 *
 * Configuration:
 *   provider=@jwt
 *   secret=:env:JWT_SECRET        (for HMAC algorithms)
 *   publicKey=:env:JWT_PUBLIC_KEY  (for RSA algorithms, PEM format)
 *   algorithm=HS256                (default: HS256)
 *   claimsField=roles              (optional: JWT claim field containing roles, default: 'roles')
 *   cookie=cookieName              (optional: read JWT from this cookie instead of Authorization header)
 *
 * Return values (per auth-revisions-20260510.md 2026-05-11-B):
 *   null                          — no Bearer header/cookie, empty token, expired, or not-yet-valid
 *   { allow: true, identity }     — valid JWT; identity includes sub, roles, claims, provider
 *   { allow: false, ... }         — structurally invalid or bad signature (malicious credential)
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Algorithm configuration for Web Crypto API
 */
const ALGORITHM_MAP = {
	HS256: { name: 'HMAC', hash: 'SHA-256' },
	HS384: { name: 'HMAC', hash: 'SHA-384' },
	HS512: { name: 'HMAC', hash: 'SHA-512' },
	RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
	RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
	RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
};

const enc = new TextEncoder();

/**
 * Decode RFC 4648 base-64-encoded URL to string or Uint8Array
 * @param {string} b64Url - The encoded URL
 * @returns {{string: string, bytes: Uint8Array}}
 */
export function decodeBase64Url (b64Url) {
	// Convert to standard base-64-encoded string
	const base64 = (b64Url.replace(/-/g, '+').replace(/_/g, '/') + '==').slice(0, (b64Url.length + 2) & ~3);
	return {
		get string () { return atob(base64); },
		get bytes () { return Uint8Array.fromBase64(base64); },
	};
}

/**
 * Import a symmetric (HMAC) key from a secret string.
 */
async function importHmacKey (secret, algorithm) {
	const keyBytes = enc.encode(secret);
	return await crypto.subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'HMAC', hash: algorithm.hash },
		false,
		['verify']
	);
}

/**
 * Import an RSA public key from PEM string.
 */
async function importRsaPublicKey (pem, algorithm) {
	// Strip PEM headers and decode base64
	const pemBody = pem
		.replace(/-----BEGIN [^-]+-----/, '')
		.replace(/-----END [^-]+-----/, '')
		.replace(/\s+/g, '');
	const derBytes = decodeBase64Url(pemBody).bytes;

	return await crypto.subtle.importKey(
		'spki',
		derBytes,
		{ name: algorithm.name, hash: algorithm.hash },
		false,
		['verify']
	);
}

/**
 * Verify a JWT token and return a status object.
 *
 * Configuration errors (missing secret/key, unsupported algorithm) are thrown as
 * exceptions — they indicate server misconfiguration that should have been caught
 * at config load time, not normal token verification outcomes.
 *
 * @param {string} token - JWT token string
 * @param {Object} config - Provider configuration
 * @returns {Promise<Object>} Status object:
 *   { ok: true, payload }          — valid JWT
 *   { ok: false, reason: 'expired' }  — expired or not-yet-valid (not malicious)
 *   { ok: false, reason: 'invalid' }  — bad format or bad signature (malicious/invalid)
 * @throws {Error} If provider configuration is invalid (missing secret/key, unsupported algorithm)
 */
async function verifyJwt (token, config) {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return { ok: false, reason: 'invalid' };
	}

	const [headerB64, payloadB64, signatureB64] = parts;

	// Decode header
	let header;
	try {
		header = JSON.parse(decodeBase64Url(headerB64).string);
	} catch (_) {
		return { ok: false, reason: 'invalid' };
	}

	// Determine algorithm — unsupported algorithm is a config error
	const algorithmName = config.algorithm ?? header.alg ?? 'HS256';
	const algorithm = ALGORITHM_MAP[algorithmName];
	if (!algorithm) {
		throw new Error(`Unsupported JWT algorithm: ${algorithmName}`);
	}

	// Import key — missing key is a config error
	let cryptoKey;
	if (algorithm.name === 'HMAC') {
		const secret = config.secret;
		if (!secret) throw new Error('JWT secret not configured');
		cryptoKey = await importHmacKey(secret, algorithm);
	} else {
		const publicKey = config.publicKey;
		if (!publicKey) throw new Error('JWT public key not configured');
		cryptoKey = await importRsaPublicKey(publicKey, algorithm);
	}

	// Verify signature — bad signature is a client/credential problem
	let valid;
	try {
		const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
		const signature = decodeBase64Url(signatureB64).bytes;
		valid = await crypto.subtle.verify(algorithm, cryptoKey, signature, signingInput);
	} catch (_) {
		return { ok: false, reason: 'invalid' };
	}

	if (!valid) {
		return { ok: false, reason: 'invalid' };
	}

	// Decode payload
	let payload;
	try {
		payload = JSON.parse(decodeBase64Url(payloadB64).string);
	} catch (_) {
		return { ok: false, reason: 'invalid' };
	}

	// Check expiration — expired/not-yet-valid is not malicious
	const now = Math.floor(Date.now() / 1000);
	if (payload.exp && payload.exp < now) {
		return { ok: false, reason: 'expired' };
	}

	// Check not-before
	if (payload.nbf && payload.nbf > now) {
		return { ok: false, reason: 'expired' };
	}

	return { ok: true, payload };
}

export default {
	/**
	 * Verify JWT in Authorization: Bearer header or a named cookie.
	 *
	 * Per auth-revisions-20260510.md 2026-05-11-B:
	 *   - No Bearer header / no cookie / empty token → null (provider did not recognize this request)
	 *   - Expired/not-yet-valid → null (not malicious; try next provider)
	 *   - Invalid format/bad signature → { allow: false } (structurally invalid/malicious)
	 *   - Config error → propagated as Error (server misconfiguration)
	 *   - Valid JWT → { allow: true, identity, cacheKey }
	 *
	 * Role checks are removed from this provider; role is a routing-layer concern.
	 *
	 * @param {Object} ctx - AuthContext
	 * @param {Object} ctx.headers - Request headers (with lowercase keys)
	 * @param {Object} ctx.cookies - Parsed cookies
	 * @param {Object} ctx.config - Provider configuration
	 * @returns {Promise<Object|null>} AuthResult or null
	 */
	async authCheck (ctx) {
		const { headers, cookies, config } = ctx;

		let token;
		let cacheKey;

		if (config?.cookie) {
			// Extract JWT from named cookie
			token = (cookies?.[config.cookie] ?? '').trim();
			if (!token) {
				// Cookie absent or empty — provider did not recognize this request
				return null;
			}
			cacheKey = `@jwt:${config.cookie}:${token}`;
		} else {
			// Extract Bearer token from Authorization header (headers are lowercase per Fetch API)
			const authHeader = headers?.authorization ?? '';
			if (!authHeader.startsWith('Bearer ')) {
				// No Bearer header — provider did not recognize this request
				return null;
			}

			token = authHeader.slice(7).trim();
			if (!token) {
				// Empty token — provider did not recognize this request
				return null;
			}
			cacheKey = `@jwt::${authHeader}`;
		}

		// verifyJwt() throws on config errors; returns status object for token outcomes
		const result = await verifyJwt(token, config);

		if (!result.ok) {
			if (result.reason === 'expired') {
				// Expired or not-yet-valid — not malicious; try next provider
				return null;
			}
			// Structural error or bad signature — malicious/invalid credential
			return {
				allow: false,
				denyStatus: 401,
				denyMessage: 'Unauthorized',
			};
		}

		const { payload } = result;

		// Extract roles from configured claim field (default: 'roles')
		const claimsField = config?.claimsField ?? 'roles';
		const rawRoles = payload[claimsField];
		const roles = Array.isArray(rawRoles)
			? rawRoles
			: (rawRoles ? [rawRoles] : []);

		// Build identity from JWT claims
		const { sub, iss, aud, exp, nbf, iat, jti, [claimsField]: _roles, ...otherClaims } = payload;

		const identity = {
			sub: sub ?? null,
			roles,
			claims: { iss, aud, exp, nbf, iat, jti, ...otherClaims },
			provider: '@jwt',
		};

		return { allow: true, identity, cacheKey };
	},

	/**
	 * Extract a cache key for this provider from the request context.
	 * Returns an opaque string if a credential is present, or null if not.
	 * Called by the operator before running the auth chain for cache lookup.
	 *
	 * @param {Object} ctx - AuthContext (headers, cookies)
	 * @param {Object} config - Provider configuration
	 * @returns {string|null} Cache key or null
	 */
	extractCacheKey (ctx, config) {
		if (config?.cookie) {
			const token = (ctx.cookies?.[config.cookie] ?? '').trim();
			return token ? `@jwt:${config.cookie}:${token}` : null;
		}
		const authHeader = ctx.headers?.authorization ?? '';
		if (!authHeader.startsWith('Bearer ')) return null;
		const token = authHeader.slice(7).trim();
		return token ? `@jwt::${authHeader}` : null;
	},
};
