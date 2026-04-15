/**
 * WebSocket Echo Client
 * Tests the WebSocket echo applet using PolyTransport WebSocketTransport + NestedTransport
 *
 * Usage: deno run --allow-net examples/clients/ws-echo.esm.js
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { WebSocketTransport } from '@poly-transport/transport/websocket.esm.js';
import { NestedTransport } from '@poly-transport/transport/nested.esm.js';

async function testWebSocket () {
	const url = 'ws://localhost:8080/ws-echo';

	console.log(`Connecting to ${url}...`);

	try {
		const ws = new WebSocket(url);

		// Create WebSocketTransport for the connection
		const wsTransport = new WebSocketTransport({
			ws,
			c2cSymbol: null, // No C2C needed for client-facing transport
		});

		// Accept all channels
		wsTransport.addEventListener('newChannel', (event) => {
			event.accept();
		});

		await wsTransport.start();
		console.log('WebSocketTransport started');

		// Open the pre-designated 'bidi' channel
		const bidiChannel = await wsTransport.requestChannel('bidi');
		await bidiChannel.addMessageTypes(['bidi-frame']);

		// Establish NestedTransport over the bidi channel
		const nestedTransport = new NestedTransport({
			channel: bidiChannel,
			messageType: 'bidi-frame',
		});

		nestedTransport.addEventListener('newChannel', (event) => {
			event.accept();
		});

		await nestedTransport.start();
		console.log('NestedTransport started');

		// Open the application channel (must match the applet's channel name)
		const appChannel = await nestedTransport.requestChannel('echo');
		await appChannel.addMessageTypes(['data']);

		// Read welcome message
		const welcomeMsg = await appChannel.read({ only: 'data', decode: true });
		if (welcomeMsg) {
			await welcomeMsg.process(() => {
				console.log('Welcome:', welcomeMsg.text);
			});
		}

		// Send test messages
		const messages = [
			'Hello, WebSocket!',
			'Testing echo...',
			JSON.stringify({ type: 'test', value: 42 }),
			'.'.repeat(1024),
			'Final message',
		];

		for (const msg of messages) {
			console.log(`Sending: "${msg.length > 80 ? msg.slice(0, 80) + '...' : msg}"`);
			await appChannel.write('data', msg);

			// Read echo response
			const echoMsg = await appChannel.read({ only: 'data', decode: true });
			if (echoMsg) {
				await echoMsg.process(() => {
					const text = echoMsg.text;
					console.log(`Received: "${text.length > 80 ? text.slice(0, 80) + '...' : text}"`);
				});
			}

			// Wait 1 second between messages
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		console.log('\nClosing connection...');
		await nestedTransport.stop();
		await wsTransport.stop();
		console.log('Connection closed');

	} catch (error) {
		console.error('Error:', error.message);
	}
}

// Run test
testWebSocket();
