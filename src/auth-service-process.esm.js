/**
 * JSMAWS Auth Service Process (Option C)
 * Unprivileged external process for network-dependent auth (OAuth, LDAP, session stores).
 *
 * This process:
 * - Runs with dropped privileges (unprivileged uid/gid)
 * - Loads and runs auth provider modules (can make network calls)
 * - Receives auth requests from operator via PipeTransport req-N channels
 * - Sends auth responses back to operator via the same req-N channels
 * - Only spawned when auth routes use network-dependent providers
 *
 * The operator caches auth results (OperatorAuthCache) to minimize IPC round-trips.
 * This process is only called on cache misses.
 *
 * Auth request/response protocol (on req-N channels):
 *   auth-req  (operator → auth service): JSON { id, method, url, headers, routeSpec, poolName }
 *   auth-res (auth service → operator): JSON { id, allow, identity, denyStatus, denyMessage, addHeaders, ttlSeconds }
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { ServiceProcess } from './service-process.esm.js';
import { REQ_CHANNEL_MESSAGE_TYPES } from './request-channel-pool.esm.js';
import { runAuthChain, buildAuthContext } from './auth-middleware.esm.js';
import { AuthProviderLoader } from './auth-provider-loader.esm.js';

/**
 * Auth service req-N channel message types
 */
const AUTH_REQ_MESSAGE_TYPES = [
	...REQ_CHANNEL_MESSAGE_TYPES,
	'auth-req',   // operator → auth service: auth request (JSON text)
	'auth-res',  // auth service → operator: auth response (JSON text)
];

/**
 * Auth service process class
 * Handles auth requests from the operator
 */
class AuthServiceProcess extends ServiceProcess {
	constructor (processId) {
		super('auth', processId);
		this._loader = new AuthProviderLoader();
	}

	/**
	 * Handle an auth request on a req-N channel.
	 * @param {object} reqChannel - The req-N channel to write the response to
	 * @param {string} requestJson - JSON-encoded auth request
	 */
	async #handleAuthRequest (reqChannel, requestJson) {
		let requestData;
		try {
			requestData = JSON.parse(requestJson);
		} catch (err) {
			console.error(`[${this.processId}] Invalid auth request JSON:`, err);
			await reqChannel.write('auth-res', JSON.stringify({
				id: null,
				allow: false,
				identity: null,
				denyStatus: 400,
				denyMessage: 'Bad Request',
			}));
			return;
		}

		const { id, method, url, headers, routeSpec, poolName } = requestData;

		try {
			console.debug(`[${this.processId}] Auth request: ${method?.toUpperCase()} ${url}`);

			const authChain = routeSpec?.auth;
			if (!authChain || !Array.isArray(authChain) || authChain.length === 0) {
				// No auth configured — allow
				await reqChannel.write('auth-res', JSON.stringify({
					id,
					allow: true,
					identity: null,
					addHeaders: {},
				}));
				return;
			}

			const ctx = buildAuthContext({ method, url, headers, routeSpec, poolName });
			const result = await runAuthChain(ctx, authChain, this._loader);

			await reqChannel.write('auth-res', JSON.stringify({
				id,
				allow: result.allow,
				identity: result.identity ?? null,
				denyStatus: result.denyStatus ?? null,
				denyMessage: result.denyMessage ?? null,
				addHeaders: result.addHeaders ?? {},
				ttlSeconds: result.ttlSeconds ?? null,
			}));

		} catch (error) {
			console.error(`[${this.processId}] Auth request error:`, error);
			await reqChannel.write('auth-res', JSON.stringify({
				id,
				allow: false,
				identity: null,
				denyStatus: 500,
				denyMessage: 'Internal Server Error',
			}));
		}
	}

	/**
	 * Handle configuration update from operator.
	 * Called after this.config has been updated by the ServiceProcess base class.
	 */
	async handleConfigUpdate () {
		console.debug(`[${this.processId}] Received configuration update`);

		// Clear provider cache on config reload (providers may have changed)
		this._loader.clearCache();

		console.debug(`[${this.processId}] Configuration updated`);

		// Send capacity update to signal readiness
		await this.sendCapacityUpdate(1, 1);
	}

	/**
	 * Handle health check from operator.
	 * @param {object} msg - PolyTransport message (from control channel)
	 */
	async handleHealthCheck (msg) {
		console.debug(`[${this.processId}] Health check received`);

		await this.controlChannel.write('health-response', JSON.stringify({
			status: 'ok',
			uptime: Math.floor(performance.now() / 1000),
		}));

		await this.sendCapacityUpdate(1, 1);
	}

	/**
	 * Handle an accepted req-N channel.
	 * Sets up message types and starts the auth-req read loop.
	 * @param {object} reqChannel - PolyTransport channel
	 */
	async handleReqChannel (reqChannel) {
		await reqChannel.addMessageTypes(AUTH_REQ_MESSAGE_TYPES);

		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: 'auth-req', decode: true });
				if (!msg) break;
				await msg.process(async () => {
					await this.#handleAuthRequest(reqChannel, msg.text);
				});
			}
		})();
	}

	/**
	 * Handle shutdown request from operator.
	 * @param {object} msg - PolyTransport message (may be null for signal-triggered shutdown)
	 */
	async handleShutdown (msg) {
		const timeout = msg ? (JSON.parse(msg.text ?? '{}').timeout ?? 30) : 30;
		msg?.done();
		console.info(`[${this.processId}] Shutdown requested (timeout: ${timeout}s)`);

		this.isShuttingDown = true;

		console.info(`[${this.processId}] Shutdown complete`);

		if (this.transport) {
			await this.transport.stop();
		}

		console.debug(`[${this.processId}] Exiting`);
		Deno.exit(0);
	}
}

/**
 * Main entry point
 */
async function main () {
	const processId = Deno.env.get('JSMAWS_PID');
	Deno.stderr.writeSync(new TextEncoder().encode(
		`Auth service main pid ${processId}\n`
	));
	await ServiceProcess.run(AuthServiceProcess, processId);
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing
export { AuthServiceProcess };
