/**
 * E2E Testing Utilities for JSMAWS
 * 
 * Provides utilities for end-to-end testing with actual server instances.
 */

import { OperatorProcess, ServerConfig, loadConfig } from '../src/operator.esm.js';
import { NANOS } from '../src/vendor.esm.js';

/**
 * Create a test server instance with custom configuration
 * @param {Object} configOverrides - Configuration overrides
 * @returns {Promise<{operator: OperatorProcess, config: ServerConfig, baseUrl: string}>}
 */
export async function createTestServer (configOverrides = {}) {
	// Create test configuration with safe defaults
	const testConfig = {
		noSSL: true,
		httpPort: 0, // Let OS assign port
		httpsPort: 0,
		hostname: 'localhost',
		logging: { level: /* 'debug' */ 'info' },
		...configOverrides
	};

	//console.log('[E2E-UTILS] Creating test server with config:', JSON.stringify(testConfig, null, 2));
	const configData = new NANOS().setOpts({ transform: true }).push(testConfig);
	const config = ServerConfig.fromNANOS(configData);
	//console.log('[E2E-UTILS] Config data pools:', configData.at('pools')?.toObject());

	// Create operator instance
	const operator = new OperatorProcess(config);
	operator.configData = configData;
	operator.initializeLogger();

	// Set global instance for IPC handlers
	globalThis.OperatorProcess = OperatorProcess;
	OperatorProcess.instance = operator;

	return { operator, config, configData };
}

/**
 * Start a test server and wait for it to be ready
 * @param {OperatorProcess} operator - Operator instance
 * @returns {Promise<string>} Base URL of the running server
 */
export async function startTestServer (operator) {
	// Start the server
	//console.log('[E2E-UTILS] Starting test server...');
	//console.log('[E2E-UTILS] Operator logger exists?', !!operator.logger);
	//console.log('[E2E-UTILS] Operator config:', operator.config);

	try {
		await operator.start();
		//console.log('[E2E-UTILS] Server started successfully');
	} catch (error) {
		console.error('[E2E-UTILS] FATAL: operator.start() threw error:', error);
		console.error('[E2E-UTILS] Stack:', error.stack);
		throw error;
	}

	//console.log('[E2E-UTILS] Pool managers:', Array.from(operator.poolManagers.keys()));

	// Get the actual port assigned by OS
	const addr = operator.httpServer?.addr;
	if (!addr || typeof addr === 'string') {
		throw new Error('Failed to get server address');
	}

	const port = addr.port;
	const baseUrl = `http://localhost:${port}`;
	console.log('[E2E-UTILS] Server listening on:', baseUrl);

	// Give server a moment to fully initialize
	await new Promise(resolve => setTimeout(resolve, 100));

	return baseUrl;
}

/**
 * Stop a test server and clean up resources
 * @param {OperatorProcess} operator - Operator instance
 */
export async function stopTestServer (operator) {
	// Shutdown operator (which shuts down pools internally)
	await operator.shutdown(5);

	// Give server a moment to fully shut down
	//await new Promise(resolve => setTimeout(resolve, 200));
}

/**
 * Make an HTTP request with timeout
 * @param {string} url - Request URL
 * @param {RequestInit} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout (url, options = {}, timeoutMs = 5000) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal
		});
		return response;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Wait for a condition to be true
 * @param {Function} condition - Condition function
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {number} intervalMs - Check interval in milliseconds
 * @returns {Promise<void>}
 */
export async function waitFor (condition, timeoutMs = 5000, intervalMs = 100) {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		if (await condition()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}

	throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

/**
 * Create a WebSocket connection with timeout
 * @param {string} url - WebSocket URL
 * @param {number} timeoutMs - Connection timeout in milliseconds
 * @returns {Promise<WebSocket>}
 */
export async function connectWebSocket (url, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const timeoutId = setTimeout(() => {
			ws.close();
			reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
		}, timeoutMs);

		ws.onopen = () => {
			clearTimeout(timeoutId);
			resolve(ws);
		};

		ws.onerror = (error) => {
			clearTimeout(timeoutId);
			reject(error);
		};
	});
}

/**
 * Read SSE events from a response stream
 * @param {Response} response - Fetch response
 * @param {number} maxEvents - Maximum number of events to read
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Array<{event: string, data: string}>>}
 */
export async function readSSEEvents (response, maxEvents = 10, timeoutMs = 5000) {
	const events = [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	const startTime = Date.now();

	try {
		while (events.length < maxEvents && Date.now() - startTime < timeoutMs) {
			const { done, value } = await reader.read();

			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || ''; // Keep incomplete line in buffer

			let currentEvent = { event: 'message', data: '' };

			for (const line of lines) {
				if (line.startsWith('event:')) {
					currentEvent.event = line.slice(6).trim();
				} else if (line.startsWith('data:')) {
					currentEvent.data += line.slice(5).trim();
				} else if (line === '') {
					// Empty line marks end of event
					if (currentEvent.data) {
						events.push({ ...currentEvent });
						currentEvent = { event: 'message', data: '' };
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	return events;
}

/**
 * Create a test configuration file
 * @param {string} path - File path
 * @param {Object} config - Configuration object
 */
export async function createTestConfig (path, config) {
	const nanos = new NANOS(config);
	const slid = nanos.toSLID();
	await Deno.writeTextFile(path, `[(${slid})]`);
}

/**
 * Clean up test files
 * @param {string[]} paths - File paths to remove
 */
export async function cleanupTestFiles (paths) {
	for (const path of paths) {
		try {
			await Deno.remove(path);
		} catch {
			// Ignore errors if file doesn't exist
		}
	}
}
