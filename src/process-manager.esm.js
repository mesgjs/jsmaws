/**
 * JSMAWS Process Manager
 * Factory for creating and managing service processes (responders and routers)
 *
 * Responsibilities:
 * - Create service processes with privilege dropping (factory for PoolManager)
 * - Monitor process health and lifecycle
 * - Manage PipeTransport connections and C2C console output
 * - Manage RequestChannelPool per process
 * - Shutdown processes gracefully
 *
 * Note: Pool management (scaling, recycling, capacity) is handled by PoolManager.
 * This class is a pure factory that creates and monitors process instances.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { PipeTransport } from '@poly-transport/transport/pipe.esm.js';
import { RequestChannelPool } from './request-channel-pool.esm.js';
import { CONTROL_MESSAGE_TYPES } from './service-process.esm.js';

/**
 * Service process types
 */
export const ProcessType = {
	RESPONDER: 'responder',
	ROUTER: 'router',
};

/**
 * Process state
 */
export const ProcessState = {
	STARTING: 'starting',
	READY: 'ready',
	BUSY: 'busy',
	STOPPING: 'stopping',
	DEAD: 'dead',
};

/**
 * C2C level map: C2C channel message type → logger level
 */
const C2C_LEVEL_MAP = {
	trace: 'debug',
	debug: 'debug',
	info: 'info',
	warn: 'warn',
	error: 'error',
};

/**
 * Managed service process.
 * Holds all state for a single spawned service process.
 */
class ManagedProcess {
	/**
	 * @param {object} opts
	 * @param {string} opts.id - Process ID
	 * @param {string} opts.type - Process type (responder or router)
	 * @param {string} opts.poolName - Pool name
	 * @param {object} opts.process - Deno child process handle
	 * @param {object} opts.transport - PipeTransport instance
	 * @param {object} opts.controlChannel - 'control' channel on the transport
	 * @param {object} opts.reqChannelPool - RequestChannelPool instance
	 * @param {object} opts.processManager - Parent ProcessManager
	 */
	constructor ({ id, type, poolName, process, transport, controlChannel, reqChannelPool, processManager }) {
		this.id = id;
		this.type = type;
		this.poolName = poolName;
		this.process = process;
		this.transport = transport;
		this.controlChannel = controlChannel;
		this.reqChannelPool = reqChannelPool;
		this.state = ProcessState.STARTING;
		this.startTime = Date.now();
		this.requestCount = 0;
		this.lastHealthCheck = null;
		this.availableWorkers = 0;
		this.totalWorkers = 0;
		this.affinity = new Set(); // Applet paths this process has loaded
		this.processManager = processManager;
		this._shutdownCallbacks = [];
	}

	/**
	 * Add applet to affinity set
	 */
	addAffinity (appletPath) {
		this.affinity.add(appletPath);
	}

	/**
	 * Get process uptime in seconds
	 */
	getUptime () {
		return Math.floor((Date.now() - this.startTime) / 1000);
	}

	/**
	 * Check if process has affinity for applet
	 */
	hasAffinity (appletPath) {
		return this.affinity.has(appletPath);
	}

	/**
	 * Check if process has capacity
	 */
	hasCapacity () {
		return this.state === ProcessState.READY && this.availableWorkers > 0;
	}

	/**
	 * Register a callback to be called when this process shuts down
	 */
	onShutdown (callback) {
		this._shutdownCallbacks.push(callback);
	}

	/**
	 * Shutdown (typically for recycling, so default is fast)
	 */
	shutdown (timeout = 5) {
		this.processManager.shutdownProcess(this, timeout);
	}

	/**
	 * Update worker capacity from capacity-update message
	 */
	updateCapacity (availableWorkers, totalWorkers) {
		this.availableWorkers = availableWorkers;
		this.totalWorkers = totalWorkers;

		// READY: Has available workers (can accept requests)
		// BUSY: No available workers (at capacity)
		if (availableWorkers > 0) {
			this.state = ProcessState.READY;
		} else {
			this.state = ProcessState.BUSY;
		}
	}
}

/**
 * Process Manager
 * Manages all service processes (responders and routers)
 */
export class ProcessManager {
	constructor (config, logger) {
		this.config = config;
		this.logger = logger;
		this.processes = new Map(); // processId -> ManagedProcess
		this.nextProcessId = 1;
		this.isShuttingDown = false;
	}

	/**
	 * Send configuration update to all tracked processes
	 */
	async broadcastConfigUpdate () {
		for (const [processId, proc] of this.processes) {
			if (proc.state === ProcessState.DEAD) continue;
			try {
				await this.#sendConfigUpdate(proc.controlChannel);
				this.logger.debug(`Config update sent to ${processId}`);
			} catch (error) {
				this.logger.error(`Failed to send config update to ${processId}: ${error.message}`);
			}
		}
	}

