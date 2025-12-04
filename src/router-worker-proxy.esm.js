/**
 * JSMAWS Router Worker Proxy
 * A reusable router worker wrapper (proxy) for both operator (internal routing) and router-process (delegated routing)
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Router worker proxy
 * Manages a single Web Worker running router-worker.esm.js
 */
export class RouterWorkerProxy {
	constructor (workerId, workerUrl) {
		this.id = workerId;
		this.worker = new Worker(workerUrl, { type: 'module' });
		this.isAvailable = false;
		this.isInitialized = false;
		this.pendingMessages = new Map(); // messageId -> {resolve, reject, timeout}
		this.messageIdCounter = 0;

		// Set up message handler
		this.worker.onmessage = (event) => this.handleWorkerMessage(event);
		this.worker.onerror = (error) => this.handleWorkerError(error);
	}

	/**
	 * Generate unique message ID
	 */
	generateMessageId () {
		return `${this.id}-${++this.messageIdCounter}`;
	}

	/**
	 * Send message to worker and wait for response
	 */
	async sendMessage (type, data, timeoutMs = 30000) {
		const id = this.generateMessageId();

		return new Promise((resolve, reject) => {
			// Set up timeout
			const timeout = setTimeout(() => {
				this.pendingMessages.delete(id);
				reject(new Error(`Worker message timeout: ${type}`));
			}, timeoutMs);

			// Store pending message
			this.pendingMessages.set(id, { resolve, reject, timeout });

			// Send message to worker
			this.worker.postMessage({ type, id, data });
		});
	}

	/**
	 * Handle message from worker
	 */
	handleWorkerMessage (event) {
		const { type, id, success, result, error } = event.data;

		const pending = this.pendingMessages.get(id);
		if (!pending) {
			console.warn(`[RouterWorkerProxy:${this.id}] Received response for unknown message: ${id}`);
			return;
		}

		// Clear timeout and remove from pending
		clearTimeout(pending.timeout);
		this.pendingMessages.delete(id);

		// Resolve or reject based on success
		if (success) {
			pending.resolve(result);
		} else {
			pending.reject(new Error(error || 'Worker error'));
		}
	}

	/**
	 * Handle worker error
	 */
	handleWorkerError (error) {
		console.error(`[RouterWorkerProxy:${this.id}] Worker error:`, error);

		// Reject all pending messages
		for (const [id, pending] of this.pendingMessages.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Worker crashed'));
		}
		this.pendingMessages.clear();

		this.isAvailable = false;
		this.isInitialized = false;
	}

	/**
	 * Initialize worker with configuration
	 * @param {Configuration} config Configuration instance
	 */
	async initialize (config) {
		// Serialize configuration to SLID for transmission
		const slidConfig = config.toSLID();
		await this.sendMessage('init', { config: slidConfig });
		this.isInitialized = true;
		this.isAvailable = true;
	}

	/**
	 * Update worker configuration
	 * @param {Configuration} config Configuration instance
	 */
	async updateConfig (config) {
		// Serialize configuration to SLID for transmission
		const slidConfig = config.toSLID();
		await this.sendMessage('config', { config: slidConfig });
	}

	/**
	 * Find route using worker
	 */
	async findRoute (pathname, method) {
		if (!this.isInitialized) {
			throw new Error('Worker not initialized');
		}

		this.isAvailable = false;
		try {
			const result = await this.sendMessage('route', { pathname, method });
			return result;
		} finally {
			this.isAvailable = true;
		}
	}

	/**
	 * Terminate worker
	 */
	terminate () {
		// Reject all pending messages
		for (const [id, pending] of this.pendingMessages.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Worker terminated'));
		}
		this.pendingMessages.clear();

		this.worker.terminate();
		this.isAvailable = false;
		this.isInitialized = false;
	}
}
