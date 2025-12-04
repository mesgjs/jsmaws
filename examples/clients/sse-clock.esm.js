/**
 * SSE Client Test
 * Tests the SSE clock applet by connecting and receiving events
 * 
 * Usage: deno run --allow-net examples/clients/sse-client.js
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

async function testSSE() {
	const url = 'http://localhost:8080/sse-clock';

	console.log(`Connecting to ${url}...`);

	try {
		const response = await fetch(url);

		if (!response.ok) {
			console.error(`HTTP ${response.status}: ${response.statusText}`);
			return;
		}

		if (!response.body) {
			console.error('No response body');
			return;
		}

		console.log('Connected! Receiving events...\n');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let eventCount = 0;

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				console.log('\nConnection closed by server');
				break;
			}

			// Decode chunk and add to buffer
			buffer += decoder.decode(value, { stream: true });

			// Process complete SSE events (terminated by \n\n)
			const events = buffer.split('\n\n');
			buffer = events.pop() || ''; // Keep incomplete event in buffer

			for (const event of events) {
				if (!event.trim()) continue;

				// Parse SSE event
				const lines = event.split('\n');
				for (const line of lines) {
					if (line.startsWith('data: ')) {
						const data = line.substring(6);
						try {
							const parsed = JSON.parse(data);
							eventCount++;
							console.log(`Event ${eventCount}:`, parsed);
						} catch (e) {
							console.log(`Event ${eventCount}:`, data);
						}
					} else if (line.startsWith('event: ')) {
						console.log('Event type:', line.substring(7));
					} else if (line.startsWith('id: ')) {
						console.log('Event ID:', line.substring(4));
					} else if (line.startsWith('retry: ')) {
						console.log('Retry:', line.substring(7));
					}
				}
			}
		}

		console.log(`\nReceived ${eventCount} events total`);

	} catch (error) {
		console.error('Error:', error.message);
	}
}

// Run test
testSSE();
