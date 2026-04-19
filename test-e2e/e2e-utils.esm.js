/**
 * E2E Testing Utilities for JSMAWS
 *
 * Provides utilities for end-to-end testing with actual server instances.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { OperatorProcess, ServerConfig } from '../src/operator.esm.js';
import { Configuration } from '../src/configuration.esm.js';

/**
 * Create a test server instance with custom configuration
 * @param {Object} configOverrides - Configuration overrides (plain JS object)
 * @returns {Promise<{operator: OperatorProcess, configuration: Configuration}>}
 */
export async function createTestServer (configOverrides = {}) {
	// Create test configuration with safe defaults (plain JS object)
	const testConfig = {
		noSSL: true,
		httpPort: 0, // Let OS assign port
		httpsPort: 0,
		hostname: 'localhost',
		logLevel: 'debug',
		...configOverrides
	};

	// ServerConfig handles network/SSL settings
	const config = new ServerConfig(testConfig);

	// Configuration handles routing/pools/applet settings
	const configuration = new Configuration(testConfig);

	// Create operator instance
	const operator = new OperatorProcess(config);
	operator.configuration = configuration;
	operator.initializeLogger();

	// Set global instance for IPC handlers
	globalThis.OperatorProcess = OperatorProcess;
	OperatorProcess.instance = operator;

	return { operator, configuration };
}

/**
 * Start a test server and wait for it to be ready
 * @param {OperatorProcess} operator - Operator instance
 * @returns {Promise<string>} Base URL of the running server
 */
export async function startTestServer (operator) {
	try {
		await operator.start();
	} catch (error) {
		console.error('[E2E-UTILS] FATAL: operator.start() threw error:', error);
		console.error('[E2E-UTILS] Stack:', error.stack);
		throw error;
	}

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
		ws.binaryType = 'arraybuffer'; // Set binary type for consistent handling

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
		// Cancel the response body stream to avoid resource leaks
		await response.body.cancel();
	}

	return events;
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
