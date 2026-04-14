/**
 * WebSocket Echo Applet
 * Demonstrates bidirectional communication with the unified frame protocol
 * Echoes back any messages received from the client
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

console.debug('Applet loaded');
self.onmessage = (event) => {
	const { type, id, headers, mode, data, initialCredits, maxChunkSize } = event.data;
	const loggable = Object.fromEntries(Object.entries({ type, id, mode, initialCredits, maxChunkSize, dataSize: (data && data.length) ? data.length : undefined }).filter(([_k, v]) => v !== undefined));
	console.debug(`Applet received message:`, loggable);

	if (type === 'request' && headers?.upgrade?.toLowerCase() === 'websocket') {
		// Accept WebSocket upgrade
		console.debug('Accepting WebSocket upgrade');
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
		if (data && data.length) {
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
