/**
 * WebSocket Echo Applet
 * Demonstrates bidirectional communication with the unified frame protocol
 * Echoes back any messages received from the client
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

console.log('Applet loaded');
self.onmessage = (event) => {
	const { type, id, headers, mode, data, initialCredits, maxChunkSize } = event.data;
	console.log('Applet received message:', type);

	if (type === 'request' && headers?.upgrade?.toLowerCase() === 'websocket') {
		// Accept WebSocket upgrade
		console.log('Accepting WebSocket upgrade');
		self.postMessage({
			type: 'frame',
			id,
			mode: 'bidi',
			status: 101,
			headers: {
				upgrade: 'websocket',
				connection: 'upgrade',
				'sec-websocket-accept': headers['sec-websocket-key'] // Simplified - real impl would compute
			},
			data: null,
			final: true,
			keepAlive: true
		});

		// Responder will send protocol parameters next
		return;
	}

	if (type === 'frame' && mode === 'bidi') {
		// Check for protocol parameters (first frame from responder)
		if (initialCredits !== undefined) {
			console.log(`Bidi connection ready with ${initialCredits} credits, max chunk ${maxChunkSize}`);

			// Send welcome message
			const welcome = new TextEncoder().encode(JSON.stringify({
				type: 'welcome',
				message: 'WebSocket echo server ready',
				maxChunkSize
			}));

			self.postMessage({
				type: 'frame',
				id,
				data: welcome,
				final: true
			});
			return;
		}

		// Received data from client - echo it back
		if (data) {
			// Echo the data
			self.postMessage({
				type: 'frame',
				id,
				data: data,
				final: true
			});
		}
	}
};
