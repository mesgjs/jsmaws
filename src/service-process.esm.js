/**
 * JSMAWS Service Process Base Class
 * Common functionality for all service processes (router, responder)
 *
 * This base class provides:
 * - PipeTransport setup and management (operator ↔ responder IPC)
 * - Control channel message loop (config-update, health-check, shutdown, scale-down)
 * - C2C channel for console output (replaces console-intercept SOH prefix hack)
 * - Configuration update handling
 * - Health check handling
 * - Shutdown handling with graceful cleanup
 *
 * Subclasses must implement:
 * - handleConfigUpdate(configJson) - Process configuration updates (JSON string)
 * - handleHealthCheck(msg) - Generate health check response
 * - handleShutdown(msg) - Perform graceful shutdown
 * - handleReqChannel(reqChannel) - Handle an accepted req-N channel
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PipeTransport } from '@poly-transport/transport/pipe.esm.js';
import { BufferPool } from '@poly-transport/buffer-pool.esm.js';
import { Configuration } from './configuration.esm.js';

/**
 * Control channel message types (operator ↔ responder)
 */
export const CONTROL_MESSAGE_TYPES = [
	'config-update',    // operator → responder: configuration update (JSON text)
	'health-check',     // operator → responder: health check request
	'health-response',  // responder → operator: health check response (JSON text)
	'shutdown',         // operator → responder: graceful shutdown request
	'scale-down',       // operator → responder: reduce in-flight requests
	'capacity-update',  // responder → operator: capacity report (JSON text)
];

/**
 * Base class for service processes
 */
export class ServiceProcess {
	constructor (processType, processId) {
		this.processType = processType;
		this.processId = processId || Deno.env.get('JSMAWS_PID') || `${processType}-${Date.now()}`;
		this.config = null; // Configuration instance (set during initialization)
		this.transport = null; // PipeTransport instance
		this.controlChannel = null; // 'control' channel on the transport
		this.isShuttingDown = false;
		this._c2cSymbol = null; // Set in createTransport()
		this._bufferPool = null; // Shared buffer pool for all transports in this process
	}

	/**
	 * Create PipeTransport using stdin/stdout.
	 * Registers the newChannel listener to accept 'control' and 'req-N' channels.
	 */
	createTransport () {
		const c2cSymbol = Symbol('c2c');
		this._c2cSymbol = c2cSymbol;

		// Create shared buffer pool for this process
		this._bufferPool = new BufferPool({
			sizeClasses: [1024, 4096, 16384, 65536],
			lowWaterMark: 2,
			highWaterMark: 10,
		});

		this.transport = new PipeTransport({
			readable: Deno.stdin.readable,
			writable: Deno.stdout.writable,
			c2cSymbol,
			bufferPool: this._bufferPool,
		});

		// Accept control channel and all req-N channels; reject everything else.
		// For req-N channels, queue a microtask to retrieve the channel and call
		// handleReqChannel() — the channel object doesn't exist yet at event time.
		this.transport.addEventListener('newChannel', (event) => {
			const { channelName } = event.detail;
			if (channelName === 'control') {
				event.accept();
			} else if (channelName.startsWith('req-')) {
				event.accept().
				then((channel) => this.handleReqChannel(channel)).
				catch((err) => {
					console.error(`[${this.processId}] Error handling ${channelName}:`, err);
				});
			} else {
				event.reject();
			}
		});
	}

	/**
	 * Handle configuration update from operator.
	 * Called after this.config has been updated by the base class.
	 * Subclasses must implement this method.
	 */
	async handleConfigUpdate () {
		throw new Error('Subclass must implement handleConfigUpdate()');
	}

	/**
	 * Handle health check from operator.
	 * Subclasses must implement this method.
	 * @param {object} msg - PolyTransport message
	 */
	async handleHealthCheck (msg) {
		throw new Error('Subclass must implement handleHealthCheck()');
	}

	/**
	 * Handle an accepted req-N channel.
	 * Subclasses must implement this method.
	 * @param {object} reqChannel - PolyTransport channel
	 */
	async handleReqChannel (reqChannel) {
		throw new Error('Subclass must implement handleReqChannel()');
	}

	/**
	 * Handle scale-down request from operator.
	 * Default: no-op (subclasses can override).
	 * @param {object} msg - PolyTransport message
	 */
	async handleScaleDown (msg) {
		console.debug(`[${this.processId}] Scale-down received (no-op in base class)`);
	}

	/**
	 * Handle shutdown request from operator.
	 * Subclasses must implement this method.
	 * @param {object} msg - PolyTransport message (may be null for signal-triggered shutdown)
	 */
	async handleShutdown (msg) {
		throw new Error('Subclass must implement handleShutdown()');
	}

	/**
	 * Intercept console methods to write to the C2C channel.
	 * Called after transport.start() so the C2C channel is available.
	 * This replaces the old console-intercept SOH prefix hack.
	 *
	 * Falls back to stderr when the C2C channel is not open (e.g. transport
	 * disconnected, or when running at a terminal for debugging).
	 */
	#interceptConsoleToC2C () {
		const c2c = this.transport.getChannel(this._c2cSymbol);
		if (!c2c) return; // Should not happen, but guard defensively

		// Map console method names to C2C level names
		// console.log → 'info' (C2C has no 'log' level)
		const levelMap = {
			debug: 'debug',
			info: 'info',
			log: 'info',
			warn: 'warn',
			error: 'error',
		};

