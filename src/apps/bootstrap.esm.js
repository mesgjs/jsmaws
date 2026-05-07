/**
 * JSMAWS Mod-App Bootstrap Module
 * Environment lockdown and controlled initialization for mod-app workers.
 *
 * This module:
 * - Establishes a PostMessageTransport with the responder process
 * - Locks down the worker environment before mod-app code executes
 * - Filters Deno namespace to approved APIs
 * - Captures console output and forwards via the C2C channel
 * - Prevents mod-apps from forging IPC messages
 * - Reads setup instructions from the private 'bootstrap' channel
 * - Exposes globalThis.JSMAWS (frozen namespace) to the mod-app:
 *     .server — the main PolyTransport channel (mod-app ↔ JSMAWS server)
 *     .bidi   — the NestedTransport relay channel (bidi requests only)
 * - Dynamically imports the mod-app after environment is secured
 *
 * Security Model:
 * - Console output captured via C2C channel (prevents stdout IPC forgery)
 * - Namespaces frozen to prevent tampering
 * - Approved Deno APIs only (no file system write, no process control)
 * - Worker permissions still enforced by Deno
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PostMessageTransport } from '@poly-transport/transport/post-message.esm.js';
import { BufferPool } from '@poly-transport/buffer-pool.esm.js';
import { PromiseTracer } from '@poly-transport/promise-tracer.esm.js';
import { Channel } from '@poly-transport/channel.esm.js';

/**
 * Approved Deno APIs
 * These are the only Deno APIs mod-apps can access
 */
const APPROVED_DENO_APIS = [
	// Info
	'build',
	'version',
	// System
	'cpuUsage',
	'loadavg',
	'memoryUsage',
	'hostname',
	'osRelease',
	'osUptime',
	// Errors namespace (entire namespace)
	'errors',
	// Utilities
	'inspect',
	// Network
	'connect',
	'connectTls',
	'listen',
	'listenTls',
	'serve',
	'serveHttp',
	'startTls',
	// HTTP
	'createHttpClient',
	'HttpClient',
	// DNS
	'resolveDns',
];

/**
 * Disable web workers inside mod-app workers
 */
function disableWorkers () {
	const disabledWorker = Object.freeze(class Worker {
		constructor () {
			throw new Error('Web workers are disabled');
		}
	});
	Object.defineProperty(globalThis, 'Worker', {
		value: disabledWorker,
		writable: false,
		configurable: false,
		enumerable: true,
	});
}

/**
 * Create filtered Deno namespace with approved APIs
 */
function setupDeno () {
	const customDeno = {};

	// Copy approved APIs from original Deno
	for (const api of APPROVED_DENO_APIS) {
		if (api in Deno) {
			customDeno[api] = Deno[api];
		}
	}

	// Freeze Deno.errors if it exists
	if (customDeno.errors) {
		Object.freeze(customDeno.errors);
	}

	// Replace global Deno and freeze
	Object.defineProperty(globalThis, 'Deno', {
		value: Object.freeze(customDeno),
		writable: false,
		configurable: false,
		enumerable: true,
	});
}

/**
 * Set up console interception via the C2C channel.
 * Replaces globalThis.console with a frozen filtered version that:
 * - Writes to the C2C channel when it is open (normal operation)
 * - Falls back to the original console methods when the C2C channel is not open
 *   (e.g. transport disconnected, or when running at a terminal for debugging)
 *
 * @param {object} c2c - The C2C channel from the PostMessageTransport (already open)
 */
