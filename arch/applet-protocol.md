# Applet Communication Protocol

**Status**: [DRAFT]

## Overview

Applets are JavaScript modules that handle HTTP requests, similar to PHP scripts or Java servlets. Each applet runs as a Web Worker within a responder process and communicates via `postMessage`.

## Applet Architecture

### What is an Applet?

An **applet** is a JavaScript module that:
- Runs as a Web Worker (isolated execution context)
- Receives HTTP-like request messages via `postMessage`
- Returns HTTP-like response messages via `postMessage`
- Has restricted permissions (read-only for file-based applets, and network (always) for possible additional module loading)
- Is loaded fresh for each request (one-shot execution for security)

### Applet Lifecycle

```
1. Responder process receives request from operator
2. Responder process spawns applet as Web Worker (new Worker(appletPath))
3. Applet module loads (benefits from process-level module cache)
4. Responder sends request message to applet via postMessage
5. Applet processes request and sends response via postMessage
6. Responder forwards response to operator
7. Applet worker terminates (one-shot execution via self.close())
```

**Important**: There is NO intermediate "responder-worker" wrapper. The responder process directly spawns applet workers.

### Security Model

- **One-shot execution**: Each request gets a fresh worker (prevents state leakage)
- **Restricted permissions**: 
  - File-based applets: read-only access to applet file
  - All applets: network access for (additional) module loading
  - No write access (except via IPC to responder)
  - No process spawning
  - No environment variable access
- **Process-level module cache**: Deno caches modules at process level (not worker level)
  - First load: disk I/O + parsing (~5-10ms)
  - Cached load: memory lookup (~0.1ms)
  - 50-100x speedup for cache hits

## Message Protocol

### Request Message (Responder → Applet)

The responder (process) sends an HTTP-like request to the applet (worker):

```javascript
{
  type: 'request',
  id: 'req-12345',           // Unique request ID
  method: 'GET',             // HTTP method (uppercase)
  path: '/api/users/123',    // Full URL path
  headers: {                 // HTTP headers as object
    'Content-Type': 'application/json',
    'Authorization': 'Bearer token123',
    'User-Agent': 'Mozilla/5.0...'
  },
  params: {                  // Route parameters from routing
    userId: '123'
  },
  query: {                   // Query string parameters
    filter: 'active',
    page: '1'
  },
  tail: '/extra/path',       // Tail path (if route has :* component)
  body: Uint8Array           // Request body as binary data (or null)
}
```

### Response Message (Applet → Responder)

The applet sends an HTTP-like response back:

```javascript
{
  type: 'response',
  id: 'req-12345',           // Same request ID
  status: 200,               // HTTP status code
  statusText: 'OK',          // HTTP status text (optional)
  headers: {                 // Response headers as object
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  },
  body: Uint8Array           // Response body as binary data (or null)
}
```

### Error Response (Applet → Responder)

If the applet encounters an error:

```javascript
{
  type: 'error',
  id: 'req-12345',           // Same request ID
  error: 'Error message',    // Error description
  stack: 'Error stack...'    // Stack trace (optional, for debugging)
}
```

The responder converts this to a 500 Internal Server Error response.

## Applet Implementation

### Minimal Applet Example

```javascript
// hello-world.esm.js
// Simple applet that returns "Hello, World!"

self.onmessage = async (event) => {
  const { type, id, method, path, headers, params, query, tail, body } = event.data;
  
  if (type !== 'request') {
    return;
  }
  
  try {
    // Process request
    const responseBody = new TextEncoder().encode('Hello, World!');
    
    // Send response
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': responseBody.length.toString()
      },
      body: responseBody
    });
    
    // Terminate after handling request (one-shot)
    self.close();
  } catch (error) {
    // Send error response
    self.postMessage({
      type: 'error',
      id,
      error: error.message,
      stack: error.stack
    });
    
    // Terminate even on error
    self.close();
  }
};
```

### Echo Applet Example

```javascript
// echo.esm.js
// Applet that echoes request details back as JSON

self.onmessage = async (event) => {
  const { type, id, method, path, headers, params, query, tail, body } = event.data;
  
  if (type !== 'request') {
    return;
  }
  
  try {
    // Echo request details
    const response = {
      method,
      path,
      headers,
      params,
      query,
      tail,
      bodySize: body ? body.length : 0
    };
    
    const responseBody = new TextEncoder().encode(JSON.stringify(response, null, 2));
    
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: responseBody
    });
    
    self.close();
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message
    });
    self.close();
  }
};
```

