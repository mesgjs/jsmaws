/**
 * JSMAWS Process Manager
 * Manages service process lifecycle (responders and routers)
 * 
 * Responsibilities:
 * - Spawn service processes with privilege dropping
 * - Monitor process health
 * - Handle process failures and restarts
 * - Manage affinity tracking for responders
 * - Coordinate with pool manager for scaling
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
	IDLE: 'idle',
	STOPPING: 'stopping',
	DEAD: 'dead',
};

/**
 * Managed service process
 */
class ManagedProcess {
	constructor (id, type, poolName, process, ipcConn) {
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
		this.requestsQueued = 0;
		this.affinity = new Set(); // Applet paths this process has loaded
	}

	/**
	 * Get process uptime in seconds
	 */
	getUptime () {
		return Math.floor((Date.now() - this.startTime) / 1000);
	}

	/**
	 * Check if process is idle
	 */
	isIdle () {
		return this.state === ProcessState.IDLE && this.requestsQueued === 0;
	}

	/**
	 * Check if process has capacity
	 */
	hasCapacity () {
		return this.state === ProcessState.READY && this.availableWorkers > 0;
	}

	/**
	 * Update worker capacity from response
	 */
	updateCapacity (availableWorkers, totalWorkers, requestsQueued) {
		this.availableWorkers = availableWorkers;
		this.totalWorkers = totalWorkers;
		this.requestsQueued = requestsQueued;

		// Update state based on capacity
		if (availableWorkers === 0 && requestsQueued > 0) {
			this.state = ProcessState.BUSY;
		} else if (availableWorkers > 0) {
			this.state = ProcessState.READY;
		} else if (requestsQueued === 0) {
			this.state = ProcessState.IDLE;
		}
	}

	/**
	 * Add applet to affinity set
	 */
	addAffinity (appletPath) {
		this.affinity.add(appletPath);
	}

	/**
	 * Check if process has affinity for applet
	 */
	hasAffinity (appletPath) {
		return this.affinity.has(appletPath);
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
		this.poolProcesses = new Map(); // poolName -> Set of processIds
		this.affinityMap = new Map(); // appletPath -> Set of processIds
		this.nextProcessId = 1;
		this.isShuttingDown = false;
	}

