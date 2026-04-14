/**
 * WebSocket Client Test
 * Tests the WebSocket echo applet by sending and receiving messages
 * 
 * Usage: deno run --allow-net examples/clients/websocket-client.js
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

async function testWebSocket() {
	const url = 'ws://localhost:8080/ws-echo';

	console.log(`Connecting to ${url}...`);

	try {
		const ws = new WebSocket(url);
		ws.binaryType = 'arraybuffer';
		const decoder = new TextDecoder('utf-8');

		ws.onopen = () => {
			console.log('Connected!\n');

			// Send test messages
			const messages = [
				'Hello, WebSocket!',
				'Testing echo...',
				JSON.stringify({ type: 'test', value: 42 }),
				'.'.repeat(1024),
				'Final message'
			];

			let messageIndex = 0;

			const sendNext = () => {
				if (messageIndex < messages.length) {
					const msg = messages[messageIndex++];
					console.log(`Sending: "${msg}"`);
					ws.send(msg);

					// Send next message after 1 second
					setTimeout(sendNext, 1000);
				} else {
					// Close after all messages sent
					setTimeout(() => {
						console.log('\nClosing connection...');
						ws.close();
					}, 1000);
				}
			};

			sendNext();
		};

		ws.onmessage = (event) => {
			const data = decoder.decode(event.data);
			console.log(`Received: "${data}"`);

			// Try to parse as JSON
			try {
				const parsed = JSON.parse(data);
				console.log('Parsed:', parsed);
			} catch (e) {
				// Not JSON, that's fine
			}
		};

		ws.onerror = (error) => {
			console.error('WebSocket error:', error);
		};

		// Keep process alive until WebSocket closes
		await new Promise((resolve) => {
			ws.onclose = (event) => {
				console.log(`\nConnection closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
				resolve();
			};
		});

	} catch (error) {
		console.error('Error:', error.message);
	}
}

// Run test
testWebSocket();
