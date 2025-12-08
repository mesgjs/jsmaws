/**
 * Hello World Applet
 * Demonstrates simple HTTP response with the unified frame protocol
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

self.onmessage = (event) => {
	const { type, id, method, url, routeParams, routeTail, body, headers } = event.data;

	if (type !== 'request') return;

	try {
		// Parse URL to access query parameters
		const urlObj = new URL(url);
		const searchParams = new URLSearchParams(urlObj.search);

		// Get name and greeting from query parameters or use defaults
		let name = searchParams.get('name') || 'World';
		let greeting = searchParams.get('greeting') || 'Hello';

		// For POST requests, also check body for parameters
		if (method === 'POST' && body && body.length > 0) {
			try {
				const contentType = headers['content-type'] || headers['content-type'] || '';
				const bodyText = new TextDecoder().decode(body);

				if (contentType.includes('application/json')) {
					// Parse JSON body
					const bodyData = JSON.parse(bodyText);
					if (bodyData.name) name = bodyData.name;
					if (bodyData.greeting) greeting = bodyData.greeting;
				} else if (contentType.includes('application/x-www-form-urlencoded')) {
					// Parse form-encoded body
					const bodyParams = new URLSearchParams(bodyText);
					if (bodyParams.has('name')) name = bodyParams.get('name');
					if (bodyParams.has('greeting')) greeting = bodyParams.get('greeting');
				}
			} catch (parseError) {
				// If body parsing fails, just use query params
				console.error('Failed to parse POST body:', parseError);
			}
		}

		// Create response body
		const responseBody = JSON.stringify({
			message: `${greeting}, ${name}!`,
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
				'content-type': 'application/json',
				'content-length': data.length.toString()
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
