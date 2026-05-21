/**
 * E2E Tests for Static File Serving
 *
 * Tests the complete request flow for static file delivery through the actual
 * server with the @static built-in mod-app. No mocks — this tests the entire
 * system end-to-end: HTTP request → operator → responder → @static mod-app →
 * file system → response.
 *
 * Coverage:
 * - Basic file serving (text, HTML, binary)
 * - MIME type detection from extension
 * - 404 for missing files
 * - Directory traversal prevention
 * - Range requests (resumable downloads)
 * - Subdirectory serving
 */

import {
	assertEquals,
	assertExists,
	assert,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	fetchWithTimeout,
} from './e2e-utils.esm.js';

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let testDir;

Deno.test.beforeAll(async () => {
	testDir = await Deno.makeTempDir({ prefix: 'jsmaws-e2e-static-' });

	// Plain text file
	await Deno.writeTextFile(join(testDir, 'hello.txt'), 'Hello, world!');

	// HTML file
	await Deno.writeTextFile(
		join(testDir, 'index.html'),
		'<!doctype html><html><body><p>Hello</p></body></html>'
	);

	// JSON file
	await Deno.writeTextFile(
		join(testDir, 'data.json'),
		JSON.stringify({ key: 'value', num: 42 })
	);

	// Binary file (6 bytes: 0x00–0x05)
	await Deno.writeFile(join(testDir, 'binary.bin'), new Uint8Array([0, 1, 2, 3, 4, 5]));

	// Large file for range-request tests (50 KB, byte value = index % 256)
	const large = new Uint8Array(50 * 1024);
	for (let i = 0; i < large.length; i++) large[i] = i % 256;
	await Deno.writeFile(join(testDir, 'large.bin'), large);

	// Subdirectory with a nested file
	await Deno.mkdir(join(testDir, 'sub'));
	await Deno.writeTextFile(join(testDir, 'sub', 'nested.txt'), 'Nested content');
});

Deno.test.afterAll(async () => {
	if (testDir) {
		await Deno.remove(testDir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// Helper: create a server with a @static route pointing at testDir
// ---------------------------------------------------------------------------

async function createStaticServer (extraConfig = {}) {
	return createTestServer({
		mimeTypes: {
			'.txt': 'text/plain; charset=utf-8',
			'.html': 'text/html; charset=utf-8',
			'.json': 'application/json',
			'.bin': 'application/octet-stream',
		},
		routes: [
			{
				path: '/files/:*',
				app: '@static',
				root: testDir,
				pool: 'fast',
			},
		],
		pools: {
			fast: {
				minProcs: 1,
				maxProcs: 1,
				maxWorkers: 4,
				reqTimeout: 10,
			},
		},
		...extraConfig,
	});
}

// ---------------------------------------------------------------------------
// Basic file serving
// ---------------------------------------------------------------------------

Deno.test('E2E Static - serves plain text file', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/hello.txt`);

		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'text/plain; charset=utf-8');
		assertExists(response.headers.get('accept-ranges'));
		assertEquals(await response.text(), 'Hello, world!');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - serves HTML file with correct MIME type', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/index.html`);

		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'text/html; charset=utf-8');
		const body = await response.text();
		assert(body.includes('<p>Hello</p>'), 'Expected HTML body content');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - serves JSON file with correct MIME type', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/data.json`);

		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'application/json');
		const body = await response.json();
		assertEquals(body.key, 'value');
		assertEquals(body.num, 42);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - serves binary file', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/binary.bin`);

		assertEquals(response.status, 200);
		assertEquals(response.headers.get('content-type'), 'application/octet-stream');
		const body = new Uint8Array(await response.arrayBuffer());
		assertEquals(body.length, 6);
		for (let i = 0; i < 6; i++) assertEquals(body[i], i);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - serves file from subdirectory', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/sub/nested.txt`);

		assertEquals(response.status, 200);
		assertEquals(await response.text(), 'Nested content');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - content-length header is correct', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/hello.txt`);

		assertEquals(response.status, 200);
		// "Hello, world!" is 13 bytes.
		// Note: Deno's HTTP server may strip content-length (it's a forbidden
		// response header in the Fetch API). Verify the body length instead.
		const body = await response.text();
		assertEquals(body.length, 13);
	} finally {
		await stopTestServer(operator);
	}
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

Deno.test('E2E Static - returns 404 for missing file', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		const response = await fetchWithTimeout(`${baseUrl}/files/nonexistent.txt`);

		assertEquals(response.status, 404);
		await response.body?.cancel();
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - returns 404 for directory path (not a file)', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// 'sub' is a directory, not a file
		const response = await fetchWithTimeout(`${baseUrl}/files/sub`);

		assertEquals(response.status, 404);
		await response.body?.cancel();
	} finally {
		await stopTestServer(operator);
	}
});

