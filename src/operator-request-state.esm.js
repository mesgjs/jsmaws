/**
 * JSMAWS Operator Request State Machine
 * Handles request lifecycle with data-driven state transitions
 *
 * This module implements a state machine for request handling that eliminates
 * handler swapping and race conditions. State is stored as data, not code flow.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { WebSocketTransport } from '@poly-transport/transport/websocket.esm.js';
import { OperatorProcess } from './operator-process.esm.js';

/**
 * Request state machine states
 */
export const RequestState = {
	WAITING_FIRST_FRAME: 'waiting_first_frame',
	STREAMING_RESPONSE: 'streaming_response',
	BIDI_ACTIVE: 'bidi_active',
	COMPLETED: 'completed'
};

/**
 * WebSocket-specific bidi upgrade function.
 * Upgrades the HTTP request to WebSocket and creates a WebSocketTransport
 * for the client connection.
 *
 * This is the default upgrade function used in production. Tests can inject
 * an alternative via the upgradeCallback parameter of initializeBidiConnection.
 *
 * NOTE: The transport is NOT started here. The caller must send the HTTP 101
 * upgrade response first (by resolving the response promise), then call
 * transport.start() to begin the WebSocket handshake.
 *
 * @param {RequestContext} context - The request context
 * @param {{ maxChunkSize: number }} bidiParams - Bidi parameters from configuration
 * @returns {{ transport: WebSocketTransport, response: Response }}
 */
export function webSocketUpgrade (context, bidiParams) {
	// Upgrade to WebSocket
	const { socket, response } = Deno.upgradeWebSocket(context.originalRequest);

	// Create WebSocketTransport for client connection
	const transport = new WebSocketTransport({
		ws: socket,
		maxChunkBytes: bidiParams.maxChunkSize,
		lowBufferBytes: bidiParams.maxChunkSize,
		c2cSymbol: null,  // No C2C needed for client-facing transport
		bufferPool: context.operator.bufferPool,  // Use operator's shared buffer pool
	});

	// Only accept the single pre-designated 'bidi' channel
	transport.addEventListener('newChannel', (event) => {
		if (event.detail.channelName === 'bidi') {
			event.accept();
		}
	});

	// Transport is NOT started here — must be started after the HTTP 101 response
	// is sent to the client (i.e. after responsePromise.resolve(response) below).
	return { transport, response };
}

/**
 * Request context for state machine.
 * Stores all state as data rather than in code flow, and owns all state
 * transition logic as methods.
 */
export class RequestContext {
	constructor ({requestId, process, poolName, routeSpec, request, appletPath, operator, reqChannel, poolManager, poolItemId}) {
		this.requestId = requestId;
		this.process = process;
		this.poolName = poolName;
		this.routeSpec = routeSpec ?? null;
		this.originalRequest = request;  // For WebSocket upgrade
		this.app = appletPath;
		this.operator = operator ?? OperatorProcess.instance; // Allows mocking for tests
		this.reqChannel = reqChannel ?? null; // req-N channel for this request
		this.poolManager = poolManager ?? null;
		this.poolItemId = poolItemId ?? null;

		// State machine
		this.state = RequestState.WAITING_FIRST_FRAME;

		// Response promise
		this.responsePromise = Promise.withResolvers();

		// Response data (populated from first frame)
		this.mode = null;
		this.status = null;
		this.headers = null;
		this.keepAlive = false;

		// Stream controller (for response/stream modes)
		this.streamController = null;

		// Bidi connection state
		this.bidiState = null;
	}

	/**
	 * Handle error in state machine.
	 * @param {Error} error
	 */
	handleError (error) {
		this.operator?.logger.error(`[${this.requestId}] Error in state ${this.state}: ${error.message}`);

		// Reject promise if not yet resolved
		if (this.state === RequestState.WAITING_FIRST_FRAME) {
			this.responsePromise.reject(error);
		}

		// Close stream if active
		if (this.streamController) {
			try {
				this.streamController.error(error);
			} catch (_) {
				// Ignore if already closed
			}
		}

		// Close bidi transport if active
		if (this.bidiState?.transport) {
			try {
				this.bidiState.transport.stop({ discard: true });
			} catch (_) {
				// Ignore if already closed
			}
		}

		this.state = RequestState.COMPLETED;
		this.releaseReqChannel();
	}

