/**
 * JSMAWS Console Interception
 * Intercepts console methods to prefix with log level for IPC protocol
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { encodeLogLevel } from './ipc-protocol.esm.js';

// Store original console methods
const originalConsole = {
	debug: console.debug,
	info: console.info,
	log: console.log,
	warn: console.warn,
	error: console.error,
};

/**
 * Intercept console methods to prefix with log level
 * This allows the parent process to distinguish console output from IPC messages
 */
export function interceptConsole () {
	// Stdout methods (debug, info, log)
	console.debug = (...args) => {
		Deno.stdout.writeSync(encodeLogLevel('debug'));
		originalConsole.debug(...args);
	};

	console.info = (...args) => {
		Deno.stdout.writeSync(encodeLogLevel('info'));
		originalConsole.info(...args);
	};

	console.log = (...args) => {
		Deno.stdout.writeSync(encodeLogLevel('log'));
		originalConsole.log(...args);
	};

	// Stderr methods (warn, error)
	console.warn = (...args) => {
		Deno.stderr.writeSync(encodeLogLevel('warn'));
		originalConsole.warn(...args);
	};

	console.error = (...args) => {
		Deno.stderr.writeSync(encodeLogLevel('error'));
		originalConsole.error(...args);
	};
}

/**
 * Restore original console methods
 */
export function restoreConsole () {
	console.debug = originalConsole.debug;
	console.info = originalConsole.info;
	console.log = originalConsole.log;
	console.warn = originalConsole.warn;
	console.error = originalConsole.error;
}
