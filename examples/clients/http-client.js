/**
 * HTTP Client Test
 * Tests the hello-world applet with various requests
 * 
 * Usage: deno run --allow-net examples/clients/http-client.js
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

async function testHTTP() {
	const baseUrl = 'http://localhost:8080';
	
	const tests = [
		{
			name: 'Simple GET',
			url: `${baseUrl}/hello`,
			method: 'GET'
		},
		{
			name: 'GET with query parameter',
			url: `${baseUrl}/hello?name=Alice`,
			method: 'GET'
		},
		{
			name: 'GET with multiple parameters',
			url: `${baseUrl}/hello?name=Bob&greeting=Hi`,
			method: 'GET'
		},
		{
			name: 'POST request',
			url: `${baseUrl}/hello`,
			method: 'POST',
			body: JSON.stringify({ message: 'test' }),
			headers: { 'Content-Type': 'application/json' }
		}
	];
	
	for (const test of tests) {
		console.log(`\n${'='.repeat(60)}`);
		console.log(`Test: ${test.name}`);
		console.log(`URL: ${test.url}`);
		console.log(`Method: ${test.method}`);
		
		try {
			const options = {
				method: test.method,
				headers: test.headers || {}
			};
			
			if (test.body) {
				options.body = test.body;
				console.log(`Body: ${test.body}`);
			}
			
			const response = await fetch(test.url, options);
			
			console.log(`\nResponse:`);
			console.log(`  Status: ${response.status} ${response.statusText}`);
			console.log(`  Headers:`);
			for (const [key, value] of response.headers.entries()) {
				console.log(`    ${key}: ${value}`);
			}
			
			const body = await response.text();
			console.log(`  Body: ${body}`);
			
			// Try to parse as JSON
			try {
				const json = JSON.parse(body);
				console.log(`  Parsed:`, json);
			} catch (e) {
				// Not JSON
			}
			
		} catch (error) {
			console.error(`  Error: ${error.message}`);
		}
	}
	
	console.log(`\n${'='.repeat(60)}`);
	console.log('All tests complete');
}

// Run tests
testHTTP();