	/**
	 * Handle a res-frame body chunk from the responder.
	 * Called when a 'res-frame' chunk arrives on the req-N channel.
	 *
	 * @param {VirtualBuffer|string|Uint8Array|undefined} data - Frame data
	 * @param {boolean} eom - End-of-message flag
	 */
	async handleResFrame (data, eom) {
		// Enqueue data into the ReadableStream.
		// data may be a VirtualBuffer (binary write), a string (text write), or null/undefined (EOS).
		// ReadableStream requires Uint8Array chunks; convert lazily at the terminal enqueue point.
		if (data != null) {
			let chunk;
			if (typeof data === 'string') {
				chunk = new TextEncoder().encode(data);
			} else if (data.toUint8Array) {
				chunk = data.toUint8Array();
			} else {
				chunk = data; // Already Uint8Array or compatible
			}
			if (chunk.length > 0) {
				this.streamController?.enqueue(chunk);
			}
		}

		// Check for end-of-stream (null/undefined data + eom:true)
		if (data == null && eom) {
			try { this.streamController?.close(); } catch (_) {}
			this.state = RequestState.COMPLETED;
			this.operator.logger.debug(`[${this.requestId}] was STREAMING_RESPONSE now COMPLETED`);

			// Release the req-N channel now that the stream is fully consumed
			this.releaseReqChannel();

			// Mark pool item idle now that stream is closed
			if (this.poolManager && this.poolItemId) {
				await this.poolManager.decrementItemUsage(this.poolItemId);
			}
		}
	}

	/**
	 * Handle response metadata from the responder.
	 * Called when a 'res' message arrives on the req-N channel.
	 *
	 * @param {string} resData - JSON-encoded response metadata
	 * @param {Function} [upgradeCallback] - Optional bidi upgrade callback (for testing/DI).
	 *   Passed through to initializeBidiConnection. Defaults to webSocketUpgrade.
	 */
	async handleResponseMetadata (resData, upgradeCallback) {
		// Extract connection data from message
		const { mode, status, headers: rawHeaders, keepAlive } = JSON.parse(resData);

		const headers = this.operator.convertHeaders(rawHeaders);

		// Save in context
		this.mode = mode;
		this.status = status;
		this.headers = headers;
		this.keepAlive = keepAlive ?? false;

		// Transition based on mode
		if (mode === 'bidi' && status === 101) {
			// Bidi upgrade: immediately initialize connection
			// The first frame (status 101) should have no data (policy enforced by responder)
			this.state = RequestState.BIDI_ACTIVE;
			this.operator.logger.debug(`[${this.requestId}] was WAITING_FIRST_FRAME now BIDI_ACTIVE`);

			// Initialize bidi connection immediately (sets up WebSocket by default)
			await this.initializeBidiConnection(upgradeCallback);

		} else if (mode === 'response' || mode === 'stream') {
			// Transition: body will arrive as res-frame chunks, EOS signaled by null res-frame
			this.state = RequestState.STREAMING_RESPONSE;
			this.operator.logger.debug(`[${this.requestId}] was WAITING_FIRST_FRAME now STREAMING_RESPONSE`);

			// Create ReadableStream; body chunks arrive via handleResFrame()
			const stream = new ReadableStream({
				start: (controller) => {
					this.streamController = controller;
				}
			});

			// Create Response and resolve promise
			const response = new Response(stream, { status, headers });
			this.responsePromise.resolve(response);

		} else {
			throw new Error(`Unknown mode: ${mode}`);
		}
	}

