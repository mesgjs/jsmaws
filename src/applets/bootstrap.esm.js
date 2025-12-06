/**
 * JSMAWS Applet Bootstrap Module
 * Environment lockdown and controlled initialization for applet workers
 *
 * This module:
 * - Locks down the worker environment before applet code executes
 * - Filters console methods to approved subset
 * - Filters Deno namespace to approved APIs
 * - Captures console output and forwards via postMessage
 * - Prevents applets from forging IPC messages
 * - Dynamically imports applet after environment is secured
 *
 * Security Model:
 * - Console output captured via postMessage (prevents stdout IPC forgery)
 * - Namespaces frozen to prevent tampering
 * - Approved APIs only (no file system, no process control)
 * - Worker permissions still enforced by Deno
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

// Wrap everything in IIFE for zero applet footprint
(function () {
	'use strict';

	/**
	 * Approved console methods
	 * These are the only console methods applets can use
	 */
	const _APPROVED_CONSOLE_METHODS = [
		'assert',
		'debug',
		'dir',
		'dirxml',
		'error',
		'info',
		'log',
		'table',
		'warn',
	];

	/**
	 * Approved Deno APIs
	 * These are the only Deno APIs applets can access
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
	 * Return a value formatted the way it would be for console.<level> output
	 * @param {*} value 
	 * @param {*} options 
	 * @returns 
	 */
	function consoleFormat (value, options = {}) {
		return (typeof value === 'string') ? value : Deno.inspect(value, { depth: 4, colors: false, ...options });
	}

	/**
	 * Create a log method that sends output via postMessage
	 */
	function createLogMethod (level) {
		return function (...args) {
			// Use Deno.inspect to format non-string arguments
			const content = args.map(a => consoleFormat(a)).join(' ');

			// Send to responder via postMessage
			self.postMessage({
				type: 'console',
				level,
				content,
			});
		};
	}

	/**
	 * Create filtered console with approved methods
	 * Each method captures output and sends via postMessage
	 */
	function setupConsole () {
		const customConsole = {};

		// Create log methods that send via postMessage
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
		customConsole.dir = function (obj, opts = {}) { return customConsole.log(consoleFormat(obj, opts)); };
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
	 * Register one-time listener for bootstrap message
	 * This message contains the applet path to load
	 */
	function registerBootstrapListener () {
		let appletLoaded = false;

		const handleBootstrap = async function (event) {
			const { type, appletPath } = event.data;

			// Only handle bootstrap message once
			if (type !== 'bootstrap' || appletLoaded) {
				return;
			}

			appletLoaded = true;

			// Remove this listener (one-time only)
			self.removeEventListener('message', handleBootstrap);

			try {
				// Dynamically import the applet
				await import(appletPath);
				// Applet will register its own message listeners
			} catch (error) {
				// Send error back to responder
				console.error(error);
				self.postMessage({
					type: 'error',
					error: error.message,
					stack: error.stack,
				});
			}
		};

		self.addEventListener('message', handleBootstrap);
	}

	// Initialize bootstrap immediately
	setupConsole();
	setupDeno();
	registerBootstrapListener();
})();
