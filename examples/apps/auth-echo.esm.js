/**
 * Auth Echo Mod-App
 * Returns the authenticated identity from the request payload.
 * Used for E2E testing of authentication integration.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;

	// Read the incoming request
	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	let requestData;
	await reqMsg.process(() => {
		requestData = JSON.parse(reqMsg.text);
	});

	const { method, url, identity } = requestData;

	try {
		const urlObj = new URL(url);

		// Return the identity (or null if unauthenticated)
		const responseBody = JSON.stringify({
			method,
			path: urlObj.pathname,
			authenticated: identity !== null,
			identity: identity ?? null,
		});

		await server.write('res', JSON.stringify({
			status: 200,
			headers: {
				'content-type': 'application/json',
				'content-length': new TextEncoder().encode(responseBody).length.toString(),
			},
		}));

		await server.write('res-frame', responseBody);
		await server.write('res-frame', null);

	} catch (error) {
		await server.write('res-error', JSON.stringify({
			error: error.message,
			stack: error.stack,
		}));
	}
}