	/**
	 * Initialize bidirectional connection — derive params from configuration.
	 * Called from handleResponseMetadata() when status 101 is received.
	 *
	 * @param {Function} [upgradeCallback] - Optional callback for bidi upgrade (for testing/DI).
	 *   Signature: (context, bidiParams) => { transport, response }
	 *   The callback returns an unstarted transport and the protocol upgrade response.
	 *   The caller (this method) resolves the response promise first, then starts the
	 *   transport so the underlying protocol handshake can complete.
	 *   Defaults to webSocketUpgrade (WebSocket upgrade via Deno.upgradeWebSocket).
	 */
	async initializeBidiConnection (upgradeCallback = webSocketUpgrade) {
		const { requestId, operator } = this;

		const bidiStarting = { promise: null };
		bidiStarting.promise = new Promise((resolve) => bidiStarting.resolve = resolve);
		this.bidiState = { bidiStarting };

		// Derive params from configuration (same as responder will use)
		const bidiParams = operator.config.getBidiParams({
			routeSpec: this.routeSpec
		});

		// Perform the bidi upgrade (WebSocket by default, injectable for testing).
		// The upgrade callback returns the transport (not yet started) and the protocol
		// upgrade response.  The transport MUST NOT be started until after the response
		// has been sent to the client.
		const { transport, response } = await upgradeCallback(this, bidiParams);

		// Handle transport stop — register before start so no events are missed.
		transport.addEventListener('stopped', async () => {
			operator.logger.debug(`Bidi connection ${requestId} transport stopped`);
			this.state = RequestState.COMPLETED;

			// Release the req-N channel now that the bidi connection is fully closed
			this.releaseReqChannel();

			// Mark pool item idle now that connection is closed
			if (this.poolManager && this.poolItemId) {
				await this.poolManager.decrementItemUsage(this.poolItemId);
			}

			operator.cleanupRequestContext(requestId);
		});

		// Resolve the response promise with the protocol upgrade response.
		// This sends the upgrade response (e.g. HTTP 101) to the client, which is
		// required before the transport handshake can proceed.
		this.responsePromise.resolve(response);

		// Now that the upgrade response has been queued for delivery, start the
		// transport so it can complete the protocol handshake and begin I/O.
		await transport.start();

		// Get the pre-designated bidi channel and register the bidi-frame message type
		const bidiChannel = await transport.requestChannel('bidi');
		await bidiChannel.addMessageTypes(['bidi-frame']);

		// Store bidi state in context
		this.bidiState = {
			transport,
			bidiChannel,
		};
		bidiStarting.resolve();

		// Relay: forward 'bidi-frame' from bidi channel → req-N 'bidi-frame'
		// dechunk: false — bidi-frame carries NestedTransport byte-stream chunks
		// eom: false on write — NestedTransport chunks are not application messages
		(async () => {
			// console.log('*** initBidiCon (opr client -> app) bidi-relay ready');
			while (true) {
				const msg = await bidiChannel.read({ only: 'bidi-frame', dechunk: false });
				if (!msg) break;
				await msg.process(async () => {
					if (this.state !== RequestState.COMPLETED && this.reqChannel) {
						// console.log('*** Opr Cli->App bidi relay', msg.dataSize);
						await this.reqChannel.write('bidi-frame', msg.data, { eom: false });
					}
					// else console.log('*** Opr Cli->App discarding message', this.state, this.reqChannel);
				});
			}
		})();
	}

