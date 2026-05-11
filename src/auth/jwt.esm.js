/**
 * JSMAWS Built-in Auth Provider: @jwt
 * Verifies JSON Web Tokens (JWT) in the Authorization: Bearer header.
 *
 * Supported algorithms: HS256, HS384, HS512, RS256, RS384, RS512
 *
 * Configuration:
 *   provider=@jwt
 *   secret=:env:JWT_SECRET        (for HMAC algorithms)
 *   publicKey=:env:JWT_PUBLIC_KEY  (for RSA algorithms, PEM format)
 *   algorithm=HS256                (default: HS256)
 *   roles=[user admin]             (optional: require at least one of these roles)
 *   claimsField=roles              (optional: JWT claim field containing roles, default: 'roles')
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
 * Base64url decode to Uint8Array
 */
function base64urlDecode (str) {
	// Pad to multiple of 4
	const padded = str.replace(/-/g, '+').replace(/_/g, '/');
	const pad = padded.length % 4;
	const padded2 = pad ? padded + '='.repeat(4 - pad) : padded;
	const binary = atob(padded2);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
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
	const derBytes = base64urlDecode(pemBody.replace(/\+/g, '-').replace(/\//g, '_'));

	return await crypto.subtle.importKey(
		'spki',
		derBytes,
		{ name: algorithm.name, hash: algorithm.hash },
		false,
		['verify']
	);
}

/**
 * Verify a JWT token and return its payload.
 * @param {string} token - JWT token string
 * @param {Object} config - Provider configuration
 * @returns {Promise<Object>} Decoded payload
 * @throws {Error} If verification fails
 */
async function verifyJwt (token, config) {
	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid JWT format');
	}

	const [headerB64, payloadB64, signatureB64] = parts;

	// Decode header
	let header;
	try {
		header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
	} catch (_) {
		throw new Error('Invalid JWT header');
	}

	// Determine algorithm
	const algorithmName = config.algorithm ?? header.alg ?? 'HS256';
	const algorithm = ALGORITHM_MAP[algorithmName];
	if (!algorithm) {
		throw new Error(`Unsupported JWT algorithm: ${algorithmName}`);
	}

	// Import key
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

	// Verify signature
	const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
	const signature = base64urlDecode(signatureB64);

	const valid = await crypto.subtle.verify(
		algorithm,
		cryptoKey,
		signature,
		signingInput
	);

	if (!valid) {
		throw new Error('JWT signature verification failed');
	}

	// Decode payload
	let payload;
	try {
		payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
	} catch (_) {
		throw new Error('Invalid JWT payload');
	}

	// Check expiration
	const now = Math.floor(Date.now() / 1000);
	if (payload.exp && payload.exp < now) {
		throw new Error('JWT token expired');
	}

	// Check not-before
	if (payload.nbf && payload.nbf > now) {
		throw new Error('JWT token not yet valid');
	}

	return payload;
}

export default {
	/**
	 * Verify JWT in Authorization: Bearer header.
	 * @param {Object} ctx - AuthContext
	 * @param {Object} ctx.headers - Request headers
	 * @param {Object} ctx.config - Provider configuration
	 * @returns {Promise<Object>} AuthResult
	 */
	async authCheck (ctx) {
		const { headers, config } = ctx;

		// Extract Bearer token from Authorization header
		const authHeader = headers?.authorization ?? headers?.Authorization ?? '';
		if (!authHeader.startsWith('Bearer ')) {
			return {
				allow: false,
				identity: null,
				denyStatus: 401,
				denyMessage: 'Unauthorized',
			};
		}

		const token = authHeader.slice(7).trim();
		if (!token) {
			return {
				allow: false,
				identity: null,
				denyStatus: 401,
				denyMessage: 'Unauthorized',
			};
		}

		let payload;
		try {
			payload = await verifyJwt(token, config);
		} catch (_error) {
			// Do not leak verification error details to client
			return {
				allow: false,
				identity: null,
				denyStatus: 401,
				denyMessage: 'Unauthorized',
			};
		}

		// Extract roles from configured claim field (default: 'roles')
		const claimsField = config?.claimsField ?? 'roles';
		const rawRoles = payload[claimsField];
		const roles = Array.isArray(rawRoles)
			? rawRoles
			: (rawRoles ? [rawRoles] : []);

		// Check required roles (if configured)
		const requiredRoles = config?.roles;
		if (requiredRoles) {
			const required = Array.isArray(requiredRoles)
				? requiredRoles
				: Object.values(requiredRoles);

			const hasRole = required.some(r => roles.includes(r));
			if (!hasRole) {
				return {
					allow: false,
					identity: null,
					denyStatus: 403,
					denyMessage: 'Forbidden',
				};
			}
		}

		// Build identity from JWT claims
		const { sub, iss, aud, exp, nbf, iat, jti, [claimsField]: _roles, ...otherClaims } = payload;

		const identity = {
			sub: sub ?? null,
			roles,
			claims: { iss, aud, exp, nbf, iat, jti, ...otherClaims },
			provider: '@jwt',
		};

		return { allow: true, identity };
	},
};
