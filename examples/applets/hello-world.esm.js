/**
 * Hello World Applet
 * Demonstrates simple HTTP response with the unified frame protocol
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

self.onmessage = (event) => {
	const { type, id, method, url, routeParams, routeTail } = event.data;
	
	if (type !== 'request') return;
	
	try {
		// Parse URL to access query parameters
		const urlObj = new URL(url);
		const searchParams = new URLSearchParams(urlObj.search);
		
		// Get name from query parameter or use default
		const name = searchParams.get('name') || 'World';
		
		// Create response body
		const responseBody = JSON.stringify({
			message: `Hello, ${name}!`,
			method,
			path: urlObj.pathname,
			url,
			routeParams,
			routeTail,
			timestamp: new Date().toISOString()
		});
		
		const data = new TextEncoder().encode(responseBody);
		
		// Send complete response in single frame
		self.postMessage({
			type: 'frame',
			id,
			mode: 'response',
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': data.length.toString()
			},
			data,
			final: true,
			keepAlive: false
		});
		
		self.close();
		
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
