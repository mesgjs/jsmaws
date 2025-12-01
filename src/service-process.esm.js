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
		console.log(`[${this.processId}] IPC connection established`);
	}

	/**
	 * Wait for and process initial configuration
	 */
	async waitForInitialConfig () {
		console.log(`[${this.processId}] Waiting for initial configuration...`);
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
	 * Process incoming IPC messages
	 */
	async processMessages () {
		const handlers = this.getMessageHandlers();

		console.log(`[${this.processId}] Starting message processing loop...`);
		while (!this.isShuttingDown) {
			try {
				console.log(`[${this.processId}] Waiting for IPC message...`);
				const result = await this.ipcConn.readMessage();

				if (!result) {
					// Connection closed
					console.log(`[${this.processId}] IPC connection closed`);
					break;
				}

				const { message, binaryData } = result;
				console.log(`[${this.processId}] Received IPC message: type=${message.type}, id=${message.id}`);
				const handler = handlers.get(message.type);

				if (handler) {
					console.log(`[${this.processId}] Calling handler for ${message.type}...`);
					await handler(message.id, message.fields, binaryData);
					console.log(`[${this.processId}] Handler completed for ${message.type}`);
				} else {
					console.warn(`[${this.processId}] Unknown message type: ${message.type}`);
				}
			} catch (error) {
				if (this.isShuttingDown) {
					break;
				}
				console.error(`[${this.processId}] Message processing error:`, error);
			}
		}
		console.log(`[${this.processId}] Message processing loop ended`);
	}

	/**
	 * Start the service process
	 * Template method that orchestrates the startup sequence
	 */
	async start () {
		// Intercept console methods BEFORE any logging
		interceptConsole();
		
		console.log(`[${this.processId}] Starting ${this.processType} process...`);

		// Create IPC connection
		this.createIPCConnection();

		// Wait for initial configuration
		await this.waitForInitialConfig();

		// Let subclass perform additional initialization
		await this.onStarted();

		console.log(`[${this.processId}] ${this.processType} process started successfully`);

		// Process incoming messages
		await this.processMessages();
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

		Deno.addSignalListener('SIGINT', shutdownHandler);
		Deno.addSignalListener('SIGTERM', shutdownHandler);

		// Start the process
		await process.start();
	}
}
