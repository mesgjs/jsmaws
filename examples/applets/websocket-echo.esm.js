/**
 * WebSocket Echo Applet
 * Demonstrates bidirectional communication with the unified frame protocol
 * Echoes back any messages received from the client
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

console.log('[WebSocket] Applet loaded');
self.onmessage = async (event) => {
	const { type, id, headers, mode, data, initialCredits, maxChunkSize } = event.data;
	console.log('[WebSocket] Message type:', type);
	console.log('[WebSocket] Headers:', headers);

	if (type === 'request' && headers?.upgrade?.toLowerCase() === 'websocket') {
		// Accept WebSocket upgrade
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
		console.log('[WebSocket] 101 upgrade sent');

		// Responder will send protocol parameters next
		return;
	}

	if (type === 'frame' && mode === 'bidi') {
		// Check for protocol parameters (first frame from responder)
		if (initialCredits !== undefined) {
			console.log(`[WebSocket] Connection ready with ${initialCredits} credits, max chunk ${maxChunkSize}`);

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
