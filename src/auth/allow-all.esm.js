/**
 * JSMAWS Built-in Auth Provider: @allow-all
 * Always allows the request, injecting a configurable identity.
 * Useful for development and testing.
 *
 * Configuration:
 *   provider=@allow-all
 *   identity=[sub=dev-user  roles=[admin]]
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default {
	/**
	 * Always allows the request.
	 * @param {Object} ctx - AuthContext
	 * @param {Object} ctx.config - Provider configuration
	 * @param {Object} [ctx.config.identity] - Identity to inject (optional)
	 * @returns {Object} AuthResult with allow=true
	 */
	authCheck (ctx) {
		const identitySpec = ctx.config?.identity;
		let identity = null;

		if (identitySpec && typeof identitySpec === 'object') {
			// Build identity from config spec
			const roles = identitySpec.roles;
			identity = {
				sub: identitySpec.sub ?? 'allow-all',
				roles: Array.isArray(roles)
					? roles
					: (roles ? Object.values(roles) : []),
				claims: {},
				provider: '@allow-all',
			};
		}

		return { allow: true, identity };
	},
};
