/**
 * SSE Clock Applet
 * Demonstrates Server-Sent Events with the unified frame protocol
 * Sends current time every second
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

self.onmessage = async (event) => {
	const { type, id, maxChunkSize } = event.data;
	
	if (type !== 'request') return;
	
	try {
		// Send first frame (establishes streaming connection)
		self.postMessage({
			type: 'frame',
			id,
			mode: 'stream',
			status: 200,
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Access-Control-Allow-Origin': '*'
			},
			data: null,
			// final: false, // (default)
			keepAlive: true
		});
		
		// Send time updates every second for 10 seconds
		let count = 0;
		const maxUpdates = 10;
		
		const interval = setInterval(() => {
			count++;
			
			const eventData = {
				timestamp: new Date().toISOString(),
				count,
				message: `Update ${count} of ${maxUpdates}`
			};
			
			const sseMessage = `data: ${JSON.stringify(eventData)}\n\n`;
			const chunk = new TextEncoder().encode(sseMessage);
			
			// Check chunk size
			if (chunk.length > maxChunkSize) {
				console.error('SSE message exceeds maxChunkSize');
				clearInterval(interval);
				self.close();
				return;
			}
			
			// Send SSE event
			self.postMessage({
				type: 'frame',
				id,
				data: chunk,
				final: true  // Each SSE event is one complete frame
			});
			
			// Stop after maxUpdates
			if (count >= maxUpdates) {
				clearInterval(interval);
				
				// Send final close frame
				self.postMessage({
					type: 'frame',
					id,
					data: null,
					final: true,
					keepAlive: false
				});
				
				self.close();
			}
		}, 1000);
		
	} catch (error) {
		self.postMessage({
			type: 'error',
			id,
			error: error.message,
			stack: error.stack
		});
		self.close();
	}
};
