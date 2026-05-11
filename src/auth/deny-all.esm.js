/**
 * JSMAWS Built-in Auth Provider: @deny-all
 * Always denies the request with a configurable status and message.
 * Useful for maintenance mode or temporarily blocking routes.
 *
 * Configuration:
 *   provider=@deny-all
 *   status=503
 *   message=Maintenance
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default {
	/**
	 * Always denies the request.
	 * @param {Object} ctx - AuthContext
	 * @param {Object} ctx.config - Provider configuration
	 * @param {number} [ctx.config.status=403] - HTTP status code for denial
	 * @param {string} [ctx.config.message='Forbidden'] - Denial message
	 * @returns {Object} AuthResult with allow=false
	 */
	authCheck (ctx) {
		const status = Number(ctx.config?.status) || 403;
		const message = ctx.config?.message ?? 'Forbidden';

		return {
			allow: false,
			identity: null,
			denyStatus: status,
			denyMessage: String(message),
		};
	},
};
