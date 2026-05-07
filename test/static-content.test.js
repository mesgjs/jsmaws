/**
 * Static Content Mod-App Tests
 * Tests for the built-in static file serving mod-app
 *
 * The static content mod-app uses PolyTransport channel API via globalThis.JSMAWS.server:
 * - Reads 'req' message (JSON) for request metadata
 * - Writes 'res' message (JSON text) for response status + headers
 * - Writes 'res-frame' messages (binary Uint8Array) for response body chunks
 * - Signals end-of-stream with zero-data 'res-frame' (null data, default eom:true)
 * - Writes 'res-error' message (JSON text) on error
 *
 * Tests use PostMessageTransport to communicate with the mod-app via bootstrap.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';
import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';

const bootstrapPath = new URL('../src/apps/bootstrap.esm.js', import.meta.url).href;
const staticContentPath = new URL('../src/apps/static-content.esm.js', import.meta.url).href;

// Setup test directory and files
let testDir;

Deno.test.beforeAll(async () => {
	testDir = await Deno.makeTempDir({ prefix: 'jsmaws-static-test-' });

	// Create test files
	await Deno.writeTextFile(join(testDir, 'test.txt'), 'Hello, World!');
	await Deno.writeTextFile(join(testDir, 'test.html'), '<html><body>Test</body></html>');
	await Deno.writeTextFile(join(testDir, 'test.json'), '{"key":"value"}');
	await Deno.writeFile(join(testDir, 'binary.bin'), new Uint8Array([0, 1, 2, 3, 4, 5]));

	// Create large file for chunking tests (100KB)
	const largeContent = new Uint8Array(100 * 1024);
	for (let i = 0; i < largeContent.length; i++) {
		largeContent[i] = i % 256;
	}
	await Deno.writeFile(join(testDir, 'large.bin'), largeContent);

	// Create subdirectory with file
	await Deno.mkdir(join(testDir, 'subdir'));
	await Deno.writeTextFile(join(testDir, 'subdir', 'nested.txt'), 'Nested file');

	// Create unreadable file (exists but no read permission)
	await Deno.writeTextFile(join(testDir, 'unreadable.txt'), 'Cannot read this');
	await Deno.chmod(join(testDir, 'unreadable.txt'), 0o000);
});

Deno.test.afterAll(async () => {
	// Cleanup test directory
	if (testDir) {
		await Deno.remove(testDir, { recursive: true });
	}
});

/**
 * Drain remaining messages from a channel until end-of-stream (null/empty frame).
 * Mirrors the readToEOS helper in app-bootstrap.test.js.
 * @param {object} channel - PolyTransport channel to drain
 */
async function readToEOS (channel) {
	let message;
	while (message = await channel.read()) {
		message.done();
		if (!message.data && !message.text) break;
	}
}

/**
 * Set up a static content worker via bootstrap with PostMessageTransport.
 * @param {symbol} [c2cSymbol] - Optional C2C symbol for console interception.
 *   If not provided, native console logging is used (helpful for debugging).
 * Returns { appChannel, cleanup }
 */
async function setupStaticWorker (c2cSymbol = undefined) {
	const worker = new Worker(bootstrapPath, {
		type: 'module',
		deno: {
			permissions: {
				read: true, // Static content needs read access
				write: false,
				net: true, // Allow network for module loading
				env: false,
				run: false,
			},
		},
	});

	const transport = new PostMessageTransport({
		gateway: worker,
		c2cSymbol,
		maxChunkBytes: 65536,
	});

	transport.addEventListener('newChannel', (event) => {
		event.accept();
	});

	await transport.start();

	// Send setup instructions via the 'bootstrap' channel
	const bootstrapChannel = await transport.requestChannel('bootstrap');
	await bootstrapChannel.addMessageTypes(['setup']);
	await bootstrapChannel.write('setup', JSON.stringify({
		appPath: staticContentPath,
		mode: 'response',
		keepDeno: true, // Static content needs Deno file APIs
		keepWorkers: false,
	}));

	// Set up the mod-app communication channel
	const appChannel = await transport.requestChannel('app');
	await appChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error']);

	const cleanup = async () => {
		await transport.stop({ discard: true }).catch(() => {});
		worker.terminate();
	};

	return { appChannel, cleanup };
}

/**
 * Send a request to the static content mod-app and collect all response frames.
 * Returns { status, headers, body, bodyText } or { error } on res-error.
 */
