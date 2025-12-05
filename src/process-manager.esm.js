/**
 * JSMAWS Process Manager
 * Factory for creating and managing service processes (responders and routers)
 *
 * Responsibilities:
 * - Create service processes with privilege dropping (factory for PoolManager)
 * - Monitor process health and lifecycle
 * - Handle IPC connections and console output
 * - Shutdown processes gracefully
 *
 * Note: Pool management (scaling, recycling, capacity) is handled by PoolManager.
 * This class is a pure factory that creates and monitors process instances.
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { IPCConnection, createConfigUpdate, createShutdown, createHealthCheck, MessageType } from './ipc-protocol.esm.js';

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
 * Managed service process
 */
class ManagedProcess {
	constructor (id, type, poolName, process, ipcConn, processManager) {
		this.id = id;
		this.type = type;
		this.poolName = poolName;
		this.process = process;
		this.ipcConn = ipcConn;
		this.state = ProcessState.STARTING;
		this.startTime = Date.now();
		this.requestCount = 0;
		this.lastHealthCheck = null;
		this.availableWorkers = 0;
		this.totalWorkers = 0;
		this.affinity = new Set(); // Applet paths this process has loaded
		this.processManager = processManager;
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
	 * Shutdown (typically for recycling, so default is fast)
	 */
	shutdown (timeout = 5) {
		this.processManager.shutdownProcess(this, timeout);
	}

	/**
	 * Update worker capacity from response
	 */
	updateCapacity (availableWorkers, totalWorkers) {
		this.availableWorkers = availableWorkers;
		this.totalWorkers = totalWorkers;

		// Update state based on capacity
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
			stderr: 'piped',
			env: {
				JSMAWS_PID: processId,
				JSMAWS_POOL: poolName,
			},
		});

		const process = command.spawn();

		// Create IPC connection for stdout (handles IPC messages)
		const stdinWriter = process.stdin.getWriter();
		const stdoutReader = process.stdout.getReader();

		const ipcConn = new IPCConnection({
			read: () => stdoutReader.read(),
			write: (data) => stdinWriter.write(data),
			close: async () => {
				try {
					await stdoutReader.cancel();
					await process.stdin.close();
				} catch (e) {
					// Ignore close errors
				}
			},
		}, {
			logger: this.logger // Pass logger for proper logging in operator context
		});

		// Set console output handler for stdout
		ipcConn.setConsoleOutputHandler((text, logLevel) => {
			const localText = text.replace(new RegExp('^\\[' + processId + '\\]\\s*'), ''), logger = this.logger;
			logger.asComponent(processId, () => logger.log(logLevel, localText));
		});

		// Set capacity update callback
		ipcConn.onCapacityUpdate = (capacity) => {
			const availableWorkers = capacity?.at('availableWorkers');
			const totalWorkers = capacity?.at('totalWorkers');
			if (totalWorkers) {
				managedProc.updateCapacity(availableWorkers, totalWorkers);
			}
		};

		// Register global handlers for unsolicited messages
		ipcConn.onMessage(MessageType.HEALTH_CHECK, async (message, binaryData) => {
			// Capacity already updated via onCapacityUpdate callback
			// Just log health status
			const status = message.fields.at('status', 'unknown');
			this.logger.debug(`${processId} health check response: ${status}`);
		});

		// Create separate reader for stderr (console output only)
		const stderrReader = process.stderr.getReader();
		const stderrConn = new IPCConnection({
			read: () => stderrReader.read(),
			write: () => { throw new Error('Cannot write to stderr'); },
			close: async () => {
				try {
					await stderrReader.cancel();
				} catch (e) {
					// Ignore close errors
				}
			},
		});

		// Set console output handler for stderr
		stderrConn.setConsoleOutputHandler((text, logLevel) => {
			const localText = text.replace(new RegExp('^\\[' + processId + '\\]\\s*'), ''), logger = this.logger;
			logger.asComponent(processId, () => logger.log(logLevel, localText));
		});

		// Create managed process
		const managedProc = new ManagedProcess(
			processId,
			type,
			poolName,
			process,
			ipcConn,
			this
		);

		// Store process
		this.processes.set(processId, managedProc);

