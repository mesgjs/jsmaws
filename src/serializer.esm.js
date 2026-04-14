/**
 * JSMAWS Serializer
 * Provides serialized access to async operations using a FIFO queue
 *
 * This ensures operations are executed one at a time in the order they were requested,
 * preventing race conditions and ensuring consistent state.
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Serializer class
 * Manages a queue of async operations to ensure FIFO execution
 */
export class Serializer {
	constructor () {
		this.queue = new Set();
		this.isShuttingDown = false;
	}

	/**
	 * Process queue in FIFO order
	 * @private
	 */
	async _runQueue () {
		let entry;
		// deno-lint-ignore no-cond-assign
		while (entry = this.queue.values().next().value) {
			const { turn, callback } = entry;

			if (this.isShuttingDown) {
				turn.reject(new Error('Stopping'));
			} else {
				try {
					const result = await callback();
					turn.resolve(result);
				} catch (error) {
					turn.reject(error);
				}
			}

			this.queue.delete(entry);
		}
	}

	/**
	 * Serialize an async operation
	 * Returns a promise with the return value of the async callback
	 * Rejects if shutting down
	 * @param {Function} callback Async function to execute
	 * @returns {Promise} Promise that resolves with callback's return value
	 */
	serialize (callback) {
		if (this.isShuttingDown) {
			return Promise.reject(new Error('Shutting down'));
		}

		const turn = Promise.withResolvers();
		this.queue.add({ turn, callback });

		// Start processing if this is the first item
		if (this.queue.size === 1) {
			queueMicrotask(() => this._runQueue());
		}

		return turn.promise;
	}

	/**
	 * Shutdown the serializer
	 * Rejects all pending operations
	 */
	shutdown () {
		this.isShuttingDown = true;

		// Reject all pending operations
		for (const entry of this.queue) {
			entry.turn.reject(new Error('Shutting down'));
		}
		this.queue.clear();
	}

	/**
	 * Get queue size
	 * @returns {number} Number of pending operations
	 */
	get size () {
		return this.queue.size;
	}
}