### API Applet Example

```javascript
// api-users.esm.js
// RESTful API applet for user management

self.onmessage = async (event) => {
  const { type, id, method, path, headers, params, query, body } = event.data;
  
  if (type !== 'request') {
    return;
  }
  
  try {
    let response;
    
    // Route based on method
    switch (method) {
      case 'GET':
        if (params.userId) {
          // GET /api/users/:userId
          response = await getUser(params.userId);
        } else {
          // GET /api/users
          response = await listUsers(query);
        }
        break;
        
      case 'POST':
        // POST /api/users
        const userData = JSON.parse(new TextDecoder().decode(body));
        response = await createUser(userData);
        break;
        
      case 'PUT':
        // PUT /api/users/:userId
        const updateData = JSON.parse(new TextDecoder().decode(body));
        response = await updateUser(params.userId, updateData);
        break;
        
      case 'DELETE':
        // DELETE /api/users/:userId
        response = await deleteUser(params.userId);
        break;
        
      default:
        response = {
          status: 405,
          body: { error: 'Method Not Allowed' }
        };
    }
    
    // Send response
    const responseBody = new TextEncoder().encode(JSON.stringify(response.body));
    
    self.postMessage({
      type: 'response',
      id,
      status: response.status,
      headers: {
        'Content-Type': 'application/json'
      },
      body: responseBody
    });
    
    self.close();
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message
    });
    self.close();
  }
};

// Helper functions (would typically import from shared modules)
async function getUser(userId) {
  // Implementation...
  return { status: 200, body: { id: userId, name: 'John Doe' } };
}

async function listUsers(query) {
  // Implementation...
  return { status: 200, body: [{ id: '1', name: 'John Doe' }] };
}

async function createUser(userData) {
  // Implementation...
  return { status: 201, body: { id: '2', ...userData } };
}

async function updateUser(userId, updateData) {
  // Implementation...
  return { status: 200, body: { id: userId, ...updateData } };
}

async function deleteUser(userId) {
  // Implementation...
  return { status: 204, body: null };
}
```

## Responder Process Implementation

The responder process directly spawns applet workers (no intermediate wrapper):

```javascript
// responder-process.esm.js (simplified)
class ResponderProcess {
  async handleWebRequest(id, fields, binaryData) {
    const appletPath = fields.at('app');
    const method = fields.at('method');
    const path = fields.at('path');
    const headers = fields.at('headers') || {};
    const params = fields.at('params') || {};
    const query = fields.at('query') || {};
    const tail = fields.at('tail', '');
    
    // Spawn applet as Web Worker
    const appletWorker = new Worker(appletPath, {
      type: 'module',
      deno: {
        permissions: {
          read: appletPath.startsWith('http') ? false : [appletPath],
          net: true,  // Always allow network for module loading
          write: false,
          run: false,
          env: false
        }
      }
    });
    
    // Handle applet response
    const response = await new Promise((resolve, reject) => {
      const reqTimeout = this.config.at(['pools', this.poolName, 'reqTimeout'], 30);
      const timeout = setTimeout(() => {
        appletWorker.terminate();
        reject(new Error('Request timeout'));
      }, reqTimeout * 1000);
      
      appletWorker.onmessage = (event) => {
        clearTimeout(timeout);
        const { type, status, headers, body, chunked, keepAlive } = event.data;
        
        if (type === 'error') {
          reject(new Error(event.data.error));
        } else if (type === 'response') {
          resolve({ status, headers, body, chunked, keepAlive });
        }
        // Handle 'chunk', 'stream-data', 'ws-upgrade', etc.
      };
      
      appletWorker.onerror = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      
      // Send request to applet
      appletWorker.postMessage({
        type: 'request',
        id,
        method,
        path,
        headers,
        params,
        query,
        tail,
        body: binaryData
      });
    });
    
    // Forward response to operator via IPC
    await this.sendResponse(id, response);
  }
}
```

**Key Points:**
- No `responder-worker.esm.js` file needed
- Responder process directly uses `new Worker(appletPath)`
- Applets are self-contained Web Workers
- Built-in `@static` applet handles static file serving

## Design Rationale

### Why Web Workers?

1. **Isolation**: Each applet runs in isolated context (no shared state)
2. **Security**: Restricted permissions per worker
3. **Parallelism**: Multiple applets can run concurrently
4. **Standard API**: Web Worker API is well-defined and portable

