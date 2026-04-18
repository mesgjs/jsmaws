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
 * Request context for state machine
 * Stores all state as data rather than in code flow
 */
export class RequestContext {
	constructor (requestId, process, poolName, routeSpec, req, app) {
		this.requestId = requestId;
		this.process = process;
		this.poolName = poolName;
		this.routeSpec = routeSpec;
		this.originalRequest = req;  // For WebSocket upgrade
		this.app = app;

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

		// req-N channel for this request
		this.reqChannel = null;

		// Pool manager and item ID for cleanup
		this.poolManager = null;
		this.poolItemId = null;
	}
}

/**
 * Cleanup completed request context
 */
export function cleanupRequestContext (requestId, requestContexts, logger) {
	const context = requestContexts.get(requestId);
	if (context && context.state === RequestState.COMPLETED) {
		requestContexts.delete(requestId);
		logger.debug(`[${requestId}] Context cleaned up`);
	}
}

/**
 * Relay a bidi-frame chunk from the responder to the client WebSocket bidi channel.
 * Called when a 'bidi-frame' message arrives on the req-N channel from the responder.
 */
export async function relayBidiFrame (context, data, operator) {
	// Forward to WebSocket bidi channel
	if (data && context.state !== RequestState.COMPLETED) {
		if (context.bidiState?.bidiChannel) {
			await context.bidiState.bidiChannel.write('bidi-frame', data, { eom: false });
		}
	}
}

/**
 * Handle error in state machine
 */
export function handleRequestError (context, error, operator) {
	operator.logger.error(`[${context.requestId}] Error in state ${context.state}: ${error.message}`);

	// Reject promise if not yet resolved
	if (context.state === RequestState.WAITING_FIRST_FRAME) {
		context.responsePromise.reject(error);
	}

	// Close stream if active
	if (context.streamController) {
		try {
			context.streamController.error(error);
		} catch (e) {
			// Ignore if already closed
		}
	}

	// Close WebSocket transport if active
	if (context.bidiState?.wsTransport) {
		try {
			context.bidiState.wsTransport.stop({ discard: true });
		} catch (e) {
			// Ignore if already closed
		}
	}

	context.state = RequestState.COMPLETED;
}

/**
 * Handle response metadata from the responder.
 * Called when a 'res' message arrives on the req-N channel.
 *
 * @param {RequestContext} context - The request context
 * @param {string} resData - JSON-encoded response metadata
 * @param {object} operator - The OperatorProcess instance
 * @param {Function} [upgradeCallback] - Optional bidi upgrade callback (for testing/DI).
 *   Passed through to initializeBidiConnection. Defaults to webSocketUpgrade.
 */
export async function handleResponseMetadata (context, resData, operator, upgradeCallback) {
	// Extract connection data from message
	const { mode, status, headers: rawHeaders, keepAlive } = JSON.parse(resData);

	const headers = operator.convertHeaders(rawHeaders);

	// Save in context
	context.mode = mode;
	context.status = status;
	context.headers = headers;
	context.keepAlive = keepAlive ?? false;

	// Transition based on mode, state
	if (mode === 'bidi' && status === 101) {
		// Bidi upgrade: immediately initialize connection
		// The first frame (status 101) should have no data (policy enforced by responder)
		context.state = RequestState.BIDI_ACTIVE;
		operator.logger.debug(`[${context.requestId}] was WAITING_FIRST_FRAME now BIDI_ACTIVE`);

		// Initialize bidi connection immediately (sets up WebSocket by default)
		await initializeBidiConnection(context, operator, upgradeCallback);

	} else if (mode === 'response' && !keepAlive) {
		// Transition: streaming response — body will arrive as res-frame chunks
		context.state = RequestState.STREAMING_RESPONSE;
		operator.logger.debug(`[${context.requestId}] was WAITING_FIRST_FRAME now STREAMING_RESPONSE`);

		// Create ReadableStream
		const stream = new ReadableStream({
			start (controller) {
				context.streamController = controller;
			}
		});

		// Create Response and resolve promise
		const response = new Response(stream, { status, headers });
		context.responsePromise.resolve(response);

	} else if (mode === 'response' || mode === 'stream') {
		// Transition: streaming response (keepAlive or stream mode)
		context.state = RequestState.STREAMING_RESPONSE;
		operator.logger.debug(`[${context.requestId}] was WAITING_FIRST_FRAME now STREAMING_RESPONSE`);

		// Create ReadableStream
		const stream = new ReadableStream({
			start (controller) {
				context.streamController = controller;
			}
		});

		// Create Response and resolve promise
		const response = new Response(stream, { status, headers });
		context.responsePromise.resolve(response);

	} else {
		throw new Error(`Unknown mode: ${mode}`);
	}
}

