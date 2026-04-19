/**
 * E2E Tests for WebSocket Bidirectional Communication
 *
 * Tests the complete bidirectional protocol implementation including:
 * - WebSocket upgrade and connection establishment
 * - Bidirectional message exchange (echo)
 * - Credit-based flow control
 * - Connection lifecycle management
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	connectWebSocket
} from './e2e-utils.esm.js';

// Helper to decode WebSocket messages (since binaryType is 'arraybuffer')
const decoder = new TextDecoder('utf-8');
function decodeMessage(data) {
	if (data instanceof ArrayBuffer) {
		return decoder.decode(data);
	}
	return data;
}

// Helper to wait for next WebSocket message
async function waitForMessage(ws, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error('Timeout waiting for message'));
		}, timeoutMs);

		const handler = (event) => {
			clearTimeout(timeout);
			ws.removeEventListener('message', handler);
			resolve(decodeMessage(event.data));
		};

		ws.addEventListener('message', handler);
		ws.addEventListener('error', (error) => {
			clearTimeout(timeout);
			ws.removeEventListener('message', handler);
			reject(error);
		});
	});
}

Deno.test('E2E WebSocket - Basic connection and upgrade', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		// Connect to WebSocket
		const ws = await connectWebSocket(wsUrl, 5000);

		// Wait for connection to be fully established
		await new Promise(resolve => setTimeout(resolve, 100));

		// Verify connection is open
		assertEquals(ws.readyState, WebSocket.OPEN, 'WebSocket should be open');

		// Close connection
		ws.close();
		await new Promise(resolve => {
			ws.onclose = resolve;
		});

		assertEquals(ws.readyState, WebSocket.CLOSED, 'WebSocket should be closed');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Receive welcome message', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Wait for welcome message (skip console logs)
		const welcomeMessage = await waitForMessage(ws);

		// Parse and verify welcome message
		const welcome = JSON.parse(welcomeMessage);
		assertEquals(welcome.type, 'welcome', 'Should receive welcome message');
		assertEquals(welcome.message, 'WebSocket echo server ready');
		assertExists(welcome.maxChunkSize, 'Welcome should include maxChunkSize');

		ws.close();
		await new Promise(resolve => { ws.onclose = resolve; });
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Echo single message', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Skip welcome message
		await waitForMessage(ws);

		// Send test message
		const testMessage = JSON.stringify({ type: 'test', data: 'Hello, WebSocket!' + ' x'.repeat(600) });
		ws.send(testMessage);

		// Wait for echo
		const echoMessage = await waitForMessage(ws);

		// Verify echo matches original
		assertEquals(echoMessage, testMessage, 'Echo should match original message');

		ws.close();
		await new Promise(resolve => { ws.onclose = resolve; });
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Echo multiple messages', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Skip welcome message
		await waitForMessage(ws);

		// Send and verify multiple messages
		const messages = [
			'Message 1',
			'Message 2',
			'Message 3',
			'Message 4',
			'Message 5'
		];

		for (const msg of messages) {
			// Send message
			ws.send(msg);

			// Wait for echo
			const echo = await waitForMessage(ws);

			assertEquals(echo, msg, `Echo should match message: ${msg}`);
		}

		ws.close();
		await new Promise(resolve => { ws.onclose = resolve; });
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Binary data echo', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Skip welcome message
		await waitForMessage(ws);

		// Send binary data
		const binaryData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		ws.send(binaryData);

		// Wait for echo (keep as ArrayBuffer for binary comparison)
		const echo = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Timeout waiting for binary echo'));
			}, 5000);

			ws.onmessage = (event) => {
				clearTimeout(timeout);
				resolve(event.data); // Keep as ArrayBuffer
			};

			ws.onerror = (error) => {
				clearTimeout(timeout);
				reject(error);
			};
		});

		// Convert ArrayBuffer to Uint8Array for comparison
		const echoArray = new Uint8Array(echo);
		assertEquals(echoArray.length, binaryData.length, 'Echo length should match');
		for (let i = 0; i < binaryData.length; i++) {
			assertEquals(echoArray[i], binaryData[i], `Byte ${i} should match`);
		}

		ws.close();
		await new Promise(resolve => { ws.onclose = resolve; });
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Large message echo', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Skip welcome message
		await waitForMessage(ws);

		// Send large message (50KB - within the 64KB maxChunkSize limit)
		const largeMessage = 'x'.repeat(50 * 1024);
		ws.send(largeMessage);

		// Wait for echo
		const echo = await waitForMessage(ws, 10000); // Longer timeout for large message

		assertEquals(echo.length, largeMessage.length, 'Echo length should match');
		assertEquals(echo, largeMessage, 'Echo should match large message');

		ws.close();
		await new Promise(resolve => { ws.onclose = resolve; });
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Concurrent bidirectional messages', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Skip welcome message
		await waitForMessage(ws);

		// Send multiple messages rapidly without waiting for echoes
		const messages = [];
		for (let i = 0; i < 10; i++) {
			const msg = `Concurrent message ${i}`;
			messages.push(msg);
			ws.send(msg);
		}

		// Collect all echoes
		const echoes = [];
		for (let i = 0; i < messages.length; i++) {
			const echo = await waitForMessage(ws);
			echoes.push(echo);
		}

		// Verify all messages were echoed (order may vary)
		assertEquals(echoes.length, messages.length, 'Should receive all echoes');
		for (const msg of messages) {
			const found = echoes.includes(msg);
			assertEquals(found, true, `Should find echo for: ${msg}`);
		}

		ws.close();
		await new Promise(resolve => { ws.onclose = resolve; });
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Connection close handling', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const ws = await connectWebSocket(wsUrl, 5000);

		// Skip welcome message
		await waitForMessage(ws);

		// Send a message
		ws.send('Test message before close');

		// Wait for echo
		await waitForMessage(ws);

		// Close connection gracefully
		const closePromise = new Promise(resolve => {
			ws.onclose = (event) => {
				resolve(event);
			};
		});

		ws.close(1000, 'Normal closure');
		const closeEvent = await closePromise;

		assertEquals(closeEvent.code, 1000, 'Should close with normal code');
		assertEquals(ws.readyState, WebSocket.CLOSED, 'Should be closed');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Multiple concurrent connections', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/applets/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 2, maxProcs: 2 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		// Create multiple connections
		const connections = await Promise.all([
			connectWebSocket(wsUrl, 5000),
			connectWebSocket(wsUrl, 5000),
			connectWebSocket(wsUrl, 5000)
		]);

		// Skip welcome messages
		await Promise.all(connections.map(ws => waitForMessage(ws)));

		// Send unique message on each connection
		const messages = connections.map((ws, i) => {
			const msg = `Connection ${i} message`;
			ws.send(msg);
			return msg;
		});

		// Verify each connection gets its own echo
		const echoes = await Promise.all(connections.map(ws => waitForMessage(ws)));

		// Verify echoes match messages
		for (let i = 0; i < messages.length; i++) {
			assertEquals(echoes[i], messages[i], `Connection ${i} echo should match`);
		}

		// Close all connections
		await Promise.all(connections.map(ws => {
			const closePromise = new Promise(resolve => { ws.onclose = resolve; });
			ws.close();
			return closePromise;
		}));
	} finally {
		await stopTestServer(operator);
	}
});
