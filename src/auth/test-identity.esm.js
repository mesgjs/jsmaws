/**
 * JSMAWS Built-in Auth Provider: @test-identity
 * Always succeeds, injecting a configurable identity.
 * Intended for development and testing only.
 *
 * This provider replaces the former @allow-all provider. The name change avoids
 * confusion with the routing-layer @allow-all construct (which is a scalar filter
 * in route-group authn, not a provider module).
 *
 * Configuration:
 *   provider=@test-identity
 *   identity=[sub=dev-user  roles=[admin]]
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default {
	/**
	 * Always succeeds, injecting a configurable identity.
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
				sub: identitySpec.sub ?? 'test-identity',
				roles: Array.isArray(roles)
					? roles
					: (roles ? Object.values(roles) : []),
				claims: {},
				provider: '@test-identity',
			};
		}

		return { allow: true, identity };
	},
};
