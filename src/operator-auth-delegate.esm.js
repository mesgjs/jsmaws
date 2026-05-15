/**
 * JSMAWS Operator Auth Delegate
 * Delegates auth requests to the auth sub-process pool via IPC.
 *
 * When an auth process pool is configured, the operator delegates authn chain
 * execution to the auth sub-process instead of running it inline. This is used
 * for external auth providers (OAuth, LDAP, session stores) that should not
 * block the operator event loop.
 *
 * Protocol (on req-N channels):
 *   auth-req  (operator → auth process): JSON { id, method, url, headers, authChain }
 *   auth-res  (auth process → operator): JSON { id, allow, identity, provider, denyStatus, denyMessage, ttlSeconds }
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Auth channel message types for operator ↔ auth process IPC.
 * These are registered on req-N channels acquired from the auth process's channel pool.
 */
export const AUTH_CHANNEL_MESSAGE_TYPES = [
	'auth-req',   // operator → auth process: auth request (JSON text)
	'auth-res',   // auth process → operator: auth response (JSON text)
];

/**
 * OperatorAuthDelegate
 * Sends auth requests to the auth sub-process pool and returns the result.
 *
 * The delegate acquires an available auth process from the pool, acquires a
 * req-N channel from that process, sends an auth-req, reads the auth-res,
 * and releases the channel and pool item.
 */
export class OperatorAuthDelegate {
	#nextRequestId = 0;

	/**
	 * @param {object} authPoolManager - PoolManager instance for the auth sub-process pool
	 * @param {object} logger - Logger instance
	 */
	constructor (authPoolManager, logger) {
		this._authPoolManager = authPoolManager;
		this._logger = logger;
	}

	/**
	 * Run the authn chain on the auth sub-process.
	 *
	 * @param {Object} opts
	 * @param {string} opts.method - HTTP method
	 * @param {string} opts.url - Full request URL
	 * @param {Object} opts.headers - Request headers (plain object)
	 * @param {Array} opts.authChain - Auth chain config array (external suffix only)
	 * @returns {Promise<Object>} AuthnResult: { allow, identity, provider } or { allow: false, denyStatus, denyMessage }
	 */
	async runAuthn ({ method, url, headers, authChain }) {
		const id = `auth-${++this.#nextRequestId}`;

		// Get an available auth process from the pool
		const poolItem = await this._authPoolManager.getAvailableItem().catch((error) => {
			this._logger?.error(`[auth-delegate] Auth pool error: ${error.message}`);
			return null;
		});

		if (!poolItem) {
			this._logger?.warn('[auth-delegate] No available auth process in pool');
			return { allow: false, denyStatus: 503, denyMessage: 'Auth service unavailable' };
		}

		const authProcess = poolItem.item;
		const reqChannel = await authProcess.reqChannelPool.acquire();

		try {
			// Register auth message types on this channel
			await reqChannel.addMessageTypes(AUTH_CHANNEL_MESSAGE_TYPES);

			// Send auth request
			const requestPayload = JSON.stringify({ id, method, url, headers, authChain });
			await reqChannel.write('auth-req', requestPayload);

			// Read auth response
			const msg = await reqChannel.read({ only: 'auth-res', decode: true });
			if (!msg) {
				this._logger?.warn(`[auth-delegate] Auth channel closed before response for ${id}`);
				return { allow: false, denyStatus: 503, denyMessage: 'Auth service unavailable' };
			}

			let result;
			await msg.process(() => {
				result = JSON.parse(msg.text);
			});

			// Return AuthnResult (strip the id field)
			const { allow, identity, provider, denyStatus, denyMessage } = result;
			if (allow) {
				return { allow: true, identity: identity ?? null, provider: provider ?? null };
			}
			return { allow: false, denyStatus: denyStatus ?? 500, denyMessage: denyMessage ?? 'Auth error' };

		} catch (error) {
			this._logger?.error(`[auth-delegate] Auth IPC error: ${error.message}`);
			return { allow: false, denyStatus: 503, denyMessage: 'Auth service error' };
		} finally {
			// Always release the channel and pool item
			await authProcess.reqChannelPool.release(reqChannel);
			await poolItem.decrementUsage();
		}
	}
}