	/**
	 * Create a new service process (factory method for PoolManager)
	 * @param {string} processId Process ID (provided by PoolManager)
	 * @param {string} type Process type (responder or router)
	 * @param {string} poolName Pool name
	 * @param {Object} poolConfig Pool configuration
	 * @returns {Promise<{item: ManagedProcess, isWorker: false}>}
	 */
	async createProcess (processId, type, poolName, poolConfig) {
		this.logger.info(`Creating ${type} process: ${processId}`);

		// Determine script path
		const scriptPath = type === ProcessType.RESPONDER
			? 'src/responder-process.esm.js'
			: 'src/router-process.esm.js';

		// Get UID/GID from global config (not pool-specific)
		const uid = Number(this.config.at('uid'));
		const gid = Number(this.config.at('gid'));

		// Only validate if we're running as root (validation already done in operator)
		// This is a safety check in case process manager is used standalone
		if (Deno.uid() === 0 && (!uid || !gid)) {
			throw new Error(`uid and gid must be configured when running as root`);
		}

		// Spawn process with privilege dropping
		const command = new Deno.Command('deno', {
			args: [
				'run',
				'--allow-read',
				'--allow-write',
				'--allow-net',
				'--allow-env',
				'--unstable-worker-options',
				scriptPath,
			],
			...(uid && gid && { uid, gid }),
			stdin: 'piped',
			stdout: 'piped',
			// stderr is inherited (not piped): service process console output goes via C2C
			// channel on the PipeTransport. Any pre-transport stderr output (e.g. fatal
			// startup errors before C2C is established) flows to the operator's own stderr.
			env: {
				JSMAWS_PID: processId,
				JSMAWS_POOL: poolName,
			},
		});

		const child = command.spawn();

		// Get chunking config for transport
		const chunkingConfig = this.config.at('chunking');
		const maxChunkBytes = chunkingConfig?.at?.('maxChunkSize') ?? 65536;

		// Create PipeTransport for operator ↔ responder IPC
		const c2cSymbol = Symbol('c2c');
		const transport = new PipeTransport({
			readable: child.stdout,
			writable: child.stdin,
			c2cSymbol,
			logger: this.logger,
			maxChunkBytes,
		});

		// Accept all channels (operator initiates)
		transport.addEventListener('newChannel', (event) => {
			event.accept();
		});

		await transport.start();

		// Read C2C channel (console output from responder process)
		this.#readC2CChannel(transport.getChannel(c2cSymbol), processId);

		// Open the control channel and send initial configuration
		const controlChannel = await transport.requestChannel('control');
		await controlChannel.addMessageTypes(CONTROL_MESSAGE_TYPES);
		await this.#sendConfigUpdate(controlChannel);

		// Determine pool capacity
		const maxWorkers = poolConfig.at?.('maxWorkers') ?? poolConfig?.maxWorkers ?? 10;
		const minWorkers = poolConfig.at?.('minWorkers') ?? poolConfig?.minWorkers ?? 1;

		// Create request channel pool
		const reqChannelPool = new RequestChannelPool(transport, minWorkers, maxWorkers);

		// Create managed process
		const managedProc = new ManagedProcess({
			id: processId,
			type,
			poolName,
			process: child,
			transport,
			controlChannel,
			reqChannelPool,
			processManager: this,
		});

		// Initialize capacity from pool config
		managedProc.totalWorkers = maxWorkers;
		managedProc.availableWorkers = maxWorkers;
		managedProc.state = ProcessState.READY;

		// Store process
		this.processes.set(processId, managedProc);

		// Start background tasks
		this.#processControlMessages(managedProc);
		this.#monitorProcessExit(managedProc);

		this.logger.debug(`Process ${processId} created and ready (capacity: ${maxWorkers})`);

		// Return in PoolManager format
		return { item: managedProc, isWorker: false };
	}

	/**
	 * Get all tracked processes
	 */
	getAllProcesses () {
		return Array.from(this.processes.values());
	}

	/**
	 * Get process by ID
	 */
	getProcess (processId) {
		return this.processes.get(processId);
	}

	/**
	 * Perform health check on all processes
	 */
	async healthCheck () {
		for (const [processId, proc] of this.processes) {
			if (proc.state === ProcessState.DEAD) continue;

			try {
				await proc.controlChannel.write('health-check', JSON.stringify({
					timestamp: Date.now(),
				}));
				proc.lastHealthCheck = Date.now();
			} catch (error) {
				this.logger.error(`Health check failed for ${processId}: ${error.message}`);
				// Process will be marked dead by monitor
			}
		}
	}

