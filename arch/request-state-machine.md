[APPROVED]

# Request State Machine Design

## Problem Statement

The current operator request handling uses handler swapping to manage different phases of request processing. This approach is fragile and error-prone:

1. **Handler Swapping**: Constantly clearing and re-registering handlers (lines 630, 767, 831, 1009)
2. **State in Code**: Request state encoded in code flow rather than data
3. **Race Conditions**: Handler cleared before next message arrives (WebSocket bug)
4. **Debugging Difficulty**: Hard to trace which handler is active at any time

## Current Flow (Problematic)

```
forwardToServiceProcess()
  ├─> Register handler #1 (capture first frame)
  ├─> Send request
  ├─> Wait for first frame
  ├─> Clear handler #1  ← PROBLEM: Race condition if next frame already sent
  └─> Branch by mode:
      ├─> response/stream: handleResponseStream()
      │   ├─> Clear handler (again)
      │   └─> Register handler #2 (stream frames)
      └─> bidi: handleBidiUpgrade()
          ├─> Clear handler
          ├─> Register handler #3 (wait for params)
          ├─> Wait for params
          ├─> Clear handler
          └─> Register handler #4 (bidi frames)
```

## Proposed Solution: Data-Driven State Machine

### Core Principle

**State is data, not code flow.** The message handler examines the current state (stored as data) and the incoming message content to determine the next state and actions. A single handler remains registered for the entire request lifecycle.

### State Definitions

```javascript
const RequestState = {
  WAITING_FIRST_FRAME: 'waiting_first_frame',
  WAITING_BIDI_PARAMS: 'waiting_bidi_params',
  STREAMING_RESPONSE: 'streaming_response',
  BIDI_ACTIVE: 'bidi_active',
  COMPLETED: 'completed'
};
```

### State Data Structure

```javascript
class RequestContext {
  constructor(requestId, process, poolName, routeSpec, req) {
    this.requestId = requestId;
    this.process = process;
    this.poolName = poolName;
    this.routeSpec = routeSpec;
    this.originalRequest = req;  // For WebSocket upgrade
    
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
```

### Single Handler Pattern

```javascript
// ONE handler registered at start, never cleared until completion
function createRequestHandler(context, operator) {
  return async (message, binaryData) => {
    if (message instanceof Error) {
      handleError(context, message, operator);
      return;
    }
    
    // State machine dispatch based on CURRENT STATE (data)
    switch (context.state) {
      case RequestState.WAITING_FIRST_FRAME:
        await handleFirstFrame(context, message, binaryData, operator);
        break;
        
      case RequestState.WAITING_BIDI_PARAMS:
        await handleBidiParams(context, message, binaryData, operator);
        break;
        
      case RequestState.STREAMING_RESPONSE:
        await handleStreamFrame(context, message, binaryData, operator);
        break;
        
      case RequestState.BIDI_ACTIVE:
        await handleBidiFrame(context, message, binaryData, operator);
        break;
        
      case RequestState.COMPLETED:
        // Ignore late messages
        operator.logger.debug(`Ignoring message for completed request ${context.requestId}`);
        break;
        
      default:
        operator.logger.error(`Unknown state: ${context.state}`);
    }
  };
}
```

### State Handlers (Message-Driven)

```javascript
async function handleFirstFrame(context, message, binaryData, operator) {
  // Extract data from MESSAGE (not from code flow)
  const mode = message.fields.at('mode');
  const status = message.fields.at('status', 200);
  const headers = operator.convertHeaders(message.fields.at('headers'));
  const keepAlive = message.fields.at('keepAlive', false);
  const final = message.fields.at('final', false);
  
  // Store in context (state as data)
  context.mode = mode;
  context.status = status;
  context.headers = headers;
  context.keepAlive = keepAlive;
  
  // Transition based on MESSAGE DATA
  if (mode === 'bidi' && status === 101) {
    // Transition: need protocol params before creating Response
    context.state = RequestState.WAITING_BIDI_PARAMS;
    operator.logger.debug(`[${context.requestId}] WAITING_FIRST_FRAME → WAITING_BIDI_PARAMS`);
    // Don't resolve responsePromise yet
    
  } else if (mode === 'response' && final && !keepAlive) {
    // Transition: single-frame response, complete immediately
    context.state = RequestState.COMPLETED;
    operator.logger.debug(`[${context.requestId}] WAITING_FIRST_FRAME → COMPLETED`);
    
    // Create Response and resolve promise
    const response = new Response(binaryData, { status, headers });
    context.responsePromise.resolve(response);
    
  } else if (mode === 'response' || mode === 'stream') {
    // Transition: multi-frame response, start streaming
    context.state = RequestState.STREAMING_RESPONSE;
    operator.logger.debug(`[${context.requestId}] WAITING_FIRST_FRAME → STREAMING_RESPONSE`);
    
    // Create ReadableStream
    const stream = new ReadableStream({
      start(controller) {
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

async function handleBidiParams(context, message, binaryData, operator) {
  // Extract protocol parameters from MESSAGE
  const initialCredits = message.fields.at('initialCredits');
  const maxChunkSize = message.fields.at('maxChunkSize');
  const maxBytesPerSecond = message.fields.at('maxBytesPerSecond');
  const idleTimeout = message.fields.at('idleTimeout');
  const maxBufferSize = message.fields.at('maxBufferSize');
  
  // Validate we got params
  if (!initialCredits || !maxChunkSize) {
    const error = new Error('Missing protocol parameters in bidi params frame');
    context.responsePromise.reject(error);
    context.state = RequestState.COMPLETED;
    return;
  }
  
  // Store params in context (state as data)
  context.protocolParams = {
    initialCredits,
    maxChunkSize,
    maxBytesPerSecond,
    idleTimeout,
    maxBufferSize
  };
  
  // Transition to active bidi
  context.state = RequestState.BIDI_ACTIVE;
  operator.logger.debug(`[${context.requestId}] WAITING_BIDI_PARAMS → BIDI_ACTIVE`);
  
  // Complete WebSocket upgrade
  const response = await operator.completeWebSocketUpgrade(context);
  context.responsePromise.resolve(response);
}

async function handleStreamFrame(context, message, binaryData, operator) {
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
    operator.logger.debug(`[${context.requestId}] STREAMING_RESPONSE → COMPLETED`);
  }
}

async function handleBidiFrame(context, message, binaryData, operator) {
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
  }
}

function handleError(context, error, operator) {
  operator.logger.error(`[${context.requestId}] Error in state ${context.state}: ${error.message}`);
  
  // Reject promise if not yet resolved
  if (context.state === RequestState.WAITING_FIRST_FRAME || 
      context.state === RequestState.WAITING_BIDI_PARAMS) {
    context.responsePromise.reject(error);
  }
  
  // Close stream if active
  if (context.streamController) {
    context.streamController.error(error);
  }
  
  // Close WebSocket if active
  if (context.bidiState?.socket) {
    context.bidiState.socket.close(1011, 'Internal error');
  }
  
  context.state = RequestState.COMPLETED;
}
```

