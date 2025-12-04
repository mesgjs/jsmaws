/**
 * JSMAWS Service Process Base Class
 * Common functionality for all service processes (router, responder)
 * 
 * This base class provides:
 * - IPC connection setup and management
 * - Configuration update handling
 * - Health check handling
 * - Shutdown handling with graceful cleanup
 * - Message processing loop
 * - Signal handler registration
 * 
 * Subclasses must implement:
 * - handleConfigUpdate(fields) - Process configuration updates
 * - handleHealthCheck(id, fields) - Generate health check response
 * - handleShutdown(fields) - Perform graceful shutdown
 * - getMessageHandlers() - Return map of message type to handler function
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';
import { IPCConnection, MessageType } from './ipc-protocol.esm.js';
import { Configuration } from './configuration.esm.js';
import { interceptConsole } from './console-intercept.esm.js';

/**
 * Base class for service processes
 */
export class ServiceProcess {
	constructor (processType, processId) {
		this.processType = processType;
		this.processId = processId || Deno.env.get('JSMAWS_PID') || `${processType}-${Date.now()}`;
		this.config = null; // Configuration instance (set during initialization)
		this.ipcConn = null;
		this.isShuttingDown = false;
		// Create simple console-based logger for components that need it
		// Console output is forwarded to operator's logger via IPC
		this.logger = {
			debug: (msg) => console.debug(msg),
			info: (msg) => console.info(msg),
			warn: (msg) => console.warn(msg),
			error: (msg) => console.error(msg),
		};
	}

	/**
	 * Create IPC connection using stdin/stdout
	 */
	createIPCConnection () {
		const stdinReader = Deno.stdin.readable.getReader();
		this.ipcConn = new IPCConnection({
			read: () => stdinReader.read(),
			write: (data) => Deno.stdout.write(data),
			close: () => {
				Deno.stdin.close();
				Deno.stdout.close();
			},
		});
		console.debug(`[${this.processId}] IPC connection established`);
	}

	/**
	 * Wait for and process initial configuration
	 */
	async waitForInitialConfig () {
		console.debug(`[${this.processId}] Waiting for initial configuration...`);
		const result = await this.ipcConn.readMessage();

		if (!result || result.message.type !== MessageType.CONFIG_UPDATE) {
			throw new Error('Expected initial configuration message');
		}

		// Create Configuration instance
		this.config = new Configuration(result.message.fields);
		this.config.processType = this.processType;
		this.config.processId = this.processId;

		// Let subclass handle the configuration
		await this.handleConfigUpdate(result.message.fields);
	}

	/**
	 * Get message handlers map
	 * Subclasses should override to add custom handlers
	 * Returns: Map<MessageType, handler(id, fields, binaryData)>
	 */
	getMessageHandlers () {
		return new Map([
			[MessageType.CONFIG_UPDATE, async (id, fields) => {
				await this.handleConfigUpdate(fields);
			}],
			[MessageType.HEALTH_CHECK, async (id, fields) => {
				await this.handleHealthCheck(id, fields);
			}],
			[MessageType.SHUTDOWN, async (id, fields) => {
				await this.handleShutdown(fields);
			}],
		]);
	}

	/**
	 * Setup event-driven message handlers
	 */
	setupMessageHandlers () {
		const handlers = this.getMessageHandlers();

		console.debug(`[${this.processId}] Setting up event-driven message handlers...`);

		// Register each handler with the IPC connection
		for (const [messageType, handler] of handlers) {
			this.ipcConn.onMessage(messageType, async (message, binaryData) => {
				try {
					console.debug(`[${this.processId}] Handling ${messageType} message (id: ${message.id})`);
					await handler(message.id, message.fields, binaryData);
					console.debug(`[${this.processId}] Handler completed for ${messageType}`);
				} catch (error) {
					console.error(`[${this.processId}] Handler error for ${messageType}:`, error);
				}
			});
		}
	}

	/**
	 * Start the service process
	 * Template method that orchestrates the startup sequence
	 */
	async start () {
		// Intercept console methods BEFORE any logging
		interceptConsole();

		console.info(`[${this.processId}] Starting ${this.processType} process...`);

		// Create IPC connection
		this.createIPCConnection();

		// Wait for initial configuration
		await this.waitForInitialConfig();

		// Setup event-driven message handlers
		this.setupMessageHandlers();

		// Let subclass perform additional initialization
		await this.onStarted();

		console.debug(`[${this.processId}] ${this.processType} process started successfully`);

		// Start monitoring for incoming messages (blocks until connection closes)
		await this.ipcConn.startMonitoring();

		console.info(`[${this.processId}] IPC monitoring ended, process exiting`);
	}

	/**
	 * Hook for subclass-specific initialization after config is loaded
	 * Subclasses can override to perform additional setup
	 */
	async onStarted () {
		// Default: no additional initialization
	}

	/**
	 * Handle configuration update from operator
	 * Subclasses must implement this method
	 */
	async handleConfigUpdate (fields) {
		throw new Error('Subclass must implement handleConfigUpdate()');
	}

	/**
	 * Handle health check from operator
	 * Subclasses must implement this method
	 */
	async handleHealthCheck (id, fields) {
		throw new Error('Subclass must implement handleHealthCheck()');
	}

	/**
	 * Handle shutdown request from operator
	 * Subclasses must implement this method
	 */
	async handleShutdown (fields) {
		throw new Error('Subclass must implement handleShutdown()');
	}

	/**
	 * Create and run a service process with signal handlers
	 * Static factory method for consistent process creation
	 */
	static async run (ProcessClass, ...args) {
		const process = new ProcessClass(...args);

		// Handle shutdown signals
		const shutdownHandler = async () => {
			await process.handleShutdown(new NANOS());
		};

		// Ignore direct SIGINT and wait for an operator shutdown message
		Deno.addSignalListener('SIGINT', () => {});
		Deno.addSignalListener('SIGTERM', shutdownHandler);

		// Start the process
		await process.start();
	}
}