	/**
	 * Process response-related messages on a req-N channel for this request.
	 * Handles 'res', 'res-error', 'res-frame', 'bidi-frame', and 'con-*' messages.
	 *
	 * @param {object} reqChannel - The req-N channel from the RequestChannelPool
	 */
	processReqChannelMessages (reqChannel) {
		const { operator } = this;

		const CON_TYPES = ['con-trace', 'con-debug', 'con-info', 'con-warn', 'con-error'];

		// Loop 1: metadata and console output (dechunked)
		// 'res' carries HTTP response status + headers (sent once, before any res-frame chunks)
		// 'res-error' carries error response (sent instead of res + res-frame)
		// con-* carry forwarded applet console output
		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: ['res', 'res-error', ...CON_TYPES] });
				if (!msg) break;
				await msg.process(async () => {
					switch (msg.messageType) {
					case 'res':
						try {
							await this.handleResponseMetadata(msg.data.decode());
						} catch (error) {
							this.handleError(error);
						}
						break;
					case 'res-error': {
						const errorData = JSON.parse(msg.data.decode());
						const status = errorData.status ?? 500;
						const errorMsg = errorData.error ?? 'Internal Server Error';
						operator.logger.error(`[${this.requestId}] Responder error: ${errorMsg}`);
						if (this.state === RequestState.WAITING_FIRST_FRAME) {
							const body = JSON.stringify({ error: errorMsg });
							this.responsePromise.resolve(new Response(body, {
								status,
								headers: { 'content-type': 'application/json' },
							}));
						} else if (this.streamController) {
							this.streamController.error(new Error(errorMsg));
						}
						this.state = RequestState.COMPLETED;
						if (this.poolManager && this.poolItemId) {
							await this.poolManager.decrementItemUsage(this.poolItemId);
						}
						break;
					}
					default:
						// con-* messages: applet console output
						if (msg.messageType.startsWith('con-')) {
							const text = msg.data?.decode() ?? '';
							const level = msg.messageType.slice(4); // strip 'con-' prefix
							const appFile = this.app?.split('/').pop();
							operator.logger.asComponent(this.process.id, () =>
								operator.logger.log(level, `[Applet:${appFile || this.requestId}] ${text}`)
							);
						}
						break;
					}
				});
			}
		})();

		// Loop 2: response body chunks (dechunk: false — relay verbatim without reassembly)
		// res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
		// Pass msg.data ?? msg.text so string and binary writes are both handled lazily.
		(async () => {
			while (true) {
				const msg = await reqChannel.read({ only: 'res-frame', dechunk: false });
				if (!msg) break;
				await msg.process(async () => {
					if (this.state === RequestState.STREAMING_RESPONSE) {
						await this.handleResFrame(msg.data, msg.eom);
					}
				});
			}
		})();

		// Loop 3: bidi-frame relay (dechunk: false — forward chunks verbatim)
		// Only active for bidi requests; runs concurrently with loops 1 and 2.
		(async () => {
			// console.log('*** prcReqChMsg (opr app -> client) bidi-relay ready');
			while (true) {
				const msg = await reqChannel.read({ only: 'bidi-frame', dechunk: false });
				if (!msg) break;
				await msg.process(async () => {
					if (this.state === RequestState.BIDI_ACTIVE) {
						await this.relayBidiFrame(msg.data);
					}
					// else console.log('*** Opr App->Cli discarding message');
				});
			}
		})();
	}

	/**
	 * Relay a bidi-frame chunk from the responder to the client WebSocket bidi channel.
	 * Called when a 'bidi-frame' message arrives on the req-N channel from the responder.
	 *
	 * @param {VirtualBuffer|Uint8Array|undefined} data - Frame data
	 */
	async relayBidiFrame (data) {
		// Forward to WebSocket bidi channel (when ready)
		const starting = this.bidiState?.bidiStarting;
		if (starting) await starting.promise;
		if (data && this.state !== RequestState.COMPLETED) {
			if (this.bidiState?.bidiChannel) {
				// console.log('*** Opr App->Cli bidi relay', data.length);
				await this.bidiState.bidiChannel.write('bidi-frame', data, { eom: false });
			// } else {
				// console.log('### Opr App->Cli NO BIDI CHANNEL');
			}
		// } else {
			// console.log('### Opr App->Cli BIDI COMPLETED');
		}
	}

	/**
	 * Release the req-N channel back to the process's channel pool.
	 * Idempotent: clears this.reqChannel after the first call so subsequent
	 * calls are no-ops.  Must only be called once the state machine has
	 * reached COMPLETED (i.e. all data has been sent / received).
	 */
	releaseReqChannel () {
		const channel = this.reqChannel;
		if (!channel) return; // Already released
		this.reqChannel = null;
		this.process.reqChannelPool.release(channel).catch((err) => {
			this.operator?.logger.warn(`[${this.requestId}] Failed to release req-N channel: ${err.message}`);
		});
	}
}