### Why One-Shot Execution?

1. **Security**: Prevents state leakage between requests
2. **Mesgjs compatibility**: Avoids module version conflicts
3. **Simplicity**: No worker lifecycle management needed
4. **Module caching**: Process-level cache provides performance benefit

### Why postMessage?

1. **Standard**: Web Worker standard communication mechanism
2. **Structured cloning**: Automatic serialization of complex objects
3. **Binary data**: Efficient transfer of Uint8Array bodies
4. **Async**: Non-blocking communication

## Comparison to Other Systems

### PHP (Apache mod_php)

- **PHP**: Script loaded per request, executed in Apache process
- **JSMAWS**: Applet loaded per request, executed in Web Worker
- **Similarity**: Both load fresh code per request
- **Difference**: JSMAWS uses process-level module cache for performance

### Java Servlets (Tomcat)

- **Tomcat**: Servlet instance reused across requests
- **JSMAWS**: Applet worker created fresh per request
- **Similarity**: Both use HTTP-like request/response model
- **Difference**: JSMAWS prioritizes security over instance reuse

### Node.js (Express)

- **Express**: Single process handles all requests
- **JSMAWS**: Multi-process with worker pools
- **Similarity**: Both use JavaScript
- **Difference**: JSMAWS provides process isolation and privilege separation

## Chunked Responses and Streaming

### Terminology

- **Chunking**: Breaking large responses into smaller pieces for flow-control and backpressure management
  - Used for large files, database exports, generated reports
  - Connection closes after all chunks sent
  - Technical necessity, not a feature
  
- **Streaming**: Long-lived connections with ongoing data delivery
  - Used for WebSocket, Server-Sent Events, live logs, real-time updates
  - Connection stays open (`keepAlive: true`)
  - Application feature, not just technical necessity

### Chunked Response Protocol

For large responses that need to be broken into chunks:

#### Initial Response (Headers + First Chunk or Headers Only)

```javascript
// Option 1: Send headers with first chunk
self.postMessage({
  type: 'response',
  id: 'req-12345',
  status: 200,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': '10485760'  // Total size if known
  },
  body: firstChunk,  // First chunk of data
  chunked: true      // More chunks coming
});

// Option 2: Send headers only, chunks follow
self.postMessage({
  type: 'response',
  id: 'req-12345',
  status: 200,
  headers: {
    'Content-Type': 'application/octet-stream',
    'Transfer-Encoding': 'chunked'
  },
  body: null,        // No body yet
  chunked: true      // Chunks will follow
});
```

#### Subsequent Chunks

```javascript
// Send remaining chunks
for (const chunk of remainingData) {
  self.postMessage({
    type: 'chunk',
    id: 'req-12345',
    data: chunk  // Uint8Array
  });
  
  // Yield to event loop between chunks
  await new Promise(resolve => setTimeout(resolve, 0));
}
```

#### Final Chunk (End of Response)

```javascript
// Signal end of chunked response
self.postMessage({
  type: 'chunk',
  id: 'req-12345',
  data: null,   // null = no more data
  final: true   // End of response
});

self.close();  // Worker terminates
```

### Streaming Protocol (Long-Lived Connections)

For streaming connections that should stay open:

#### Initial Response (Establish Stream)

```javascript
self.postMessage({
  type: 'response',
  id: 'req-12345',
  status: 200,
  headers: {
    'Content-Type': 'text/event-stream',  // SSE example
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  },
  body: null,
  keepAlive: true  // Connection stays open for streaming
});
```

#### Stream Data Messages

```javascript
// Send data as it becomes available
function sendUpdate(data) {
  self.postMessage({
    type: 'stream-data',
    id: 'req-12345',
    data: new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
  });
}

// Example: Send updates every second
const interval = setInterval(() => {
  sendUpdate({ timestamp: Date.now(), value: Math.random() });
}, 1000);

// Keep worker alive (don't call self.close())
```

#### Close Stream

```javascript
// When stream should end
clearInterval(interval);

self.postMessage({
  type: 'stream-close',
  id: 'req-12345'
});

self.close();  // Now worker can terminate
```

### Chunked Response Example (Large File)