		// Send initial configuration
		await this.sendConfigUpdate(managedProc);

		// Start continuous monitoring (background task)
		ipcConn.startMonitoring();

		// Start monitoring process
		this.monitorProcess(managedProc, stderrConn);

		// Initialize capacity from pool config
		const maxWorkers = poolConfig.at('maxWorkers', 10);
		managedProc.totalWorkers = maxWorkers;
		managedProc.availableWorkers = maxWorkers;

		// Mark as ready after startup
		managedProc.state = ProcessState.READY;

		this.logger.debug(`Process ${processId} created and ready (capacity: ${maxWorkers})`);

		// Return in PoolManager format
		return { item: managedProc, isWorker: false };
	}

	/**
		* Shutdown a service process (for PoolManager)
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
			// Send shutdown signal
			const shutdownMsg = createShutdown(timeout);
			await managedProc.ipcConn.writeMessage(shutdownMsg);

			// Wait for process to exit (with timeout)
			const exitPromise = managedProc.process.status;
			const timeoutPromise = new Promise((resolve) =>
				setTimeout(() => resolve({ code: -1, signal: 'TIMEOUT' }), timeout * 1000)
			);

			const status = await Promise.race([exitPromise, timeoutPromise]);

			if (status.signal === 'TIMEOUT') {
				this.logger.warn(`Process ${processId} did not exit within ${timeout}s, forcing termination`);
				managedProc.process.kill('SIGKILL');
			} else {
				this.logger.debug(`Process ${processId} exited with code ${status.code}`);
			}
		} catch (error) {
			this.logger.error(`Error shutting down process ${processId}: ${error.message}`);
		} finally {
			// Clean up
			this.removeProcess(processId);
		}
	}

	/**
	 * Send configuration update to process
	 */
	async sendConfigUpdate (managedProc) {
		const configMsg = createConfigUpdate(this.config);
		await managedProc.ipcConn.writeMessage(configMsg);
	}

	/**
	 * Monitor process for errors and exit
	 */
	async monitorProcess (managedProc, stderrConn) {
		// Monitor stderr for console output
		(async () => {
			try {
				// Keep reading from stderr (will only get console output)
				while (true) {
					const result = await stderrConn.readMessage();
					if (!result) break; // Stream closed

					// Stderr should never have IPC messages, but if it does, log error
					this.logger.error(`[${managedProc.id}] Unexpected IPC message on stderr: ${result.message.type}`);
				}
			} catch (error) {
				if (!this.isShuttingDown) {
					this.logger.error(`[${managedProc.id}] stderr monitoring error: ${error.message}`);
				}
			}
		})();

		// Monitor process exit
		(async () => {
			const status = await managedProc.process.status;

			if (status.code) this.logger.warn(`Process ${managedProc.id} exited with code ${status.code}`);

			// Mark as dead
			managedProc.state = ProcessState.DEAD;

			// Remove from tracking
			this.removeProcess(managedProc.id);

			// Note: PoolManager handles respawning via its scaling logic
		})();
	}

	/**
	 * Remove process from tracking
	 */
	removeProcess (processId) {
		const managedProc = this.processes.get(processId);
		if (!managedProc) return;

		// Remove from processes
		this.processes.delete(processId);
	}

	/**
	 * Perform health check on all processes
	 */
	async healthCheck () {
		const healthCheckMsg = createHealthCheck();

		for (const [processId, proc] of this.processes) {
			if (proc.state === ProcessState.DEAD) continue;

			try {
				await proc.ipcConn.writeMessage(healthCheckMsg);
				proc.lastHealthCheck = Date.now();
			} catch (error) {
				this.logger.error(`Health check failed for ${processId}: ${error.message}`);
				// Process will be marked dead by monitor
			}
		}
	}

	/**
	 * Gracefully shutdown all processes
	 * Note: This is typically called by PoolManager.shutdown() for each process
	 * But can also be used for emergency shutdown of all tracked processes
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
	 * Get process by ID
	 */
	getProcess (processId) {
		return this.processes.get(processId);
	}

	/**
	 * Get all tracked processes
	 */
	getAllProcesses () {
		return Array.from(this.processes.values());
	}
}
