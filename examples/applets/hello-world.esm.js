/**
 * Hello World Applet
 * Demonstrates simple HTTP response using the PolyTransport channel API
 *
 * Protocol: PolyTransport channel API via globalThis.JSMAWS.server
 * - Reads 'req' message (JSON text) for request metadata
 * - Writes 'res' message (JSON text) for response status + headers
 * - Writes 'res-frame' messages for response body chunks
 * - Signals end-of-stream with zero-data 'res-frame' (null data)
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;

	// Read the incoming request (all data is JSON text — use decode: true)
	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	let requestData;
	await reqMsg.process(() => {
		requestData = JSON.parse(reqMsg.text);
	});

	const { method, url, headers, routeParams, routeTail, body } = requestData;

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
				const contentType = headers['content-type'] || '';
				const bodyText = new TextDecoder().decode(body);

				if (contentType.includes('application/json')) {
					const bodyData = JSON.parse(bodyText);
					if (bodyData.name) name = bodyData.name;
					if (bodyData.greeting) greeting = bodyData.greeting;
				} else if (contentType.includes('application/x-www-form-urlencoded')) {
					const bodyParams = new URLSearchParams(bodyText);
					if (bodyParams.has('name')) name = bodyParams.get('name');
					if (bodyParams.has('greeting')) greeting = bodyParams.get('greeting');
				}
			} catch (parseError) {
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
			timestamp: new Date().toISOString(),
		});

		// Send response metadata
		await server.write('res', JSON.stringify({
			status: 200,
			headers: {
				'content-type': 'application/json',
				'content-length': new TextEncoder().encode(responseBody).length.toString(),
			},
		}));

		// Send response body and end-of-stream signal
		await server.write('res-frame', responseBody);
		await server.write('res-frame', null);

	} catch (error) {
		await server.write('res-error', JSON.stringify({
			error: error.message,
			stack: error.stack,
		}));
	}
}