```javascript
// large-file.esm.js
// Applet that serves a large file in chunks

self.onmessage = async (event) => {
  const { type, id, path } = event.data;
  
  if (type !== 'request') return;
  
  try {
    const file = await Deno.open(path);
    const stat = await file.stat();
    
    // Send initial response with headers
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size.toString()
      },
      body: null,
      chunked: true  // Will send chunks
    });
    
    // Read and send file in 64KB chunks
    const chunkSize = 64 * 1024;
    const buffer = new Uint8Array(chunkSize);
    
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;
      
      const chunk = buffer.slice(0, bytesRead);
      self.postMessage({
        type: 'chunk',
        id,
        data: chunk
      });
      
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // End of file
    self.postMessage({
      type: 'chunk',
      id,
      data: null,
      final: true
    });
    
    file.close();
    self.close();
  } catch (error) {
    self.postMessage({ type: 'error', id, error: error.message });
    self.close();
  }
};
```

### Streaming Example (Server-Sent Events)

```javascript
// live-logs.esm.js
// Applet that streams log updates in real-time

self.onmessage = async (event) => {
  const { type, id, params } = event.data;
  
  if (type !== 'request') return;
  
  try {
    // Send initial SSE response
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      },
      body: null,
      keepAlive: true  // Keep connection open
    });
    
    // Simulate log streaming
    const logFile = params.logFile;
    let lastPosition = 0;
    
    const streamLogs = setInterval(async () => {
      try {
        // Read new log entries
        const file = await Deno.open(logFile);
        await file.seek(lastPosition, Deno.SeekMode.Start);
        
        const buffer = new Uint8Array(4096);
        const bytesRead = await file.read(buffer);
        
        if (bytesRead && bytesRead > 0) {
          const newLogs = new TextDecoder().decode(buffer.slice(0, bytesRead));
          lastPosition += bytesRead;
          
          // Send as SSE
          self.postMessage({
            type: 'stream-data',
            id,
            data: new TextEncoder().encode(`data: ${newLogs}\n\n`)
          });
        }
        
        file.close();
      } catch (error) {
        console.error('Log read error:', error);
      }
    }, 1000);
    
    // Handle stream close (would need additional message type)
    // For now, stream runs until worker terminates
    
  } catch (error) {
    self.postMessage({ type: 'error', id, error: error.message });
    self.close();
  }
};
```

### WebSocket Protocol

WebSocket connections require bidirectional communication and long-lived workers.

#### WebSocket Upgrade Request

```javascript
// Applet receives upgrade request
self.onmessage = async (event) => {
  const { type, id, method, path, headers } = event.data;
  
  if (type === 'request' && headers['Upgrade']?.toLowerCase() === 'websocket') {
    // Validate WebSocket upgrade
    const key = headers['Sec-WebSocket-Key'];
    const version = headers['Sec-WebSocket-Version'];
    
    if (!key || version !== '13') {
      self.postMessage({
        type: 'response',
        id,
        status: 400,
        headers: {},
        body: new TextEncoder().encode('Bad Request')
      });
      self.close();
      return;
    }
    
    // Accept WebSocket upgrade
    self.postMessage({
      type: 'ws-upgrade',
      id,
      protocol: headers['Sec-WebSocket-Protocol'] || null  // Optional sub-protocol
    });
    
    // Connection is now upgraded - handle WebSocket messages
    // Worker stays alive (keepAlive: true implicit for WebSocket)
  }
};
```

#### WebSocket Message Handling

```javascript
// After upgrade, handle WebSocket messages
self.onmessage = (event) => {
  const { type, id, data, opcode } = event.data;
  
  if (type === 'ws-message') {
    // Process incoming WebSocket message
    // opcode: 1 = text, 2 = binary, 8 = close, 9 = ping, 10 = pong
    
    if (opcode === 1) {
      // Text message
      const text = new TextDecoder().decode(data);
      const response = processTextMessage(text);
      
      // Send text response
      self.postMessage({
        type: 'ws-send',
        id,
        opcode: 1,  // text
        data: new TextEncoder().encode(response)
      });
    } else if (opcode === 2) {
      // Binary message
      const response = processBinaryMessage(data);
      
      // Send binary response
      self.postMessage({
        type: 'ws-send',
        id,
        opcode: 2,  // binary
        data: response
      });
    } else if (opcode === 8) {
      // Close frame
      self.postMessage({
        type: 'ws-close',
        id,
        code: 1000,  // Normal closure
        reason: 'Goodbye'
      });
      self.close();
    } else if (opcode === 9) {
      // Ping - respond with pong
      self.postMessage({
        type: 'ws-send',
        id,
        opcode: 10,  // pong
        data: data
      });
    }
  }
};
```