/**
 * Handle a res-frame body chunk from the responder.
 * Called when a 'res-frame' chunk arrives on the req-N channel.
 */
export async function handleResFrame (context, data, eom, operator) {
	// Enqueue data
	if (data && data.length > 0) {
		context.streamController?.enqueue(data);
	}

	// Check for end-of-stream (zero-data + eom:true)
	if (data === undefined && eom) {
		context.streamController?.close();
		context.state = RequestState.COMPLETED;
		operator.logger.debug(`[${context.requestId}] was STREAMING_RESPONSE now COMPLETED`);

		// Mark pool item idle now that stream is closed
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.decrementItemUsage(context.poolItemId);
		}
	}
}

/**
 * WebSocket-specific bidi upgrade function.
 * Upgrades the HTTP request to WebSocket and creates a WebSocketTransport
 * for the client connection.
 *
 * This is the default upgrade function used in production. Tests can inject
 * an alternative via the upgradeCallback parameter of initializeBidiConnection.
 *
 * @param {RequestContext} context - The request context
 * @param {{ maxChunkSize: number }} bidiParams - Bidi parameters from configuration
 * @returns {Promise<{ transport: WebSocketTransport, bidiChannel: object, response: Response }>}
 */
export async function webSocketUpgrade (context, bidiParams) {
	// Upgrade to WebSocket
	const { socket, response } = Deno.upgradeWebSocket(context.originalRequest);

	// Create WebSocketTransport for client connection
	const wsTransport = new WebSocketTransport({
		ws: socket,
		maxChunkBytes: bidiParams.maxChunkSize,
		lowBufferBytes: bidiParams.maxChunkSize,
		c2cSymbol: null,  // No C2C needed for client-facing transport
	});

	// Only accept the single pre-designated 'bidi' channel
	wsTransport.addEventListener('newChannel', (event) => {
		if (event.detail.channelName === 'bidi') {
			event.accept();
		} else {
			event.reject();
		}
	});

	await wsTransport.start();

	// Get the pre-designated bidi channel and register the bidi-frame message type
	const bidiChannel = await wsTransport.requestChannel('bidi');
	await bidiChannel.addMessageTypes(['bidi-frame']);

	return { transport: wsTransport, bidiChannel, response };
}

/**
 * Initialize bidirectional connection - derive params from configuration.
 * Called from handleResponseMetadata() when status 101 is received.
 *
 * @param {RequestContext} context - The request context
 * @param {object} operator - The OperatorProcess instance
 * @param {Function} [upgradeCallback] - Optional callback for bidi upgrade (for testing/DI).
 *   Signature: async (context, bidiParams) => { transport, bidiChannel, response }
 *   Defaults to webSocketUpgrade (WebSocket upgrade via Deno.upgradeWebSocket).
 */