function setupConsole (c2c) {
	// Map console levels to C2C levels (console.log → info)
	const levelMap = {
		debug: 'debug',
		error: 'error',
		info: 'info',
		log: 'info',
		warn: 'warn',
	};

	// Save original console methods before replacing (for fallback)
	const originalConsole = {};
	for (const level of ['debug', 'error', 'info', 'log', 'warn']) {
		originalConsole[level] = globalThis.console[level]?.bind(globalThis.console);
	}

	/**
	 * Format a value for console output
	 */
	function consoleFormat (value) {
		return (typeof value === 'string') ? value : Deno.inspect(value, { depth: 4, colors: false });
	}

	/**
	 * Create a log method that writes to C2C when open, or falls back to original
	 */
	function createLogMethod (level) {
		const c2cLevel = levelMap[level] ?? 'info';
		return function (...args) {
			// Use C2C when the channel is open; fall back to original console otherwise
			// (handles transport disconnect and terminal debugging scenarios)
			if (c2c.state === Channel.STATE_OPEN) {
				const text = args.map(consoleFormat).join(' ');
				c2c[c2cLevel]?.(text);
			} else {
				originalConsole[level]?.(...args);
			}
		};
	}

	const customConsole = {};

	// Create log methods
	for (const level of ['debug', 'error', 'info', 'log', 'warn']) {
		customConsole[level] = createLogMethod(level);
	}

	// assert: log error if condition fails
	customConsole.assert = function (cond, ...args) {
		if (!cond) {
			customConsole.error('Assertion failed', ...args);
		}
	};

	// dir, dirxml, table: approximate with log
	customConsole.dir = function (obj, opts = {}) {
		return customConsole.log(Deno.inspect(obj, { depth: 4, colors: false, ...opts }));
	};
	customConsole.dirxml = function (obj) { return customConsole.log(obj); };
	customConsole.table = function (obj) { return customConsole.log(obj); };

	// Replace global console and freeze
	Object.defineProperty(globalThis, 'console', {
		value: Object.freeze(customConsole),
		writable: false,
		configurable: false,
		enumerable: true,
	});
}

/**
 * Main bootstrap entry point.
 * Establishes PostMessageTransport, reads setup from the private 'bootstrap' channel,
 * locks down the environment, exposes globalThis.JSMAWS, and imports the mod-app.
 */
async function bootstrap () {
	// Create buffer pool for this mod-app worker
	const bufferPool = new BufferPool({
		sizeClasses: [1024, 4096, 16384, 65536],
		lowWaterMark: 2,
		highWaterMark: 10,
	});

	// Create PostMessageTransport with C2C channel for console output
	const c2cSymbol = Symbol('c2c');
	const promiseTracer = new PromiseTracer(5000, { logRejections: true });
	const transport = new PostMessageTransport({
		gateway: self,
		c2cSymbol,
		promiseTracer,
		bufferPool,
	});

	// Accept all channels (responder initiates)
	transport.addEventListener('newChannel', (event) => {
		event.accept();
	});

	await transport.start();

	// Get the C2C channel and set up console interception immediately
	// (before any mod-app code runs, so all console output goes through C2C)
	const c2c = transport.getChannel(c2cSymbol);
	if (c2c) setupConsole(c2c);

	// Read setup instructions from the private 'bootstrap' channel
	const bootstrapChannel = await transport.requestChannel('bootstrap');
	await bootstrapChannel.addMessageTypes(['setup']);
	const setupMsg = await bootstrapChannel.read({ only: 'setup', decode: true });
	let setupData;
	await setupMsg.process(() => {
		setupData = JSON.parse(setupMsg.text);
	});

	const { appPath, mode, keepDeno = false, keepWorkers = false } = setupData;

	// Lock down the environment before importing the mod-app
	if (!keepDeno) {
		setupDeno();
	}
	if (!keepWorkers) {
		disableWorkers();
	}

	// Set up the JSMAWS communication channel (mod-app ↔ server)
	const appChannel = await transport.requestChannel('app');
	await appChannel.addMessageTypes(['req', 'res', 'res-frame', 'res-error', 'bidi-frame']);

	// Build the JSMAWS namespace object (frozen before mod-app import)
	const jsmawsNamespace = { server: appChannel };

	// Expose frozen namespace to mod-app
	globalThis.JSMAWS = Object.freeze(jsmawsNamespace);

	// Dynamically import and run the mod-app
	try {
		const appModule = await import(appPath);
		// Call the default export if it is a function (standard mod-app entry point)
		if (typeof appModule.default === 'function') {
			await appModule.default(setupData);
		}
	} catch (error) {
		// Report error via console (which now goes through C2C)
		console.error('Mod-app error:', error.message);
		if (error.stack) console.error(error.stack);
		// Also write a res-error so the responder can return a 500 to the client
		try {
			await appChannel.write('res-error', JSON.stringify({
				error: error.message,
				stack: error.stack,
			}));
		} catch (_writeError) {
			// Ignore write errors during error reporting
		}
	}

	// Stop transport and close worker
	await transport.stop();

	// Stop buffer pool (worker is exiting)
	bufferPool.stop();

	self.close();
}

// Rethrow any fatal bootstrap errors as uncaught exceptions.
// The responder will see these as worker errors (independent of transport state)
// and log them on the req-N channel as a con-error.
bootstrap().catch((err) => { throw err; });
