/**
 * JSMAWS Request Channel Pool
 * Manages a pool of reusable PolyTransport request channels for operator ↔ responder IPC.
 *
 * Each channel in the pool is named 'req-N' (N = 0, 1, ...) and is reused across requests.
 * After each request, the channel is closed and immediately reopened so it is ready for the
 * next request with no state carry-over.
 *
 * Pool lifecycle:
 * - Starts with `initialSize` channels (created in parallel at construction time)
 * - Grows lazily on demand up to `maxSize`
 * - Shrinks via attrition when `resize(newMaxSize)` is called
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { Channel } from '@poly-transport/channel.esm.js';
import { Transport } from '@poly-transport/transport/base.esm.js';

/**
 * Message types registered on every req-N channel.
 * Defined as a shared constant to avoid repetition across channel creation and reopening.
 */
export const REQ_CHANNEL_MESSAGE_TYPES = [
	'req',          // operator → responder: HTTP request metadata + body (JSON text)
	'res',          // responder → operator: HTTP response status + headers (JSON text)
	'res-frame',    // responder → operator: response body chunk (binary relay, dechunk:false)
	                //   zero-data (undefined) + eom:true = end-of-stream signal
	'res-error',    // responder → operator: error response (JSON text)
	'bidi-frame',   // bidirectional relay: NestedTransport traffic between client and applet (bidi mode)
	// con-* message types for forwarded applet console output.
	// The 'con-' prefix avoids collision with the C2C channel's native bare names
	// (trace/debug/info/warn/error) and with res-error on this same channel.
	'con-trace',    // responder → operator: applet console output (trace level)
	'con-debug',    // responder → operator: applet console output (debug level)
	'con-info',     // responder → operator: applet console output (info level)
	'con-warn',     // responder → operator: applet console output (warn level)
	'con-error',    // responder → operator: applet console output (error level)
];

/**
 * Pool of reusable PolyTransport request channels.
 *
 * Channels are named 'req-0', 'req-1', ... and are checked out for a request,
 * then closed and immediately reopened when released.
 */
export class RequestChannelPool {
	#available = [];
	#channelIndex = new Map(); // channel.name → numeric index (for attrition check)
	#inUse = new Set();
	#maxSize;
	#nextIndex = 0;
	#pendingCreations = 0;
	#transport;
	#waiters = [];

	/**
	 * @param {object} transport - PolyTransport instance (PipeTransport)
	 * @param {number} initialSize - Number of channels to pre-create at startup
	 * @param {number} maxSize - Maximum number of channels in the pool
	 */
	constructor (transport, initialSize, maxSize) {
		this.#transport = transport;
		this.#maxSize = maxSize;
		// Pre-create initial channels in parallel (pipelined TCC requests)
		const initialPromises = Array.from({ length: initialSize }, () => this.#createChannel());
		// Fire and forget; channels are added to the pool as they resolve
		Promise.all(initialPromises).catch((err) => {
			console.error('[RequestChannelPool] Error pre-creating initial channels:', err);
		});
	}

	/**
	 * Acquire a channel from the pool.
	 * Returns immediately if a channel is available; otherwise waits for one.
	 * If the pool is below maxSize, a new channel is created in the background.
	 * @returns {Promise<object>} A PolyTransport channel ready for use
	 */
	async acquire () {
		if (this.#available.length > 0) {
			const channel = this.#available.pop();
			this.#inUse.add(channel);
			return channel;
		}
		// Grow the pool if below max (fire and forget; waiter will be woken when ready)
		if (this.totalSize < this.#maxSize) {
			this.#pendingCreations++;
			this.#createChannel().finally(() => this.#pendingCreations--);
		}
		// Wait for a channel to become available
		return new Promise((resolve) => {
			this.#waiters.push(resolve);
		});
	}

	/**
	 * Number of channels currently available (idle).
	 * @returns {number}
	 */
	get availableCount () {
		return this.#available.length;
	}

	/**
	 * Create a new channel and add it to the available pool.
	 * @returns {Promise<object>} The newly created channel
	 */
	async #createChannel () {
		const index = this.#nextIndex++;
		const name = `req-${index}`;
		const channel = await this.#transport.requestChannel(name);
		await channel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);
		this.#channelIndex.set(name, index);
		// Add to available pool and wake a waiter if any are waiting
		this.#available.push(channel);
		this.#wakeWaiter();
		return channel;
	}

	/**
	 * Number of channels currently in use.
	 * @returns {number}
	 */
	get inUseCount () {
		return this.#inUse.size;
	}

	/**
	 * Release a channel back to the pool.
	 * Always closes the channel to eliminate state carry-over, then immediately
	 * reopens it (unless the pool has been downsized past this channel's index).
	 * @param {object} channel - The channel to release
	 */
	async release (channel) {
		const name = channel.name;
		this.#inUse.delete(channel);
		// Always close the channel between requests to eliminate state carry-over.
		await channel.close();
		const index = this.#channelIndex.get(name);
		// Pool attrition on down-sizing: if this channel's index is beyond the
		// current pool size, remove its map entry and do not reopen it.
		if (index >= this.#maxSize) {
			this.#channelIndex.delete(name);
			return;
		}
		// Reopen the channel immediately so it is ready for the next request.
		await this.#reopenChannel(index, name);
	}

	/**
	 * Reopen a channel after it has been closed (between requests).
	 * @param {number} index - The channel's numeric index
	 * @param {string} name - The channel's name (e.g. 'req-0')
	 */
	async #reopenChannel (index, name) {
		const transport = this.#transport;
		if (transport.state !== Transport.STATE_ACTIVE) return; // Don't attempt when transport is stopping

		const channel = await transport.requestChannel(name);
		await channel.addMessageTypes(REQ_CHANNEL_MESSAGE_TYPES);
		// #channelIndex entry is retained (same name → same index); no update needed
		this.#available.push(channel);
		this.#wakeWaiter();
	}

	/**
	 * Resize the pool to a new maximum size.
	 * Immediately closes and discards available channels beyond the new range.
	 * In-flight channels beyond the range drain away via the attrition path in release().
	 * @param {number} newMaxSize - New maximum pool size
	 */
	resize (newMaxSize) {
		this.#maxSize = newMaxSize;
		// Prune already-available channels that are now beyond the new pool range.
		this.#available = this.#available.filter((channel) => {
			const index = this.#channelIndex.get(channel.name);
			if (index >= this.#maxSize) {
				this.#channelIndex.delete(channel.name);
				channel.close(); // Discard — beyond new pool range
				return false;
			}
			return true;
		});
		// Wake any waiters that may now be satisfiable with the pruned pool.
		this.#wakeWaiter();
	}

	/**
	 * Total number of channels managed by this pool (in-use + available + pending creation).
	 * @returns {number}
	 */
	get totalSize () {
		return this.#inUse.size + this.#available.length + this.#pendingCreations;
	}

	/**
	 * Wake the next waiter if a channel is available.
	 */
	#wakeWaiter () {
		if (this.#waiters.length > 0 && this.#available.length > 0) {
			const waiter = this.#waiters.shift();
			const channel = this.#available.pop();
			this.#inUse.add(channel);
			waiter(channel);
		}
	}
}