	/**
	 * Spawn a new service process
	 * @param {string} type Process type (responder or router)
	 * @param {string} poolName Pool name
	 * @param {Object} poolConfig Pool configuration
	 * @returns {Promise<ManagedProcess>}
	 */
	async spawnProcess (type, poolName, poolConfig) {
		const processId = `${type}-${poolName}-${this.nextProcessId++}`;

		this.logger.info(`Spawning ${type} process: ${processId}`);

		// Determine script path
		const scriptPath = type === ProcessType.RESPONDER
			? 'src/responder-process.esm.js'
			: 'src/router-process.esm.js';

		// Get UID/GID from pool config
		const uid = poolConfig.at('uid');
		const gid = poolConfig.at('gid');

		if (!uid || !gid) {
			throw new Error(`Pool ${poolName} missing uid/gid configuration`);
		}

		// Spawn process with privilege dropping
		const command = new Deno.Command('deno', {
			args: [
				'run',
				'--allow-read',
				'--allow-write',
				'--allow-net',
				'--allow-env',
				scriptPath,
			],
			uid: Number(uid),
			gid: Number(gid),
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
			env: {
				JSMAWS_PID: processId,
			},
		});

		const process = command.spawn();

		// Create IPC connection
		const ipcConn = new IPCConnection(process.stdout);

		// Create managed process
		const managedProc = new ManagedProcess(
			processId,
			type,
			poolName,
			process,
			ipcConn
		);

		// Store process
		this.processes.set(processId, managedProc);

		// Add to pool
		if (!this.poolProcesses.has(poolName)) {
			this.poolProcesses.set(poolName, new Set());
		}
		this.poolProcesses.get(poolName).add(processId);

		// Send initial configuration
		await this.sendConfigUpdate(managedProc);

		// Start monitoring process
		this.monitorProcess(managedProc);

		// Mark as ready after startup
		managedProc.state = ProcessState.READY;

		this.logger.info(`Process ${processId} spawned and ready`);

		return managedProc;
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
	async monitorProcess (managedProc) {
		// Monitor stderr
		(async () => {
			const decoder = new TextDecoder();
			for await (const chunk of managedProc.process.stderr) {
				const text = decoder.decode(chunk);
				this.logger.error(`[${managedProc.id}] ${text.trim()}`);
			}
		})();

		// Monitor process exit
		(async () => {
			const status = await managedProc.process.status;

			this.logger.warn(`Process ${managedProc.id} exited with code ${status.code}`);

			// Mark as dead
			managedProc.state = ProcessState.DEAD;

			// Remove from tracking
			this.removeProcess(managedProc.id);

			// Restart if not shutting down
			if (!this.isShuttingDown) {
				this.logger.info(`Restarting process ${managedProc.id}`);
				const poolConfig = this.config.at('pools').at(managedProc.poolName);
				await this.spawnProcess(managedProc.type, managedProc.poolName, poolConfig);
			}
		})();
	}

	/**
	 * Remove process from tracking
	 */
	removeProcess (processId) {
		const managedProc = this.processes.get(processId);
		if (!managedProc) return;

		// Remove from pool
		const poolSet = this.poolProcesses.get(managedProc.poolName);
		if (poolSet) {
			poolSet.delete(processId);
		}

		// Remove from affinity map
		for (const appletPath of managedProc.affinity) {
			const affinitySet = this.affinityMap.get(appletPath);
			if (affinitySet) {
				affinitySet.delete(processId);
				if (affinitySet.size === 0) {
					this.affinityMap.delete(appletPath);
				}
			}
		}

		// Remove from processes
		this.processes.delete(processId);
	}

	/**
	 * Find best process for request
	 * @param {string} poolName Pool name
	 * @param {string} appletPath Applet path (for affinity)
	 * @returns {ManagedProcess|null}
	 */
	findProcessForRequest (poolName, appletPath) {
		const poolSet = this.poolProcesses.get(poolName);
		if (!poolSet || poolSet.size === 0) {
			return null;
		}

		// Strategy 1: Find process with affinity and capacity
		if (appletPath) {
			const affinitySet = this.affinityMap.get(appletPath);
			if (affinitySet) {
				for (const processId of affinitySet) {
					if (poolSet.has(processId)) {
						const proc = this.processes.get(processId);
						if (proc && proc.hasCapacity()) {
							return proc;
						}
					}
				}
			}
		}

		// Strategy 2: Find any process with capacity
		for (const processId of poolSet) {
			const proc = this.processes.get(processId);
			if (proc && proc.hasCapacity()) {
				return proc;
			}
		}

		return null;
	}

	/**
	 * Update affinity after request dispatch
	 */
	updateAffinity (processId, appletPath) {
		const proc = this.processes.get(processId);
		if (!proc || !appletPath) return;

		// Add to process affinity
		proc.addAffinity(appletPath);

		// Add to affinity map
		if (!this.affinityMap.has(appletPath)) {
			this.affinityMap.set(appletPath, new Set());
		}
		this.affinityMap.get(appletPath).add(processId);
	}

	/**
	 * Get pool statistics
	 */
	getPoolStats (poolName) {
		const poolSet = this.poolProcesses.get(poolName);
		if (!poolSet) {
			return {
				processCount: 0,
				readyCount: 0,
				busyCount: 0,
				totalWorkers: 0,
				availableWorkers: 0,
				queuedRequests: 0,
			};
		}

		let readyCount = 0;
		let busyCount = 0;
		let totalWorkers = 0;
		let availableWorkers = 0;
		let queuedRequests = 0;

		for (const processId of poolSet) {
			const proc = this.processes.get(processId);
			if (!proc) continue;

			if (proc.state === ProcessState.READY) readyCount++;
			if (proc.state === ProcessState.BUSY) busyCount++;

			totalWorkers += proc.totalWorkers;
			availableWorkers += proc.availableWorkers;
			queuedRequests += proc.requestsQueued;
		}

		return {
			processCount: poolSet.size,
			readyCount,
			busyCount,
			totalWorkers,
			availableWorkers,
			queuedRequests,
		};
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
	 */
	async shutdown (timeout = 30) {
		this.isShuttingDown = true;
		this.logger.info('Shutting down all service processes...');

		const shutdownMsg = createShutdown(timeout);

		// Send shutdown to all processes
		const shutdownPromises = [];
		for (const [processId, proc] of this.processes) {
			if (proc.state === ProcessState.DEAD) continue;

			proc.state = ProcessState.STOPPING;

			shutdownPromises.push(
				(async () => {
					try {
						await proc.ipcConn.writeMessage(shutdownMsg);
						await proc.process.status;
						this.logger.info(`Process ${processId} shutdown complete`);
					} catch (error) {
						this.logger.error(`Error shutting down ${processId}: ${error.message}`);
					}
				})()
			);
		}

		// Wait for all processes to shutdown
		await Promise.all(shutdownPromises);

		this.logger.info('Service process shutdown sequence complete');
	}

	/**
	 * Get process by ID
	 */
	getProcess (processId) {
		return this.processes.get(processId);
	}

	/**
	 * Get all processes in pool
	 */
	getPoolProcesses (poolName) {
		const poolSet = this.poolProcesses.get(poolName);
		if (!poolSet) return [];

		return Array.from(poolSet)
			.map(id => this.processes.get(id))
			.filter(proc => proc !== undefined);
	}
}
