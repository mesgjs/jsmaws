/**
 * JSMAWS Operator Request State Machine
 * Handles request lifecycle with data-driven state transitions
 *
 * This module implements a state machine for request handling that eliminates
 * handler swapping and race conditions. State is stored as data, not code flow.
 *
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { MessageType, createFrame } from './ipc-protocol.esm.js';

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

		// Protocol parameters (for bidi)
		this.protocolParams = null;
	}
}

/**
 * Handle first app response frame
 */
export async function handleFirstFrame (context, message, binaryData, operator) {
	// Extract connection data from message
	const mode = message.fields.at('mode');
	const status = message.fields.at('status', 200);
	const headers = operator.convertHeaders(message.fields.at('headers'));
	const keepAlive = message.fields.at('keepAlive', false);
	const final = message.fields.at('final', false);

	// Save in context
	context.mode = mode;
	context.status = status;
	context.headers = headers;
	context.keepAlive = keepAlive;

	operator.logger.debug(`[${context.requestId}] First frame: mode=${mode}, status=${status}, final=${final}, keepAlive=${keepAlive}`);

	// Transition based on mode, state
	if (mode === 'bidi' && status === 101) {
		// Bidi upgrade: immediately initialize connection
		// The first frame (status 101) should have no data (policy enforced by responder)
		context.state = RequestState.BIDI_ACTIVE;
		operator.logger.debug(`[${context.requestId}] was WAITING_FIRST_FRAME now BIDI_ACTIVE`);

		// Initialize bidi connection immediately (sets up WebSocket)
		await initializeBidiConnection(context, message, binaryData, operator);

	} else if (mode === 'response' && final && !keepAlive) {
		// Transition: single-frame, single-chunk response, complete immediately
		context.state = RequestState.COMPLETED;
		operator.logger.debug(`[${context.requestId}] was WAITING_FIRST_FRAME now COMPLETED`);

		// Create Response and resolve promise
		const response = new Response(binaryData, { status, headers });
		context.responsePromise.resolve(response);

		// Mark pool item idle now that request is complete
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.markItemIdle(context.poolItemId);
		}

	} else if (mode === 'response' || mode === 'stream') {
		// Transition: multi-chunk and/or multi-frame response, start streaming
		context.state = RequestState.STREAMING_RESPONSE;
		operator.logger.debug(`[${context.requestId}] was WAITING_FIRST_FRAME now STREAMING_RESPONSE`);

		// Create ReadableStream
		const stream = new ReadableStream({
			start (controller) {
				context.streamController = controller;

				// Enqueue first data if present
				if (binaryData && binaryData.length > 0) {
					controller.enqueue(binaryData);
				}

				// Close if first frame was final
				if (final && !keepAlive) {
					controller.close();
					context.state = RequestState.COMPLETED;
				}
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
 * Initialize bidirectional connection - derive params from configuration
 * Called directly from handleFirstFrame when status 101 is received
 */
export async function initializeBidiConnection (context, message, binaryData, operator) {
	// Derive params from configuration (same as responder will use)
	// routeSpec already contains pool name
	const bidiParams = operator.configuration.getBidiParams({
		routeSpec: context.routeSpec
	});

	// Store params in context (state as data)
	context.protocolParams = {
		initialCredits: bidiParams.initialCredits,
		maxChunkSize: bidiParams.maxChunkSize,
		maxBytesPerSecond: bidiParams.maxBytesPerSecond,
		idleTimeout: bidiParams.idleTimeout,
		maxBufferSize: bidiParams.maxBufferSize
	};

	// Complete transport-specific upgrade (currently only WebSocket supported)
	// Future: Add support for other bidirectional transports here
	const response = await completeBidiUpgrade(context, operator);
	context.responsePromise.resolve(response);

	// Note: First frame (status 101) has no data by policy
	// Subsequent data frames will be handled by handleBidiFrame
}

/**
 * Handle stream frame in state machine
 */
export async function handleStreamFrame (context, message, binaryData, operator) {
	const final = message.fields.at('final', false);
	const keepAlive = message.fields.at('keepAlive', context.keepAlive);

	// Enqueue data
	if (binaryData && binaryData.length > 0) {
		context.streamController.enqueue(binaryData);
	}

	// Check for completion
	if (final && !keepAlive) {
		context.streamController.close();
		context.state = RequestState.COMPLETED;
		operator.logger.debug(`[${context.requestId}] was STREAMING_RESPONSE now COMPLETED`);

		// Mark pool item idle now that stream is closed
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.markItemIdle(context.poolItemId);
		}
	}
}

/**
 * Handle bidi frame in state machine
 */
export async function handleBidiFrame (context, message, binaryData, operator) {
	const final = message.fields.at('final', false);
	const keepAlive = message.fields.at('keepAlive', true);

	// Forward to WebSocket
	if (binaryData && binaryData.length > 0) {
		context.bidiState.socket.send(binaryData);
	}

	// Check for completion
	if (final && !keepAlive) {
		context.bidiState.socket.close(1000, 'Normal closure');
		context.state = RequestState.COMPLETED;
		operator.logger.debug(`[${context.requestId}] BIDI_ACTIVE → COMPLETED`);

		// Mark pool item idle now that connection is closed
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.markItemIdle(context.poolItemId);
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

	// Close WebSocket if active
	if (context.bidiState?.socket) {
		try {
			context.bidiState.socket.close(1011, 'Internal error');
		} catch (e) {
			// Ignore if already closed
		}
	}

	context.state = RequestState.COMPLETED;
}

/**
 * Create request handler for state machine
 * Returns a single handler that remains registered for entire request lifecycle
 */
export function createRequestHandler (context, operator) {
	return async (message, binaryData) => {
		if (message instanceof Error) {
			handleRequestError(context, message, operator);
			return;
		}

		// State machine dispatch based on CURRENT STATE (data)
		switch (context.state) {
			case RequestState.WAITING_FIRST_FRAME:
				await handleFirstFrame(context, message, binaryData, operator);
				break;

			case RequestState.STREAMING_RESPONSE:
				await handleStreamFrame(context, message, binaryData, operator);
				break;

			case RequestState.BIDI_ACTIVE:
				await handleBidiFrame(context, message, binaryData, operator);
				break;

			case RequestState.COMPLETED:
				// Ignore late messages
				operator.logger.debug(`[${context.requestId}] Ignoring message for completed request`);
				break;

			default:
				operator.logger.error(`[${context.requestId}] Unknown state: ${context.state}`);
		}
	};
}

/**
 * Complete bidirectional transport upgrade (helper for state machine)
 * Currently only WebSocket is supported, but designed to be extensible
 */
async function completeBidiUpgrade (context, operator) {
	const { requestId, originalRequest, protocolParams } = context;

	// Verify WebSocket upgrade headers
	const connectionHeader = originalRequest.headers.get('connection');
	if (!connectionHeader || !connectionHeader.toLowerCase().includes('upgrade')) {
		throw new Error('Invalid Connection header for WebSocket upgrade');
	}

	// Upgrade to WebSocket
	const { socket, response } = Deno.upgradeWebSocket(originalRequest);

	// Track connection state
	const connState = {
		socket,
		process: context.process,
		requestId,
		outboundCredits: protocolParams.initialCredits,
		inboundCredits: protocolParams.initialCredits,
		maxCredits: protocolParams.initialCredits,
		maxChunkSize: protocolParams.maxChunkSize,
		maxBytesPerSecond: protocolParams.maxBytesPerSecond,
		idleTimeout: protocolParams.idleTimeout,
		maxBufferSize: protocolParams.maxBufferSize,
		lastActivity: Date.now(),
	};

	// Store in context
	context.bidiState = connState;

	// Handle WebSocket messages from client
	socket.onmessage = async (event) => {
		try {
			await operator.handleClientBidiMessage(requestId, event.data, connState);
		} catch (error) {
			operator.logger.error(`Bidi client message error: ${error.message}`);
			socket.close(1011, 'Internal error');
			operator.bidiConnections.delete(requestId);
		}
	};

	// Handle WebSocket close from client
	socket.onclose = async () => {
		operator.logger.debug(`Bidi connection ${requestId} closed by client`);
		operator.bidiConnections.delete(requestId);
		context.state = RequestState.COMPLETED;

		// Notify responder that connection is closed by sending final frame
		try {
			const closeFrame = createFrame(requestId, {
				data: null,
				final: true,
				keepAlive: false
			});
			await connState.process.ipcConn.writeMessage(closeFrame);
		} catch (error) {
			operator.logger.error(`Failed to send close frame to responder: ${error.message}`);
		}

		// Mark pool item idle now that connection is closed
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.markItemIdle(context.poolItemId);
		}

		operator.cleanupRequestContext(requestId);
	};

	// Handle WebSocket errors
	socket.onerror = async (error) => {
		operator.logger.error(`Bidi connection ${requestId} error: ${error}`);
		operator.bidiConnections.delete(requestId);
		context.state = RequestState.COMPLETED;

		// Mark pool item idle on error
		if (context.poolManager && context.poolItemId) {
			await context.poolManager.markItemIdle(context.poolItemId);
		}

		operator.cleanupRequestContext(requestId);
	};

	// Store in legacy bidiConnections map for compatibility
	operator.bidiConnections.set(requestId, connState);

	return response;
}

/**
 * Cleanup completed request context
 */
export function cleanupRequestContext (requestId, requestContexts, logger) {
	const context = requestContexts.get(requestId);
	if (context && context.state === RequestState.COMPLETED) {
		context.process.ipcConn.clearRequestHandler(requestId);
		requestContexts.delete(requestId);
		logger.debug(`[${requestId}] Context cleaned up`);
	}
}
