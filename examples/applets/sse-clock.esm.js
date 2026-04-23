/**
 * SSE Clock Applet
 * Demonstrates Server-Sent Events using the PolyTransport channel API
 * Sends current time every second for 10 seconds
 *
 * Protocol: PolyTransport channel API via globalThis.JSMAWS.server
 * - Reads 'req' message (JSON text) for request metadata
 * - Writes 'res' message (JSON text) for response status + headers (streaming)
 * - Writes 'res-frame' messages for SSE event chunks
 * - Signals end-of-stream with zero-data 'res-frame' (null data)
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;

	// Read the incoming request (all data is JSON text — use decode: true)
	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	let requestData;
	await reqMsg.process(() => {
		requestData = JSON.parse(reqMsg.text);
	});

	const { maxChunkSize } = requestData;

	try {
		// Send response metadata (streaming SSE connection)
		await server.write('res', JSON.stringify({
			status: 200,
			mode: 'stream',
			headers: {
				'content-type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Access-Control-Allow-Origin': '*',
			},
		}));

		// Send time updates every second for 10 seconds
		const maxUpdates = 10;

		for (let count = 1; count <= maxUpdates; count++) {
			// Wait 1 second between events
			await new Promise((resolve) => setTimeout(resolve, 1000));

			const eventData = {
				timestamp: new Date().toISOString(),
				count,
				message: `Update ${count} of ${maxUpdates}`,
			};

			const sseMessage = `data: ${JSON.stringify(eventData)}\n\n`;

			// Check chunk size
			if (new TextEncoder().encode(sseMessage).length > maxChunkSize) {
				console.error('SSE message exceeds maxChunkSize');
				break;
			}

			// Send SSE event chunk
			await server.write('res-frame', sseMessage);
		}

		// Signal end-of-stream
		await server.write('res-frame', null);

	} catch (error) {
		await server.write('res-error', JSON.stringify({
			error: error.message,
			stack: error.stack,
		}));
	}
}