export async function initializeBidiConnection (context, operator, upgradeCallback = webSocketUpgrade) {
	const { requestId } = context;

	// Derive params from configuration (same as responder will use)
	const bidiParams = operator.configuration.getBidiParams({
		routeSpec: context.routeSpec
	});

	// Perform the bidi upgrade (WebSocket by default, injectable for testing)
	const { transport: wsTransport, bidiChannel, response } = await upgradeCallback(context, bidiParams);

	// Store bidi state in context
	context.bidiState = {
		wsTransport,
		bidiChannel,
	};

	// Relay: forward 'bidi-frame' from WS bidi channel → req-N 'bidi-frame'
	// dechunk: false — bidi-frame carries NestedTransport byte-stream chunks
	// eom: false on write — NestedTransport chunks are not application messages
	(async () => {
		while (true) {
			const msg = await bidiChannel.read({ only: 'bidi-frame', dechunk: false });
			if (!msg) break;
			await msg.process(async () => {
				if (context.state !== RequestState.COMPLETED && context.reqChannel) {
					await context.reqChannel.write('bidi-frame', msg.data, { eom: false });
				}
			});
		}
	})();

	// Handle transport stop (WebSocket close)
	wsTransport.addEventListener('stopped', async () => {
		operator.logger.debug(`Bidi connection ${requestId} WebSocket transport stopped`);
		context.state = RequestState.COMPLETED;

		// Mark pool item idle now that connection is closed
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.decrementItemUsage(context.poolItemId);
		}

		operator.cleanupRequestContext(requestId);
	});

	// Resolve the response promise with the WebSocket upgrade response
	context.responsePromise.resolve(response);
}

/**
 * Process incoming messages on a req-N channel for a request.
 * Handles 'res', 'res-error', 'res-frame', 'bidi-frame', and 'con-*' messages.
 *
 * @param {RequestContext} context - The request context
 * @param {object} reqChannel - The req-N channel from the RequestChannelPool
 * @param {object} operator - The OperatorProcess instance
 */
export function processReqChannelMessages (context, reqChannel, operator) {
	context.reqChannel = reqChannel;

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
							await handleResponseMetadata(context, msg.data.decode(), operator);
						} catch (error) {
							handleRequestError(context, error, operator);
						}
						break;
				case 'res-error': {
					const errorData = JSON.parse(msg.data.decode());
					const status = errorData.status ?? 500;
					const errorMsg = errorData.error ?? 'Internal Server Error';
					operator.logger.error(`[${context.requestId}] Responder error: ${errorMsg}`);
					if (context.state === RequestState.WAITING_FIRST_FRAME) {
						const body = JSON.stringify({ error: errorMsg });
						context.responsePromise.resolve(new Response(body, {
							status,
							headers: { 'content-type': 'application/json' },
						}));
					} else if (context.streamController) {
						context.streamController.error(new Error(errorMsg));
					}
					context.state = RequestState.COMPLETED;
					if (context.poolManager && context.poolItemId) {
						await context.poolManager.decrementItemUsage(context.poolItemId);
					}
					break;
				}
				default:
					// con-* messages: applet console output
					if (msg.messageType.startsWith('con-')) {
						const text = msg.data?.decode() ?? '';
						const level = msg.messageType.slice(4); // strip 'con-' prefix
						const appFile = context.app?.split('/').pop();
						operator.logger.asComponent(context.process.id, () =>
							operator.logger.log(level, `[Applet:${appFile || context.requestId}] ${text}`)
						);
					}
					break;
				}
			});
		}
	})();

	// Loop 2: response body chunks (dechunk: false — relay verbatim without reassembly)
	// res-frame carries raw response body data; zero-data + eom:true = end-of-stream.
	(async () => {
		while (true) {
			const msg = await reqChannel.read({ only: 'res-frame', dechunk: false });
			if (!msg) break;
			await msg.process(async () => {
				if (context.state === RequestState.STREAMING_RESPONSE) {
						await handleResFrame(context, msg.data, msg.eom, operator);
					}
			});
		}
	})();

	// Loop 3: bidi-frame relay (dechunk: false — forward chunks verbatim)
	// Only active for bidi requests; runs concurrently with loops 1 and 2.
	(async () => {
		while (true) {
			const msg = await reqChannel.read({ only: 'bidi-frame', dechunk: false });
			if (!msg) break;
			await msg.process(async () => {
				if (context.state === RequestState.BIDI_ACTIVE) {
						await relayBidiFrame(context, msg.data, operator);
					}
			});
		}
	})();
}
