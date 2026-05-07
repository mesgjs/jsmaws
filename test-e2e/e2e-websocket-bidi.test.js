/**
 * E2E Tests for WebSocket Bidirectional Communication using PolyTransport
 *
 * Tests the complete bidirectional protocol implementation including:
 * - WebSocket upgrade and connection establishment
 * - PolyTransport WebSocketTransport + NestedTransport
 * - Bidirectional message exchange (echo)
 * - PolyTransport sliding-window flow control
 * - Connection lifecycle management
 */

import { assertEquals, assertExists } from 'jsr:@std/assert';
import {
	createTestServer,
	startTestServer,
	stopTestServer,
	connectPolyTransportWebSocket,
	closePolyTransportWebSocket
} from './e2e-utils.esm.js';

Deno.test('E2E WebSocket - Basic connection and upgrade with PolyTransport', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		// Connect using PolyTransport
		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Verify connection is established
		assertExists(connection.wsTransport, 'WebSocketTransport should exist');
		assertExists(connection.nestedTransport, 'NestedTransport should exist');
		assertExists(connection.appChannel, 'App channel should exist');

		// Close connection
		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Receive welcome message', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Wait for welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		assertExists(welcomeMsg, 'Should receive welcome message');

		await welcomeMsg.process(() => {
			const welcome = JSON.parse(welcomeMsg.text);
			assertEquals(welcome.type, 'welcome', 'Should receive welcome message');
			assertEquals(welcome.message, 'WebSocket echo server ready');
		});

		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Echo single message', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Skip welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await welcomeMsg.process(() => {});

		// Send test message
		const testMessage = JSON.stringify({ type: 'test', data: 'Hello, WebSocket!' });
		await connection.appChannel.write('data', testMessage);

		// Wait for echo
		const echoMsg = await connection.appChannel.read({ only: 'data', decode: true });
		assertExists(echoMsg, 'Should receive echo');

		await echoMsg.process(() => {
			assertEquals(echoMsg.text, testMessage, 'Echo should match original message');
		});

		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Echo multiple messages', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Skip welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await welcomeMsg.process(() => {});

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
			await connection.appChannel.write('data', msg);

			// Wait for echo
			const echoMsg = await connection.appChannel.read({ only: 'data', decode: true });
			assertExists(echoMsg, `Should receive echo for: ${msg}`);

			await echoMsg.process(() => {
				assertEquals(echoMsg.text, msg, `Echo should match message: ${msg}`);
			});
		}

		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Binary data echo', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Skip welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await welcomeMsg.process(() => {});

		// Send binary data
		const binaryData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		await connection.appChannel.write('data', binaryData);

		// Wait for echo
		const echoMsg = await connection.appChannel.read({ only: 'data' });
		assertExists(echoMsg, 'Should receive binary echo');

		await echoMsg.process(() => {
			// Convert VirtualBuffer to Uint8Array for comparison
			const echoArray = echoMsg.data.toUint8Array();
			assertEquals(echoArray.length, binaryData.length, 'Echo length should match');
			for (let i = 0; i < binaryData.length; i++) {
				assertEquals(echoArray[i], binaryData[i], `Byte ${i} should match`);
			}
		});

		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Large message echo', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Skip welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await welcomeMsg.process(() => {});

		// Send large message (50KB - within the 64KB maxChunkSize limit)
		const largeMessage = 'x'.repeat(50 * 1024);
		await connection.appChannel.write('data', largeMessage);

		// Wait for echo (with longer timeout for large message)
		const echoMsg = await connection.appChannel.read({ only: 'data', decode: true, timeout: 10000 });
		assertExists(echoMsg, 'Should receive large message echo');

		await echoMsg.process(() => {
			assertEquals(echoMsg.text.length, largeMessage.length, 'Echo length should match');
			assertEquals(echoMsg.text, largeMessage, 'Echo should match large message');
		});

		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Concurrent bidirectional messages', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Skip welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await welcomeMsg.process(() => {});

		// Send multiple messages rapidly without waiting for echoes
		const messages = [];
		for (let i = 0; i < 10; i++) {
			const msg = `Concurrent message ${i}`;
			messages.push(msg);
			await connection.appChannel.write('data', msg);
		}

		// Collect all echoes
		const echoes = [];
		for (let i = 0; i < messages.length; i++) {
			const echoMsg = await connection.appChannel.read({ only: 'data', decode: true });
			assertExists(echoMsg, `Should receive echo ${i}`);
			await echoMsg.process(() => {
				echoes.push(echoMsg.text);
			});
		}

		// Verify all messages were echoed (order may vary)
		assertEquals(echoes.length, messages.length, 'Should receive all echoes');
		for (const msg of messages) {
			const found = echoes.includes(msg);
			assertEquals(found, true, `Should find echo for: ${msg}`);
		}

		await closePolyTransportWebSocket(connection);
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Connection close handling', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
		],
		pools: {
			standard: { minProcs: 1, maxProcs: 1 }
		}
	});

	try {
		const baseUrl = await startTestServer(operator);
		const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws-echo';

		const connection = await connectPolyTransportWebSocket(wsUrl, 5000);

		// Skip welcome message
		const welcomeMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await welcomeMsg.process(() => {});

		// Send a message
		await connection.appChannel.write('data', 'Test message before close');

		// Wait for echo
		const echoMsg = await connection.appChannel.read({ only: 'data', decode: true });
		await echoMsg.process(() => {});

		// Close connection gracefully
		await closePolyTransportWebSocket(connection);

		// Verify channel is closed
		assertEquals(connection.appChannel.state, 'closed', 'Channel should be closed');
	} finally {
		await stopTestServer(operator);
	}
});

Deno.test('E2E WebSocket - Multiple concurrent connections', async () => {
	const { operator } = await createTestServer({
		routes: [
			{ path: '/ws-echo', pool: 'standard', app: '../examples/apps/websocket-echo.esm.js' }
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
			connectPolyTransportWebSocket(wsUrl, 5000),
			connectPolyTransportWebSocket(wsUrl, 5000),
			connectPolyTransportWebSocket(wsUrl, 5000)
		]);

		// Skip welcome messages
		await Promise.all(connections.map(async (conn) => {
			const welcomeMsg = await conn.appChannel.read({ only: 'data', decode: true });
			await welcomeMsg.process(() => {});
		}));

		// Send unique message on each connection
		const messages = connections.map((conn, i) => `Connection ${i} message`);
		await Promise.all(connections.map((conn, i) => 
			conn.appChannel.write('data', messages[i])
		));

		// Verify each connection gets its own echo
		const echoes = await Promise.all(connections.map(async (conn) => {
			const echoMsg = await conn.appChannel.read({ only: 'data', decode: true });
			let echo;
			await echoMsg.process(() => {
				echo = echoMsg.text;
			});
			return echo;
		}));

		// Verify echoes match messages
		for (let i = 0; i < messages.length; i++) {
			assertEquals(echoes[i], messages[i], `Connection ${i} echo should match`);
		}

		// Close all connections
		await Promise.all(connections.map(conn => closePolyTransportWebSocket(conn)));
	} finally {
		await stopTestServer(operator);
	}
});
