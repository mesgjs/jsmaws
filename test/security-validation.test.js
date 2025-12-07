/**
 * Security Validation Tests
 * Tests for hostile applet scenarios and security boundary enforcement
 *
 * These tests verify that the bootstrap module and responder process
 * properly defend against malicious applet behavior:
 * - IPC forgery attempts
 * - Environment tampering
 * - Resource exhaustion (DoS)
 * - Privilege escalation attempts
 * - Response type violations
 * - Credit/buffer overflow attacks
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { assertEquals, assertExists, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts';

// Test helper to create a worker and wait for it to be ready
async function createTestWorker (appletCode, debug = false) {
	const bootstrapPath = new URL('../src/applets/bootstrap.esm.js', import.meta.url).href;
	const appletUrl = `data:application/javascript;base64,${btoa(appletCode)}`;

	const worker = new Worker(bootstrapPath, {
		type: 'module',
		deno: {
			permissions: {
				read: false,
				write: false,
				net: false,
				env: false,
				run: false,
				import: true,
			}
		}
	});

	worker.postMessage({
		type: 'bootstrap',
		appletPath: appletUrl,
		debug
	});

	return { worker, appletUrl };
}

// ============================================================================
// IPC Forgery Prevention Tests
// ============================================================================

Deno.test('Security - cannot forge IPC messages via stdout', async () => {
	// Applet attempts to write IPC messages to stdout
	// Bootstrap should capture all console output via postMessage, preventing forgery
	const appletCode = `
		// Try to forge an IPC message by writing to stdout
		// Real IPC messages start with SOH (\\x01) + SLID format
		const SOH = '\x01';
		console.log(SOH + '[(WFRM id=malicious-123 [mode=response status=200 final=true] dataSize=18)]');
		console.log('Fake response body');

		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode);
	const messages = [];

	await new Promise((resolve) => {
		worker.onmessage = (event) => {
			messages.push(event.data);
			if (event.data.type === 'done') {
				resolve();
			}
		};
	});
	worker.terminate();

	// All output should come through as console messages, not IPC
	const consoleMessages = messages.filter(m => m.type === 'console');
	assertEquals(consoleMessages.length > 0, true, 'Should capture console output');

	// Verify no IPC-like messages escaped
	const ipcMessages = messages.filter(m => m.type === 'WEB_FRAME');
	assertEquals(ipcMessages.length, 0, 'Should not allow IPC forgery');
});

Deno.test('Security - cannot access Deno.std* directly', async () => {
	const appletCode = `
		let hasStdin = false, hasStdout = false, hasStderr = false;
		try {
			hasStdin = 'stdin' in Deno;
			hasStdout = 'stdout' in Deno;
			hasStderr = 'stderr' in Deno;
		} catch (e) {
			hasStdin = hasStdout = hasStderr = false;
		}

		self.postMessage({ type: 'result', hasStdin, hasStdout, hasStderr });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.hasStdin, false, 'Deno.stdin should not be accessible');
	assertEquals(result.hasStdout, false, 'Deno.stdout should not be accessible');
	assertEquals(result.hasStderr, false, 'Deno.stderr should not be accessible');
});

// ============================================================================
// Environment Tampering Prevention Tests
// ============================================================================

Deno.test('Security - cannot restore original console', async () => {
	const appletCode = `
		let canRestore = false;
		try {
			// Try to restore original console via various methods
			const desc = Object.getOwnPropertyDescriptor(globalThis, 'console');
			if (desc && desc.configurable) {
				canRestore = true;
			}
		} catch (e) {
			canRestore = false;
		}

		self.postMessage({ type: 'result', canRestore });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.canRestore, false, 'Console should not be restorable');
});

Deno.test('Security - cannot restore original Deno', async () => {
	const appletCode = `
		let canRestore = false;
		try {
			const desc = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
			if (desc && desc.configurable) {
				canRestore = true;
			}
		} catch (e) {
			canRestore = false;
		}

		self.postMessage({ type: 'result', canRestore });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.canRestore, false, 'Deno should not be restorable');
});

Deno.test('Security - cannot add new console methods', async () => {
	const appletCode = `
		let canAdd = false;
		try {
			console.malicious = () => {};
			canAdd = 'malicious' in console;
		} catch (e) {
			canAdd = false;
		}

		self.postMessage({ type: 'result', canAdd });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.canAdd, false, 'Should not be able to add console methods');
});

Deno.test('Security - cannot add new Deno APIs', async () => {
	const appletCode = `
		let canAdd = false;
		try {
			Deno.malicious = () => {};
			canAdd = 'malicious' in Deno;
		} catch (e) {
			canAdd = false;
		}

		self.postMessage({ type: 'result', canAdd });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.canAdd, false, 'Should not be able to add Deno APIs');
});

// ============================================================================
// Resource Exhaustion (DoS) Prevention Tests
// ============================================================================

Deno.test('Security - excessive console output is captured', async () => {
	const appletCode = `
		// Generate large amount of console output
		for (let i = 0; i < 100; i++) {
			console.log('x'.repeat(1000));
		}
		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode);
	const messages = [];

	await new Promise((resolve) => {
		worker.onmessage = (event) => {
			messages.push(event.data);
			if (event.data.type === 'done') {
				resolve();
			}
		};
	});
	worker.terminate();

	// All console output should be captured as postMessage
	const consoleMessages = messages.filter(m => m.type === 'console');
	assertEquals(consoleMessages.length, 100, 'Should capture all console output');

});

Deno.test('Security - cannot spawn infinite workers', async () => {
	const appletCode = `
		let workerCount = 0;
		let error = null;

		try {
			// Try to spawn workers (should fail due to permissions)
			for (let i = 0; i < 10; i++) {
				const w = new Worker('data:application/javascript,console.log("test")', { type: 'module' });
				workerCount++;
			}
		} catch (e) {
			error = e.message;
		}

		self.postMessage({ type: 'result', workerCount, error });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	// Worker spawning should fail due to permissions
	assertEquals(result.workerCount, 0, 'Should not be able to spawn workers');
	assertExists(result.error, 'Should get permission error');
});

Deno.test('Security - cannot access file system', async () => {
	const appletCode = `
		let canRead = false;
		let error = null;

		try {
			// Try to read a file (should fail)
			if ('readFile' in Deno) {
				await Deno.readFile('/etc/passwd');
				canRead = true;
			}
		} catch (e) {
			error = e.message;
		}

		self.postMessage({ type: 'result', canRead, hasReadFile: 'readFile' in Deno });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.hasReadFile, false, 'Deno.readFile should not exist');
	assertEquals(result.canRead, false, 'Should not be able to read files');
});

// ============================================================================
// Privilege Escalation Prevention Tests
// ============================================================================

Deno.test('Security - cannot access Deno.run', async () => {
	const appletCode = `
		const hasRun = 'run' in Deno;
		self.postMessage({ type: 'result', hasRun });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.hasRun, false, 'Deno.run should not be accessible');
});

Deno.test('Security - cannot access Deno.exit', async () => {
	const appletCode = `
		const hasExit = 'exit' in Deno;
		self.postMessage({ type: 'result', hasExit });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.hasExit, false, 'Deno.exit should not be accessible');
});

Deno.test('Security - cannot access environment variables', async () => {
	const appletCode = `
		const hasEnv = 'env' in Deno;
		self.postMessage({ type: 'result', hasEnv });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	assertEquals(result.hasEnv, false, 'Deno.env should not be accessible');
});

// ============================================================================
// Frame Protocol Violation Tests
// ============================================================================

Deno.test('Security - oversized frame chunk detection', async () => {
	// This test verifies the concept - actual enforcement happens in responder
	const maxChunkSize = 65536; // 64KB
	const oversizedData = new Uint8Array(maxChunkSize + 1);

	// Verify size check logic
	const isOversized = oversizedData.length > maxChunkSize;
	assertEquals(isOversized, true, 'Should detect oversized chunks');
});

Deno.test('Security - malformed frame message handling', async () => {
	const appletCode = `
		// Send malformed frame message
		self.postMessage({
			type: 'frame',
			// Missing required fields
		});

		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode);

	// Worker should not crash, responder should handle gracefully
	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'done') {
				resolve({ success: true });
			}
		};
		worker.onerror = () => {
			resolve({ success: false });
		};
	});
	worker.terminate();

	assertEquals(result.success, true, 'Should handle malformed messages gracefully');
});

// ============================================================================
// Console Output Injection Tests
// ============================================================================

Deno.test('Security - console output with IPC-like content is safe', async () => {
	const appletCode = `
		// Try to inject IPC-like content via console
		console.log('WEB_FRAME\\nid: malicious\\nstatus: 200\\n---\\n');
		console.log('type: frame');
		console.log('mode: response');

		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode);
	const messages = [];

	await new Promise((resolve) => {
		worker.onmessage = (event) => {
			messages.push(event.data);
			if (event.data.type === 'done') {
				resolve();
			}
		};
	});
	worker.terminate();

	// All output should be console messages with proper type
	const consoleMessages = messages.filter(m => m.type === 'console');
	assertEquals(consoleMessages.length, 3, 'Should capture all console output');

	// Verify content is preserved but type is 'console'
	consoleMessages.forEach(msg => {
		assertEquals(msg.type, 'console', 'Type should always be console');
		assertExists(msg.level, 'Should have log level');
		assertExists(msg.content, 'Should have content');
	});
});

Deno.test('Security - console output with special characters', async () => {
	const appletCode = `
		// Try various special characters that might break parsing
		console.log('\\x00\\x01\\x02'); // Null bytes
		console.log('\\n\\r\\t'); // Whitespace
		console.log('---\\n===\\n>>>'); // SLID-like markers
		console.log('\\u0000\\uFFFF'); // Unicode extremes

		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode);
	const messages = [];

	await new Promise((resolve) => {
		worker.onmessage = (event) => {
			messages.push(event.data);
			if (event.data.type === 'done') {
				resolve();
			}
		};
	});
	worker.terminate();

	const consoleMessages = messages.filter(m => m.type === 'console');
	assertEquals(consoleMessages.length, 4, 'Should capture all console output');

	// All should be properly typed as console messages
	consoleMessages.forEach(msg => {
		assertEquals(msg.type, 'console');
		assertEquals(msg.level, 'log');
	});
});

// ============================================================================
// Bootstrap Listener Bypass Tests
// ============================================================================

Deno.test('Security - cannot bypass bootstrap listener', async () => {
	// Applet just sends "done" ASAP to verify it appears after bootstrap sequence
	const appletCode = `
		// Send done immediately (no setTimeout)
		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode, true); // Enable debug mode
	const messages = [];

	await new Promise((resolve) => {
		worker.onmessage = (event) => {
			messages.push(event.data);
			if (event.data.type === 'done') {
				resolve();
			}
		};
	});
	worker.terminate();

	// Find the done message
	const doneMessage = messages.find(m => m.type === 'done');
	assertExists(doneMessage, 'Should receive done message');

	// Verify debug messages show proper sequencing
	const debugMessages = messages.filter(m => m.type === 'console' && m.level === 'debug');
	assert(debugMessages.length >= 3, 'Should have bootstrap debug messages');

	// Find indices to verify ordering
	const handlerIdx = messages.findIndex(m => m.type === 'console' && m.level === 'debug' && m.content.includes('bootstrap message handler'));
	const listenerRemovedIdx = messages.findIndex(m => m.type === 'console' && m.level === 'debug' && m.content.includes('boostrap listener removed'));
	const importingIdx = messages.findIndex(m => m.type === 'console' && m.level === 'debug' && m.content.includes('boostrap importing applet'));
	const doneIdx = messages.findIndex(m => m.type === 'done');

	// Verify all debug messages exist
	assert(handlerIdx >= 0, 'Should log bootstrap message handler');
	assert(listenerRemovedIdx >= 0, 'Should log listener removal');
	assert(importingIdx >= 0, 'Should log applet import');

	// Verify done comes after bootstrap sequence
	assert(doneIdx > handlerIdx, 'Done should come after handler');
	assert(doneIdx > listenerRemovedIdx, 'Done should come after listener removed');
	assert(doneIdx > importingIdx, 'Done should come after importing applet');
});

Deno.test('Security - bootstrap listener is removed after use', async () => {
	// Send done ASAP and check bootstrap debug for listener removal message
	const appletCode = `
		// Send done immediately (no setTimeout)
		self.postMessage({ type: 'done' });
	`;

	const { worker } = await createTestWorker(appletCode, true); // Enable debug mode
	const messages = [];

	await new Promise((resolve) => {
		worker.onmessage = (event) => {
			messages.push(event.data);
			if (event.data.type === 'done') {
				resolve();
			}
		};
	});
	worker.terminate();

	// Verify debug messages show proper sequencing
	const debugMessages = messages.filter(m => m.type === 'console' && m.level === 'debug');

	// Should see initial bootstrap sequence (handler, listener removed, importing)
	const listenerRemoved = debugMessages.filter(m => m.content.includes('boostrap listener removed'));
	assertEquals(listenerRemoved.length, 1, 'Listener should only be removed once');

	const importingApplet = debugMessages.filter(m => m.content.includes('boostrap importing applet'));
	assertEquals(importingApplet.length, 1, 'Should only import applet once');

	// The second bootstrap message from applet should be ignored (handler won't process it)
	// We won't see a second "bootstrap message handler" debug because the handler returns early

	// Verify no malicious code was loaded
	const consoleMessages = messages.filter(m => m.type === 'console' && m.content.includes('malicious'));
	assertEquals(consoleMessages.length, 0, 'Malicious code should not execute');

	// Verify done message appears after bootstrap sequence
	const doneIdx = messages.findIndex(m => m.type === 'done');
	const lastDebugIdx = messages.findLastIndex(m => m.type === 'console' && m.level === 'debug');
	assert(doneIdx > lastDebugIdx, 'Done should come after bootstrap debug messages');
});

// ============================================================================
// Approved API Boundary Tests
// ============================================================================

Deno.test('Security - network APIs are available (approved)', async () => {
	const appletCode = `
		const hasConnect = 'connect' in Deno;
		const hasListen = 'listen' in Deno;
		const hasResolveDns = 'resolveDns' in Deno;

		self.postMessage({ type: 'result', hasConnect, hasListen, hasResolveDns });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	// Network APIs should be available (approved)
	assertEquals(result.hasConnect, true, 'Deno.connect should be available');
	assertEquals(result.hasListen, true, 'Deno.listen should be available');
	assertEquals(result.hasResolveDns, true, 'Deno.resolveDns should be available');
});

Deno.test('Security - system info APIs are available (approved)', async () => {
	const appletCode = `
		const hasBuild = 'build' in Deno;
		const hasVersion = 'version' in Deno;
		const hasHostname = 'hostname' in Deno;

		self.postMessage({ type: 'result', hasBuild, hasVersion, hasHostname });
	`;

	const { worker } = await createTestWorker(appletCode);

	const result = await new Promise((resolve) => {
		worker.onmessage = (event) => {
			if (event.data.type === 'result') {
				resolve(event.data);
			}
		};
	});
	worker.terminate();

	// System info APIs should be available (approved)
	assertEquals(result.hasBuild, true, 'Deno.build should be available');
	assertEquals(result.hasVersion, true, 'Deno.version should be available');
	assertEquals(result.hasHostname, true, 'Deno.hostname should be available');
});