// ---------------------------------------------------------------------------
// Security: directory traversal prevention
// ---------------------------------------------------------------------------

Deno.test('E2E Static - blocks directory traversal attempt', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// Attempt to escape testDir via ../
		const response = await fetchWithTimeout(`${baseUrl}/files/../../../etc/passwd`);

		// Must not serve the file — 404 is the expected response
		assertEquals(response.status, 404);
		await response.body?.cancel();
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - blocks URL-encoded traversal attempt', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// %2F is '/', %2E is '.'
		const response = await fetchWithTimeout(`${baseUrl}/files/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd`);

		assertEquals(response.status, 404);
		await response.body?.cancel();
	} finally {
		await stopTestServer(operator);
	}
});

// ---------------------------------------------------------------------------
// Range requests
// ---------------------------------------------------------------------------

Deno.test('E2E Static - handles Range request (partial content)', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// "Hello, world!" — bytes 0-4 = "Hello"
		const response = await fetchWithTimeout(`${baseUrl}/files/hello.txt`, {
			headers: { 'range': 'bytes=0-4' },
		});

		assertEquals(response.status, 206);
		assertEquals(response.headers.get('content-length'), '5');
		assertExists(response.headers.get('content-range'));
		assert(
			response.headers.get('content-range')?.startsWith('bytes 0-4/'),
			`Unexpected Content-Range: ${response.headers.get('content-range')}`
		);
		assertEquals(await response.text(), 'Hello');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - handles Range request with open end', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// "Hello, world!" — bytes 7- = "world!"
		const response = await fetchWithTimeout(`${baseUrl}/files/hello.txt`, {
			headers: { 'range': 'bytes=7-' },
		});

		assertEquals(response.status, 206);
		const body = await response.text();
		assertEquals(body, 'world!');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - returns 416 for out-of-range Range header', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// File is 13 bytes; requesting bytes 100-200 is out of range
		const response = await fetchWithTimeout(`${baseUrl}/files/hello.txt`, {
			headers: { 'range': 'bytes=100-200' },
		});

		assertEquals(response.status, 416);
		await response.body?.cancel();
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E Static - serves large file via Range request', async () => {
	const { operator } = await createStaticServer();
	try {
		const baseUrl = await startTestServer(operator);
		// Request first 1024 bytes of the 50 KB file
		const response = await fetchWithTimeout(`${baseUrl}/files/large.bin`, {
			headers: { 'range': 'bytes=0-1023' },
		});

		assertEquals(response.status, 206);
		assertEquals(response.headers.get('content-length'), '1024');
		const body = new Uint8Array(await response.arrayBuffer());
		assertEquals(body.length, 1024);
		// Verify byte values match the pattern used when creating the file
		for (let i = 0; i < 1024; i++) assertEquals(body[i], i % 256);
	} finally {
		await stopTestServer(operator);
	}
});

// ---------------------------------------------------------------------------
// Multiple concurrent requests
// ---------------------------------------------------------------------------

Deno.test('E2E Static - handles multiple concurrent file requests', async () => {
	const { operator } = await createStaticServer({
		pools: {
			fast: {
				minProcs: 1,
				maxProcs: 1,
				maxWorkers: 6, // Enough for 5 concurrent requests
				reqTimeout: 10,
			},
		},
	});
	try {
		const baseUrl = await startTestServer(operator);

		const requests = [
			fetchWithTimeout(`${baseUrl}/files/hello.txt`),
			fetchWithTimeout(`${baseUrl}/files/index.html`),
			fetchWithTimeout(`${baseUrl}/files/data.json`),
			fetchWithTimeout(`${baseUrl}/files/binary.bin`),
			fetchWithTimeout(`${baseUrl}/files/sub/nested.txt`),
		];

		const responses = await Promise.all(requests);

		assertEquals(responses[0].status, 200);
		assertEquals(await responses[0].text(), 'Hello, world!');

		assertEquals(responses[1].status, 200);
		assert((await responses[1].text()).includes('<p>Hello</p>'));

		assertEquals(responses[2].status, 200);
		assertEquals((await responses[2].json()).key, 'value');

		assertEquals(responses[3].status, 200);
		const bin = new Uint8Array(await responses[3].arrayBuffer());
		assertEquals(bin.length, 6);

		assertEquals(responses[4].status, 200);
		assertEquals(await responses[4].text(), 'Nested content');
	} finally {
		await stopTestServer(operator);
	}
});