	/**
	 * Monitor process exit and clean up.
	 * Runs as a background task.
	 * @param {ManagedProcess} managedProc
	 */
	#monitorProcessExit (managedProc) {
		(async () => {
			const status = await managedProc.process.status;

			if (status.code) this.logger.warn(`Process ${managedProc.id} exited with code ${status.code}`);

			// Mark as dead
			managedProc.state = ProcessState.DEAD;

			// Run shutdown callbacks
			for (const cb of managedProc._shutdownCallbacks) {
				try { cb(); } catch (_) {}
			}

			// Remove from tracking
			this.removeProcess(managedProc.id);

			// Note: PoolManager handles respawning via its scaling logic
		})();
	}

	/**
	 * Process incoming control channel messages for a managed process.
	 * Handles capacity-update and health-response messages.
	 * Runs as a background task.
	 * @param {ManagedProcess} managedProc
	 */
	#processControlMessages (managedProc) {
		const { id: processId, controlChannel } = managedProc;
		(async () => {
			while (true) {
				const msg = await controlChannel.read({
					only: ['capacity-update', 'health-response'],
					decode: true,
				});
				if (!msg) break;
				await msg.process(() => {
					switch (msg.messageType) {
					case 'capacity-update': {
						const { availableWorkers, totalWorkers } = JSON.parse(msg.text);
						managedProc.updateCapacity(availableWorkers, totalWorkers);
						break;
					}
					case 'health-response':
						this.logger.debug(`${processId} health response: ${msg.text}`);
						break;
					}
				});
			}
			this.logger.debug(`${processId} control channel closed`);
		})();
	}

	/**
	 * Read C2C channel (console output from responder process) and log it.
	 * Runs as a background task.
	 * @param {object} c2c - C2C channel from the PipeTransport
	 * @param {string} processId - Process ID for log attribution
	 */
	#readC2CChannel (c2c, processId) {
		(async () => {
			while (true) {
				const msg = await c2c.read({ decode: true });
				if (!msg) break;
				await msg.process(() => {
					const level = C2C_LEVEL_MAP[msg.messageType] ?? 'info';
					this.logger.asComponent(processId, () => this.logger.log(level, msg.text));
				});
			}
		})();
	}

	/**
	 * Remove process from tracking
	 */
	removeProcess (processId) {
		this.processes.delete(processId);
	}

	/**
	 * Send configuration update to a process via its control channel.
	 * @param {object} controlChannel - The control channel to write to
	 */
	async #sendConfigUpdate (controlChannel) {
		const configJson = JSON.stringify(this.config.toObject ? this.config.toObject() : this.config);
		await controlChannel.write('config-update', configJson);
	}

	/**
	 * Gracefully shutdown all processes.
	 * Note: This is typically called by PoolManager.shutdown() for each process.
	 * But can also be used for emergency shutdown of all tracked processes.
	 */
	async shutdown (timeout = 30) {
		this.isShuttingDown = true;
		this.logger.info('Shutting down all tracked processes...');

		const tasks = [];
		for (const [processId, proc] of this.processes) {
			if (proc.state === ProcessState.DEAD) continue;

			tasks.push(this.shutdownProcess(proc, timeout));
		}

		// Wait for all processes to shutdown
		if (tasks.length) await Promise.all(tasks);

		this.logger.info('Process manager shutdown complete');
	}

	/**
	 * Shutdown a service process (for PoolManager).
	 * @param {ManagedProcess} managedProc Process to shutdown
	 * @param {number} timeout Shutdown timeout in seconds
	 */
	async shutdownProcess (managedProc, timeout = 30) {
		if (!managedProc || !managedProc.id) {
			this.logger.warn('Invalid process provided to shutdownProcess');
			return;
		}

		if (managedProc.state === ProcessState.STOPPING) return;

		const processId = managedProc.id;
		this.logger.info(`Shutting down process: ${processId}`);

		managedProc.state = ProcessState.STOPPING;

		try {
			// Send shutdown signal via control channel
			await managedProc.controlChannel.write('shutdown', JSON.stringify({ timeout }));

			// Wait for process to exit (with timeout)
			const timeoutPromise = Promise.withResolvers();
			const timer = setTimeout(() => {
				this.logger.warn(`Process ${processId} did not exit within ${timeout}s; forcing termination`);
				managedProc.process.kill('SIGKILL');
				timeoutPromise.resolve();
			}, timeout * 1000);

			await managedProc.process.status.then((status) => {
				clearTimeout(timer);
				this.logger.debug(`Process ${processId} exited with code ${status.code}`);
				timeoutPromise.resolve();
			});

			// Stop transport (graceful drain)
			await managedProc.transport.stop({ discard: true });
		} catch (error) {
			this.logger.error(`Error shutting down process ${processId}: ${error.message}`);
		} finally {
			// Clean up
			this.removeProcess(processId);
		}
	}
}
