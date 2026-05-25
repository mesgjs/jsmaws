/**
 * Shutdown Deadline Check Fixture Mod-App
 * Used by graceful shutdown E2E test 8.
 *
 * Behavior:
 *   1. Reads the incoming request.
 *   2. Awaits JSMAWS.shutdownDeadline (resolves when shutdown message is received).
 *   3. Responds with a JSON body containing the resolved deadline value.
 *
 * This allows the test to verify that JSMAWS.shutdownDeadline resolves during
 * a graceful shutdown and that the resolved value is a valid future timestamp.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;

	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	await reqMsg.done();

	// Wait for the shutdown deadline to resolve
	const deadline = await globalThis.JSMAWS.shutdownDeadline;

	const body = JSON.stringify({ shutdownDeadline: deadline });

	await server.write('res', JSON.stringify({
		status: 200,
		headers: {
			'content-type': 'application/json',
			'content-length': new TextEncoder().encode(body).length.toString(),
		},
	}));

	await server.write('res-frame', body);
	await server.write('res-frame', null);
}
