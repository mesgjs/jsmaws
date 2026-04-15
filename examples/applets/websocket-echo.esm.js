/**
 * WebSocket Echo Applet
 * Demonstrates bidirectional communication using the PolyTransport channel API
 * Echoes back any messages received from the client via NestedTransport
 *
 * Protocol: PolyTransport channel API via globalThis.JSMAWS
 * - Reads 'req' message (JSON text) from JSMAWS.server for request metadata
 * - Writes 'res' message (JSON text) to JSMAWS.server for WebSocket upgrade (status 101)
 * - Uses JSMAWS.bidi (NestedTransport relay channel) for bidirectional communication
 * - Instantiates NestedTransport over JSMAWS.bidi to communicate with the client
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NestedTransport } from '@poly-transport/transport/nested.esm.js';

export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;
	const bidiChannel = globalThis.JSMAWS.bidi;

	// Read the incoming request (all data is JSON text — use decode: true)
	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	let requestData;
	await reqMsg.process(() => {
		requestData = JSON.parse(reqMsg.text);
	});

	const { headers } = requestData;

	// Verify this is a WebSocket upgrade request
	if (headers?.upgrade?.toLowerCase() !== 'websocket') {
		await server.write('res-error', JSON.stringify({
			error: 'Expected WebSocket upgrade request',
		}));
		return;
	}

	// Accept WebSocket upgrade (status 101)
	await server.write('res', JSON.stringify({
		status: 101,
		headers: {
			upgrade: 'websocket',
			connection: 'upgrade',
		},
	}));

	// Establish NestedTransport over the bidi relay channel
	// The bidi channel carries NestedTransport byte-stream traffic (bidi-frame message type)
	const nestedTransport = new NestedTransport({
		channel: bidiChannel,
		messageType: 'bidi-frame',
	});

	// Accept all channels from the client
	nestedTransport.addEventListener('newChannel', (event) => {
		event.accept();
	});

	await nestedTransport.start();

	// Request the application channel (client must open the same channel)
	const appChannel = await nestedTransport.requestChannel('echo');
	await appChannel.addMessageTypes(['data']);

	// Send welcome message
	await appChannel.write('data', JSON.stringify({
		type: 'welcome',
		message: 'WebSocket echo server ready',
	}));

	// Echo loop: read messages and echo them back
	while (true) {
		const msg = await appChannel.read({ only: 'data', decode: true });
		if (!msg) break; // Channel closed

		await msg.process(async () => {
			// Echo the message back
			await appChannel.write('data', msg.text);
		});
	}

	await nestedTransport.stop();
}