async function sendStaticRequest (appChannel, requestData) {
	await appChannel.write('req', JSON.stringify(requestData));

	// Read response metadata (res or res-error)
	const resMeta = await appChannel.read({ only: ['res', 'res-error'], decode: true });
	let metaData;
	await resMeta.process(() => {
		metaData = JSON.parse(resMeta.text);
	});

	if (resMeta.messageType === 'res-error') {
		return { error: metaData };
	}

	const { status, headers } = metaData;

	// Collect all body chunks until end-of-stream (null frame: no data, no text).
	// Read without filters (like readToEOS) to avoid dechunk/only interaction issues.
	const bodyChunks = [];
	let message;
	while (message = await appChannel.read()) {
		if (!message.data && !message.text) {
			message.done();
			break;
		}
		await message.process(() => {
			if (message.data) {
				bodyChunks.push(message.data.toUint8Array());
			} else if (message.text) {
				bodyChunks.push(new TextEncoder().encode(message.text));
			}
		});
	}

	// Concatenate all body chunks
	const totalLength = bodyChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of bodyChunks) {
		body.set(chunk, offset);
		offset += chunk.length;
	}

	const bodyText = new TextDecoder().decode(body);

	return { status, headers, body, bodyText };
}

// ─── Basic file serving ───────────────────────────────────────────────────────

Deno.test('Static Content - serves small text file', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: {},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: { '.txt': 'text/plain' },
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.headers['content-type'], 'text/plain');
		assertEquals(result.headers['accept-ranges'], 'bytes');
		assertEquals(result.bodyText, 'Hello, World!');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - serves HTML file with correct MIME type', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.html',
			headers: {},
			routeParams: {},
			routeTail: '/test.html',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: { '.html': 'text/html' },
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.headers['content-type'], 'text/html');
		assertEquals(result.bodyText, '<html><body>Test</body></html>');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - MIME type first-match strategy', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.json',
			headers: {},
			routeParams: {},
			routeTail: '/test.json',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.on': 'text/plain',       // Should not match
					'.json': 'application/json',
				},
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.headers['content-type'], 'application/json');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - explicit MIME type overrides extension', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: {},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: { '.txt': 'text/plain' },
				mimeType: 'application/custom', // Explicit override
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.headers['content-type'], 'application/custom');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - default MIME type for unknown extension', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/binary.bin',
			headers: {},
			routeParams: {},
			routeTail: '/binary.bin',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}, // No MIME types configured
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.headers['content-type'], 'application/octet-stream');
	} finally {
		await cleanup();
	}
});

// ─── Security ─────────────────────────────────────────────────────────────────

Deno.test('Static Content - prevents path traversal attack', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/../../../etc/passwd',
			headers: {},
			routeParams: {},
			routeTail: '/../../../etc/passwd',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 404);
		assertEquals(result.bodyText, 'File not found');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - returns 404 for non-existent file', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/nonexistent.txt',
			headers: {},
			routeParams: {},
			routeTail: '/nonexistent.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 404);
		assertEquals(result.bodyText, 'File not found');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - returns 404 when root not configured', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: {},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				// root missing
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 404);
	} finally {
		await cleanup();
	}
});

// ─── Subdirectory and binary ──────────────────────────────────────────────────

Deno.test('Static Content - serves file from subdirectory', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/subdir/nested.txt',
			headers: {},
			routeParams: {},
			routeTail: '/subdir/nested.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: { '.txt': 'text/plain' },
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.bodyText, 'Nested file');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - serves binary file correctly', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/binary.bin',
			headers: {},
			routeParams: {},
			routeTail: '/binary.bin',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 200);
		assertEquals(result.body.length, 6);
		for (let i = 0; i < 6; i++) {
			assertEquals(result.body[i], i);
		}
	} finally {
		await cleanup();
	}
});

// ─── Chunking ─────────────────────────────────────────────────────────────────