### Main Request Flow

```javascript
async forwardToServiceProcess(req, route, match, remote) {
  const requestId = generateMessageId('WREQ');
  
  // Create context with initial state
  const context = new RequestContext(
    requestId,
    process,
    poolName,
    routeSpec,
    req
  );
  
  // Store context
  this.requestContexts.set(requestId, context);
  
  // Register SINGLE handler (never cleared until completion)
  process.ipcConn.setRequestHandler(
    requestId,
    createRequestHandler(context, this),
    reqTimeout
  );
  
  // Send request
  await process.ipcConn.writeMessage(requestMsg, bodyBytes);
  
  // Return Response promise that will be resolved by state machine
  return context.responsePromise.promise;
}
```

### State Transition Diagram

```
WAITING_FIRST_FRAME
  ├─> [mode=response, final=true] → COMPLETED
  │   └─> resolve(Response with body)
  │
  ├─> [mode=response|stream, final=false] → STREAMING_RESPONSE
  │   └─> resolve(Response with ReadableStream)
  │
  └─> [mode=bidi, status=101] → WAITING_BIDI_PARAMS
      └─> (don't resolve yet)

WAITING_BIDI_PARAMS
  └─> [has initialCredits] → BIDI_ACTIVE
      └─> resolve(Response with WebSocket)

STREAMING_RESPONSE
  └─> [final=true, keepAlive=false] → COMPLETED
      └─> close stream

BIDI_ACTIVE
  └─> [final=true, keepAlive=false] → COMPLETED
      └─> close socket

COMPLETED
  └─> (terminal state, ignore messages)
```

### Implementation Benefits

1. **Single Handler**: Registered once at request start, cleared only at completion
2. **State as Data**: Current state stored in `context.state`, not encoded in code flow
3. **Message-Driven**: State transitions determined by examining message content
4. **No Handler Swapping**: Eliminates race conditions from clearing/re-registering
5. **Promise.withResolvers**: Clean bridge between callback and async/await
6. **Clear Transitions**: Explicit state changes with logging
7. **Debuggable**: Can inspect context.state at any time
8. **Testable**: Can verify state machine logic independently
9. **Race-Free**: Handler always present to receive messages

### Context Management

```javascript
class OperatorProcess {
  constructor() {
    // ...
    this.requestContexts = new Map(); // requestId -> RequestContext
  }
  
  // Cleanup completed requests
  cleanupRequest(requestId) {
    const context = this.requestContexts.get(requestId);
    if (context && context.state === RequestState.COMPLETED) {
      context.process.ipcConn.clearRequestHandler(requestId);
      this.requestContexts.delete(requestId);
      this.logger.debug(`[${requestId}] Context cleaned up`);
    }
  }
}
```

## Migration Strategy

1. **Phase 1**: Create RequestContext class and state constants
2. **Phase 2**: Implement state handler functions
3. **Phase 3**: Refactor forwardToServiceProcess to use context
4. **Phase 4**: Remove old handler-swapping code
5. **Phase 5**: Add state transition logging
6. **Phase 6**: Add comprehensive tests

## Testing Strategy

1. **Unit Tests**: Test each state handler independently
2. **State Transition Tests**: Verify all valid transitions
3. **Integration Tests**: Test full request flows (response, stream, bidi)
4. **Race Condition Tests**: Rapid message sequences
5. **Error Handling Tests**: Verify cleanup in all states
6. **WebSocket Tests**: Verify bidi flow works correctly

## Bug Fixes

This design fixes the current WebSocket hang bug:

**Current Bug**: Handler cleared after first frame (line 630), but responder immediately sends protocol params frame. Operator has no handler to receive it, so hangs waiting for params.

**Fix**: Single persistent handler receives both first frame and params frame. State machine transitions from WAITING_FIRST_FRAME → WAITING_BIDI_PARAMS → BIDI_ACTIVE based on message content.

## Related Documents

- [`arch/bidirectional-flow-control.md`](bidirectional-flow-control.md) - Bidi protocol specification
- [`arch/unified-protocol-assessment.md`](unified-protocol-assessment.md) - Protocol design