#### WebSocket Example (Chat Server)

```javascript
// chat.esm.js
// WebSocket chat applet

const clients = new Set();

self.onmessage = async (event) => {
  const { type, id, method, headers, data, opcode } = event.data;
  
  // Handle WebSocket upgrade
  if (type === 'request' && headers['Upgrade']?.toLowerCase() === 'websocket') {
    const key = headers['Sec-WebSocket-Key'];
    
    if (!key) {
      self.postMessage({
        type: 'response',
        id,
        status: 400,
        body: new TextEncoder().encode('Bad Request')
      });
      self.close();
      return;
    }
    
    // Accept upgrade
    self.postMessage({
      type: 'ws-upgrade',
      id,
      protocol: 'chat'
    });
    
    // Add client
    clients.add(id);
    
    // Broadcast join message
    broadcast(id, JSON.stringify({
      type: 'join',
      clientId: id,
      timestamp: Date.now()
    }));
    
    return;
  }
  
  // Handle WebSocket messages
  if (type === 'ws-message') {
    if (opcode === 1) {
      // Text message - broadcast to all clients
      const message = new TextDecoder().decode(data);
      broadcast(id, message);
    } else if (opcode === 8) {
      // Client disconnecting
      clients.delete(id);
      
      // Broadcast leave message
      broadcast(id, JSON.stringify({
        type: 'leave',
        clientId: id,
        timestamp: Date.now()
      }));
      
      self.postMessage({
        type: 'ws-close',
        id,
        code: 1000,
        reason: 'Goodbye'
      });
    }
  }
};

function broadcast(senderId, message) {
  const data = new TextEncoder().encode(message);
  
  for (const clientId of clients) {
    if (clientId !== senderId) {
      self.postMessage({
        type: 'ws-send',
        id: clientId,
        opcode: 1,  // text
        data: data
      });
    }
  }
}
```

### Responder Process WebSocket Support

The responder process must handle WebSocket upgrade and message forwarding:

```javascript
class ResponderProcess {
  async handleWebRequest(id, fields, binaryData) {
    const appletPath = fields.at('app');
    const appletWorker = new Worker(appletPath, { /* permissions */ });
    
    return new Promise((resolve, reject) => {
      let isWebSocket = false;
      let activeWorker = null;
      
      appletWorker.onmessage = (event) => {
        const { type, status, headers, protocol, opcode, data, code, reason } = event.data;
        
        if (type === 'ws-upgrade') {
          // WebSocket upgrade accepted
          isWebSocket = true;
          activeWorker = appletWorker;  // Keep worker alive
          
          // Send upgrade response to operator
          this.sendWebSocketUpgrade(id, protocol);
          
          // Store worker for future WebSocket messages
          this.activeWebSockets.set(id, appletWorker);
        } else if (type === 'ws-send') {
          // Forward WebSocket message to operator/client
          this.sendWebSocketData(id, opcode, data);
        } else if (type === 'ws-close') {
          // Close WebSocket connection
          this.sendWebSocketClose(id, code, reason);
          this.activeWebSockets.delete(id);
          appletWorker.terminate();
        } else if (type === 'response') {
          // Regular HTTP response
          resolve({ status, headers, body: event.data.body });
        } else if (type === 'error') {
          reject(new Error(event.data.error));
        }
      };
      
      // Send request to applet
      appletWorker.postMessage({
        type: 'request',
        id,
        ...fields.toObject(),
        body: binaryData
      });
    });
  }
  
  // Forward WebSocket message from operator to applet
  handleWebSocketMessage(id, opcode, data) {
    const worker = this.activeWebSockets.get(id);
    if (worker) {
      worker.postMessage({
        type: 'ws-message',
        id,
        opcode,
        data
      });
    }
  }
}
```

## References

- [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [Deno Worker Permissions](https://deno.land/manual/runtime/workers)
- [`arch/worker-module-caching.md`](worker-module-caching.md) - Module caching and affinity
- [`arch/ipc-protocol.md`](ipc-protocol.md) - IPC protocol between processes
- [`arch/requirements.md`](requirements.md) - Overall system requirements

[supplemental keywords: servlet, CGI, FastCGI, WSGI, ASGI, request handler, HTTP handler, web application, microservice]