Deno.test('Static Content - chunks large file', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const chunkSize = 32768; // 32KB chunks

		await appChannel.write('req', JSON.stringify({
			method: 'GET',
			url: 'https://example.com/large.bin',
			headers: {},
			routeParams: {},
			routeTail: '/large.bin',
			maxChunkSize: chunkSize,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		}));

		// Read response metadata
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		let metaData;
		await resMeta.process(() => {
			metaData = JSON.parse(resMeta.text);
		});

		assertEquals(metaData.status, 200);
		assertEquals(metaData.headers['content-length'], '102400');
		assertEquals(metaData.headers['accept-ranges'], 'bytes');

		// Collect all body chunks until end-of-stream.
		// Read without filters (like readToEOS) to avoid dechunk/only interaction issues.
		const bodyChunks = [];
		let frameCount = 0;
		let message;
		while (message = await appChannel.read()) {
			if (!message.data && !message.text) {
				message.done();
				break;
			}
			await message.process(() => {
				bodyChunks.push(message.data.toUint8Array());
				frameCount++;
			});
		}

		// Should have multiple frames for 100KB file with 32KB chunks
		assert(frameCount >= 3, `Expected at least 3 frames, got ${frameCount}`);

		// Verify total size
		const totalLength = bodyChunks.reduce((sum, chunk) => sum + chunk.length, 0);
		assertEquals(totalLength, 100 * 1024);
	} finally {
		await cleanup();
	}
});

// ─── Range requests ───────────────────────────────────────────────────────────

Deno.test('Static Content - handles Range request', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: { 'Range': 'bytes=0-4' }, // First 5 bytes: "Hello"
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: { '.txt': 'text/plain' },
			},
		});

		assertEquals(result.status, 206); // Partial Content
		assertEquals(result.headers['Content-Range'], 'bytes 0-4/13');
		assertEquals(result.headers['content-length'], '5');
		assertEquals(result.bodyText, 'Hello');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - handles Range request with open end', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: { 'Range': 'bytes=7-' }, // From byte 7 to end: "World!"
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: { '.txt': 'text/plain' },
			},
		});

		assertEquals(result.status, 206);
		assertEquals(result.headers['Content-Range'], 'bytes 7-12/13');
		assertEquals(result.bodyText, 'World!');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - returns 416 for invalid Range', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: { 'Range': 'bytes=100-200' }, // Beyond file size
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 416); // Range Not Satisfiable
		assertEquals(result.headers['Content-Range'], 'bytes */13');
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - returns 416 for malformed Range header', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: { 'Range': 'invalid-range-header' },
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 416);
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - handles case-insensitive Range header', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/test.txt',
			headers: { 'range': 'bytes=0-4' }, // lowercase 'range'
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 206);
	} finally {
		await cleanup();
	}
});

Deno.test('Static Content - chunks large Range request', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const chunkSize = 16384; // 16KB chunks

		await appChannel.write('req', JSON.stringify({
			method: 'GET',
			url: 'https://example.com/large.bin',
			headers: { 'Range': 'bytes=0-49999' }, // First 50KB
			routeParams: {},
			routeTail: '/large.bin',
			maxChunkSize: chunkSize,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		}));

		// Read response metadata
		const resMeta = await appChannel.read({ only: 'res', decode: true });
		let metaData;
		await resMeta.process(() => {
			metaData = JSON.parse(resMeta.text);
		});

		assertEquals(metaData.status, 206);
		assertEquals(metaData.headers['Content-Range'], 'bytes 0-49999/102400');
		assertEquals(metaData.headers['content-length'], '50000');

		// Collect all body chunks until end-of-stream.
		// Read without filters (like readToEOS) to avoid dechunk/only interaction issues.
		const bodyChunks = [];
		let frameCount = 0;
		let message;
		while (message = await appChannel.read()) {
			if (!message.data && !message.text) {
				message.done();
				break;
			}
			await message.process(() => {
				bodyChunks.push(message.data.toUint8Array());
				frameCount++;
			});
		}

		// Should have multiple frames for 50KB with 16KB chunks
		assert(frameCount >= 3, `Expected at least 3 frames, got ${frameCount}`);

		const totalLength = bodyChunks.reduce((sum, chunk) => sum + chunk.length, 0);
		assertEquals(totalLength, 50000);
	} finally {
		await cleanup();
	}
});

// ─── Permission errors ────────────────────────────────────────────────────────

Deno.test('Static Content - returns 404 for unreadable file', async () => {
	const { appChannel, cleanup } = await setupStaticWorker();

	try {
		const result = await sendStaticRequest(appChannel, {
			method: 'GET',
			url: 'https://example.com/unreadable.txt',
			headers: {},
			routeParams: {},
			routeTail: '/unreadable.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {},
			},
		});

		assertEquals(result.status, 404);
		assertEquals(result.bodyText, 'File not found');
	} finally {
		await cleanup();
	}
});
