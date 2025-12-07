/**
 * Static Content Applet Tests
 * Tests for the built-in static file serving applet
 */

import { assertEquals, assert, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { join } from 'https://deno.land/std@0.208.0/path/mod.ts';

// Test helper to create a worker and collect messages
async function createStaticWorker () {
	const workerPath = new URL('../src/applets/static-content.esm.js', import.meta.url).href;
	
	const worker = new Worker(workerPath, {
		type: 'module',
		deno: {
			permissions: {
				read: true,
				write: false,
				net: false,
				env: false,
				run: false,
			}
		}
	});

	return worker;
}

// Helper to collect all frame messages from worker
async function collectFrames (worker, timeout = 1000) {
	const frames = [];
	
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('Timeout waiting for frames'));
		}, timeout);

		worker.onmessage = (event) => {
			frames.push(event.data);
			
			// Check if this is the final frame
			if (event.data.final === true || event.data.type === 'error') {
				clearTimeout(timer);
				resolve(frames);
			}
		};

		worker.onerror = (error) => {
			clearTimeout(timer);
			reject(error);
		};
	});
}

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

Deno.test('Static Content - serves small text file', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-1',
			url: '/test.txt',
			headers: {},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.txt': 'text/plain'
				}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames.length, 1, 'Should send single frame for small file');
		assertEquals(frames[0].type, 'frame');
		assertEquals(frames[0].id, 'req-1');
		assertEquals(frames[0].mode, 'response');
		assertEquals(frames[0].status, 200);
		assertEquals(frames[0].headers['Content-Type'], 'text/plain');
		assertEquals(frames[0].headers['Accept-Ranges'], 'bytes');
		assertEquals(frames[0].final, true);
		assertEquals(frames[0].keepAlive, false);
		
		const content = new TextDecoder().decode(frames[0].data);
		assertEquals(content, 'Hello, World!');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - serves HTML file with correct MIME type', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-2',
			url: '/test.html',
			headers: {},
			routeParams: {},
			routeTail: '/test.html',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.html': 'text/html'
				}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames[0].headers['Content-Type'], 'text/html');
		
		const content = new TextDecoder().decode(frames[0].data);
		assertEquals(content, '<html><body>Test</body></html>');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - MIME type first-match strategy', async () => {
	const worker = await createStaticWorker();
	
	try {
		// File ending in .json should match .json before .on
		worker.postMessage({
			type: 'request',
			id: 'req-3',
			url: '/test.json',
			headers: {},
			routeParams: {},
			routeTail: '/test.json',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.on': 'text/plain',  // Should not match
					'.json': 'application/json',
				}
			}
		});

		const frames = await collectFrames(worker);
		assertEquals(frames[0].headers['Content-Type'], 'application/json');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - explicit MIME type overrides extension', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-4',
			url: '/test.txt',
			headers: {},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.txt': 'text/plain'
				},
				mimeType: 'application/custom'  // Explicit override
			}
		});

		const frames = await collectFrames(worker);
		assertEquals(frames[0].headers['Content-Type'], 'application/custom');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - default MIME type for unknown extension', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-5',
			url: '/binary.bin',
			headers: {},
			routeParams: {},
			routeTail: '/binary.bin',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}  // No MIME types configured
			}
		});

		const frames = await collectFrames(worker);
		assertEquals(frames[0].headers['Content-Type'], 'application/octet-stream');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - prevents path traversal attack', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-6',
			url: '/../../../etc/passwd',
			headers: {},
			routeParams: {},
			routeTail: '/../../../etc/passwd',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames.length, 1);
		assertEquals(frames[0].type, 'frame');
		assertEquals(frames[0].status, 404);
		assertEquals(frames[0].final, true);
		
		const content = new TextDecoder().decode(frames[0].data);
		assertEquals(content, 'File not found');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - returns 404 for non-existent file', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-7',
			url: '/nonexistent.txt',
			headers: {},
			routeParams: {},
			routeTail: '/nonexistent.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames[0].status, 404);
		assertEquals(frames[0].final, true);
		
		const content = new TextDecoder().decode(frames[0].data);
		assertEquals(content, 'File not found');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - returns 404 when root not configured', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-8',
			url: '/test.txt',
			headers: {},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				// root missing
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		assertEquals(frames[0].status, 404);
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - serves file from subdirectory', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-9',
			url: '/subdir/nested.txt',
			headers: {},
			routeParams: {},
			routeTail: '/subdir/nested.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.txt': 'text/plain'
				}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames[0].status, 200);
		const content = new TextDecoder().decode(frames[0].data);
		assertEquals(content, 'Nested file');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - chunks large file', async () => {
	const worker = await createStaticWorker();
	
	try {
		const chunkSize = 32768; // 32KB chunks
		
		worker.postMessage({
			type: 'request',
			id: 'req-10',
			url: '/large.bin',
			headers: {},
			routeParams: {},
			routeTail: '/large.bin',
			maxChunkSize: chunkSize,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker, 2000);
		
		// First frame should have headers
		assertEquals(frames[0].type, 'frame');
		assertEquals(frames[0].mode, 'response');
		assertEquals(frames[0].status, 200);
		assertEquals(frames[0].headers['Content-Length'], '102400');
		assertEquals(frames[0].headers['Accept-Ranges'], 'bytes');
		assertEquals(frames[0].data, null);
		assertEquals(frames[0].keepAlive, false);
		
		// Should have multiple data frames
		assert(frames.length > 2, 'Should have multiple frames for large file');
		
		// Collect all data
		const allData = [];
		for (let i = 1; i < frames.length; i++) {
			if (frames[i].data) {
				allData.push(...frames[i].data);
			}
		}
		
		// Verify total size
		assertEquals(allData.length, 100 * 1024);
		
		// Verify last frame is marked final
		const lastFrame = frames[frames.length - 1];
		assertEquals(lastFrame.final, true);
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - handles Range request', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-11',
			url: '/test.txt',
			headers: {
				'Range': 'bytes=0-4'  // First 5 bytes: "Hello"
			},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.txt': 'text/plain'
				}
			}
		});

		const frames = await collectFrames(worker);
		
		// First frame has headers
		assertEquals(frames[0].status, 206);  // Partial Content
		assertEquals(frames[0].headers['Content-Range'], 'bytes 0-4/13');
		assertEquals(frames[0].headers['Content-Length'], '5');
		
		// Collect data from all frames
		const allData = [];
		for (const frame of frames) {
			if (frame.data) {
				allData.push(...frame.data);
			}
		}
		
		const content = new TextDecoder().decode(new Uint8Array(allData));
		assertEquals(content, 'Hello');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - handles Range request with open end', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-12',
			url: '/test.txt',
			headers: {
				'Range': 'bytes=7-'  // From byte 7 to end: "World!"
			},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {
					'.txt': 'text/plain'
				}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames[0].status, 206);
		assertEquals(frames[0].headers['Content-Range'], 'bytes 7-12/13');
		
		const allData = [];
		for (const frame of frames) {
			if (frame.data) {
				allData.push(...frame.data);
			}
		}
		
		const content = new TextDecoder().decode(new Uint8Array(allData));
		assertEquals(content, 'World!');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - returns 416 for invalid Range', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-13',
			url: '/test.txt',
			headers: {
				'Range': 'bytes=100-200'  // Beyond file size
			},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames[0].status, 416);  // Range Not Satisfiable
		assertEquals(frames[0].headers['Content-Range'], 'bytes */13');
		assertEquals(frames[0].final, true);
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - returns 416 for malformed Range header', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-14',
			url: '/test.txt',
			headers: {
				'Range': 'invalid-range-header'
			},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		assertEquals(frames[0].status, 416);
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - chunks large Range request', async () => {
	const worker = await createStaticWorker();
	
	try {
		const chunkSize = 16384; // 16KB chunks
		
		worker.postMessage({
			type: 'request',
			id: 'req-15',
			url: '/large.bin',
			headers: {
				'Range': 'bytes=0-49999'  // First 50KB
			},
			routeParams: {},
			routeTail: '/large.bin',
			maxChunkSize: chunkSize,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker, 2000);
		
		assertEquals(frames[0].status, 206);
		assertEquals(frames[0].headers['Content-Range'], 'bytes 0-49999/102400');
		assertEquals(frames[0].headers['Content-Length'], '50000');
		
		// Should have multiple frames
		assert(frames.length > 2, 'Should chunk large range request');
		
		// Collect all data
		const allData = [];
		for (const frame of frames) {
			if (frame.data) {
				allData.push(...frame.data);
			}
		}
		
		assertEquals(allData.length, 50000);
		
		// Verify last frame is final
		assertEquals(frames[frames.length - 1].final, true);
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - handles case-insensitive Range header', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-16',
			url: '/test.txt',
			headers: {
				'range': 'bytes=0-4'  // lowercase 'range'
			},
			routeParams: {},
			routeTail: '/test.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		assertEquals(frames[0].status, 206);
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - returns 404 for unreadable file', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-18',
			url: '/unreadable.txt',
			headers: {},
			routeParams: {},
			routeTail: '/unreadable.txt',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		
		// Should return 404, not an error message
		assertEquals(frames[0].type, 'frame');
		assertEquals(frames[0].status, 404);
		assertEquals(frames[0].final, true);
		
		const content = new TextDecoder().decode(frames[0].data);
		assertEquals(content, 'File not found');
	} finally {
		worker.terminate();
	}
});

Deno.test('Static Content - serves binary file correctly', async () => {
	const worker = await createStaticWorker();
	
	try {
		worker.postMessage({
			type: 'request',
			id: 'req-17',
			url: '/binary.bin',
			headers: {},
			routeParams: {},
			routeTail: '/binary.bin',
			maxChunkSize: 65536,
			config: {
				root: testDir,
				mimeTypes: {}
			}
		});

		const frames = await collectFrames(worker);
		
		assertEquals(frames[0].status, 200);
		assertEquals(frames[0].data.length, 6);
		
		// Verify binary content
		for (let i = 0; i < 6; i++) {
			assertEquals(frames[0].data[i], i);
		}
	} finally {
		worker.terminate();
	}
});