		const enc = new TextEncoder();

		function consoleFormat (value) {
			return (typeof value === 'string') ? value : Deno.inspect(value, { depth: 4, colors: false });
		}

		function createLogMethod (level) {
			const c2cLevel = levelMap[level] ?? 'info';
			return function (...args) {
				// Use C2C when the channel is open; fall back to stderr otherwise
				// (handles transport disconnect and terminal debugging scenarios)
				if (c2c.state === c2c.STATE_OPEN) {
					const text = args.map(consoleFormat).join(' ');
					c2c[c2cLevel]?.(text);
				} else {
					// Fallback: write to stderr so output is not lost
					const text = args.map(consoleFormat).join(' ');
					Deno.stderr.writeSync(enc.encode(`[${level.toUpperCase()}] ${text}\n`));
				}
			};
		}

		for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
			console[method] = createLogMethod(method);
		}
	}

	/**
	 * Hook for subclass-specific initialization after config is loaded.
	 * Subclasses can override to perform additional setup.
	 */
	async onStarted () {
		// Default: no additional initialization
	}

	/**
	 * Process incoming control channel messages.
	 * Handles config-update, health-check, shutdown, scale-down.
	 * Runs as a background task (fire and forget from start()).
	 */
	#processControlMessages () {
		(async () => {
			while (true) {
				const msg = await this.controlChannel.read({
					only: ['config-update', 'health-check', 'shutdown', 'scale-down'],
					decode: true,
				});
				if (!msg) break; // Channel closed

				await msg.process(async () => {
					try {
						switch (msg.messageType) {
						case 'config-update':
									this.config.updateConfig(JSON.parse(msg.text));
									await this.handleConfigUpdate();
									break;
						case 'health-check':
							await this.handleHealthCheck(msg);
							break;
						case 'shutdown':
							await this.handleShutdown(msg);
							break;
						case 'scale-down':
							await this.handleScaleDown(msg);
							break;
						}
					} catch (error) {
						console.error(`[${this.processId}] Control message handler error (${msg.messageType}):`, error);
					}
				});
			}
			console.info(`[${this.processId}] Control channel closed`);
		})();
	}

	/**
	 * Create and run a service process with signal handlers.
	 * Static factory method for consistent process creation.
	 */
	static async run (ProcessClass, ...args) {
		const process = new ProcessClass(...args);

		// Ignore direct SIGINT and wait for an operator shutdown message
		Deno.addSignalListener('SIGINT', () => {});
		Deno.addSignalListener('SIGTERM', async () => {
			await process.handleShutdown(null);
		});

		// Start the process
		await process.start();
	}

	/**
	 * Send capacity update to operator via control channel.
	 * @param {number} availableWorkers
	 * @param {number} totalWorkers
	 */
	async sendCapacityUpdate (availableWorkers, totalWorkers) {
		if (!this.controlChannel) return;
		try {
			await this.controlChannel.write('capacity-update', JSON.stringify({
				availableWorkers,
				totalWorkers,
			}));
		} catch (err) {
			console.warn(`[${this.processId}] Failed to send capacity-update:`, err);
		}
	}

	/**
	 * Start the service process.
	 * Template method that orchestrates the startup sequence.
	 */
	async start () {
		// Log to stderr before transport is ready (will not be forwarded to operator)
		Deno.stderr.writeSync(new TextEncoder().encode(
			`[${this.processId}] Starting ${this.processType} process...\n`
		));

		// Create PipeTransport
		this.createTransport();

		// Start transport
		await this.transport.start();

		// Intercept console methods to write to C2C channel
		// (replaces the old console-intercept SOH prefix hack)
		this.#interceptConsoleToC2C();

		// Request the control channel (operator initiates, responder accepts)
		// The operator will have already requested the control channel; we accept it here.
		// Since the transport listener accepts 'control', we need to get the channel.
		// On the responder side, we wait for the operator to open the control channel.
		this.controlChannel = await this.transport.requestChannel('control');
		await this.controlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES);

		// Wait for initial configuration
		await this.waitForInitialConfig();

		// Let subclass perform additional initialization
		await this.onStarted();

		console.debug(`[${this.processId}] ${this.processType} process started successfully`);

		// Start control channel message loop (background)
		this.#processControlMessages();

		// Keep process alive until transport stops
		await new Promise((resolve) => {
			this.transport.addEventListener('stopped', resolve);
		});

		console.info(`[${this.processId}] Transport stopped, process exiting`);

		// Stop buffer pool
		if (this._bufferPool) {
			this._bufferPool.stop();
		}
	}

	/**
	 * Wait for and process initial configuration via the control channel.
	 * The operator sends a 'config-update' as the first message after transport start.
	 * Sets this.config and then calls handleConfigUpdate() with no arguments.
	 */
	async waitForInitialConfig () {
		console.debug(`[${this.processId}] Waiting for initial configuration...`);

		// Read the first message from the control channel — must be 'config-update'
		const msg = await this.controlChannel.read({ only: 'config-update', decode: true });
		if (!msg) {
			throw new Error('Control channel closed before initial configuration was received');
		}

		let configData;
		await msg.process(() => {
			configData = JSON.parse(msg.text);
		});

		// Parse and create Configuration instance
		this.config = new Configuration(configData);
		this.config.processType = this.processType;
		this.config.processId = this.processId;

		// Let subclass react to the configuration (this.config is already set)
		await this.handleConfigUpdate();
	}
}
