/**
 * Slow Response Fixture Mod-App
 * Used by graceful shutdown E2E tests.
 *
 * Query parameters (all in ms, default 0):
 *   resDelay  - wait BEFORE sending the 'res' (response headers) message.
 *               Server state: request received, processing, no response started.
 *   sodDelay  - wait AFTER 'res' but BEFORE the first 'res-frame' body chunk.
 *               Server state: response headers sent, body not yet started.
 *   eodDelay  - wait AFTER the body 'res-frame' but BEFORE the final null 'res-frame'.
 *               Server state: body chunk sent, end-of-stream not yet signaled.
 *   exitDelay - wait AFTER the final null 'res-frame' before the mod-app exits.
 *               Server state: end-of-stream signaled, mod-app still running.
 *
 * Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;

	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	let requestData;
	await reqMsg.process(() => {
		requestData = JSON.parse(reqMsg.text);
	});

	const { url } = requestData;
	const urlObj = new URL(url), params = urlObj.searchParams;
	const resDelay = parseInt(params.get('resDelay') ?? '0', 10);
	const sodDelay = parseInt(params.get('sodDelay') ?? '0', 10);
	const eodDelay = parseInt(params.get('eodDelay') ?? '0', 10);
	const exitDelay = parseInt(params.get('exitDelay') ?? '0', 10);

	// Wait before sending response headers (simulates slow processing)
	if (resDelay > 0) {
		await new Promise((resolve) => setTimeout(resolve, resDelay));
	}

	const body = JSON.stringify({ message: 'slow response complete', resDelay, sodDelay, eodDelay, exitDelay });

	await server.write('res', JSON.stringify({
		status: 200,
		headers: {
			'content-type': 'application/json',
			'content-length': new TextEncoder().encode(body).length.toString(),
		},
	}));

	// Wait after sending response headers but before sending body
	if (sodDelay > 0) {
		await new Promise((resolve) => setTimeout(resolve, sodDelay));
	}

	await server.write('res-frame', body);

	// Wait after body chunk but before end-of-stream signal
	if (eodDelay > 0) {
		await new Promise((resolve) => setTimeout(resolve, eodDelay));
	}

	await server.write('res-frame', null);

	// Wait after end-of-stream signal before mod-app exits
	if (exitDelay > 0) {
		await new Promise((resolve) => setTimeout(resolve, exitDelay));
	}
}
