# Client-Side PolyTransport Integration Guide

This guide covers how to integrate with JSMAWS WebSocket bidirectional (bidi) connections from client applications using PolyTransport's `WebSocketTransport` and `NestedTransport`.

## Table of Contents

1. [Overview](#overview)
2. [PolyTransport Architecture](#polytransport-architecture)
3. [Setting Up WebSocketTransport](#setting-up-websockettransport)
4. [Using NestedTransport for Multiplexing](#using-nestedtransport-for-multiplexing)
5. [Sending and Receiving Messages](#sending-and-receiving-messages)
6. [Flow Control Considerations](#flow-control-considerations)
7. [Error Handling](#error-handling)
8. [Complete Example](#complete-example)
9. [Browser Integration](#browser-integration)

---

## Overview

JSMAWS WebSocket connections use a **bidi (bidirectional) protocol** based on PolyTransport. All WebSocket connections in JSMAWS are bidi connections — there is no "plain WebSocket" mode. After the HTTP 101 upgrade, all communication happens via `bidi-frame` messages that carry a `NestedTransport` byte stream.

**Key characteristics:**
- WebSocket upgrade returns HTTP 101 status
- All messages are `bidi-frame` messages (no raw text/binary WebSocket frames)
- `NestedTransport` multiplexes multiple application channels over the single `bidi` relay channel
- Automatic flow control and backpressure handling
- Structured message types within each application channel

**When to use JSMAWS bidi:**
- You need multiplexed channels over one WebSocket connection
- You want structured message types (not just raw text/binary)
- You need automatic flow control and backpressure handling
- Your mod-app uses PolyTransport's `NestedTransport` API

**Important architectural note:**
- The server only directly supports a single (bidirectional) PolyTransport channel named `'bidi'` with a single message type `'bidi-frame'` over the WebSocket
- While not mandatory, this single channel and message type is typically used with a `NestedTransport` to support full PolyTransport functionality (multiple channels, multiple message types) between client and mod-app

---

## PolyTransport Architecture

PolyTransport is a transport-agnostic message-passing library that provides:
- **Channels**: Named, bidirectional message streams
- **Message types**: String-based message type identifiers (e.g., `'data'`, `'control'`)
- **Flow control**: Automatic sliding-window flow control to prevent overwhelming the receiver
- **Multiplexing**: Multiple channels over a single underlying transport
- **Signals**: Simple, event-based signaling for transports and channels (receivers can handle or ignore them at their discretion; flow control budget is released automatically after event dispatch completes)

For JSMAWS bidi connections, the client uses:
1. **`WebSocketTransport`** — wraps a native `WebSocket` to provide PolyTransport's channel API
2. **`NestedTransport`** — multiplexes multiple application channels over a single `bidi-frame` relay channel

**Connection layers:**
```
┌─────────────────────────────────────────────────────────┐
│  Application Channels ('myapp', 'chat', etc.)           │
│  ↕ message types: 'data', 'control', etc.               │
├─────────────────────────────────────────────────────────┤
│  NestedTransport (multiplexing)                         │
│  ↕ message type: 'bidi-frame'                           │
├─────────────────────────────────────────────────────────┤
│  WebSocketTransport ('bidi' channel)                    │
│  ↕ WebSocket frames                                     │
├─────────────────────────────────────────────────────────┤
│  Native WebSocket (wss://...)                           │
└─────────────────────────────────────────────────────────┘
```

---

## Setting Up WebSocketTransport

### Installation

PolyTransport can be cloned from the official GitHub repository or imported using the JsDelivr CDN:

```javascript
// Deno / Node.js (ESM) — clone the repo locally
import { WebSocketTransport } from './poly-transport/transport/websocket.esm.js';
import { NestedTransport } from './poly-transport/transport/nested.esm.js';

// Browser (via CDN) — use cdn.jsdelivr.net/gh/mesgjs/poly-transport
import { WebSocketTransport } from 'https://cdn.jsdelivr.net/gh/mesgjs/poly-transport/transport/websocket.esm.js';
import { NestedTransport } from 'https://cdn.jsdelivr.net/gh/mesgjs/poly-transport/transport/nested.esm.js';
```

**Installation options:**
- **Local clone:** `git clone https://github.com/mesgjs/poly-transport.git` (recommended for development)
- **CDN:** `https://cdn.jsdelivr.net/gh/mesgjs/poly-transport/` (for browser use)

### Creating the WebSocketTransport

```javascript
// 1. Create a native WebSocket connection
const ws = new WebSocket('wss://example.com/my-bidi-endpoint');

// 2. Wrap it in a WebSocketTransport
const wsTransport = new WebSocketTransport({ ws });

// 3. Accept all incoming channels (required for NestedTransport)
wsTransport.addEventListener('newChannel', (event) => event.accept());

// 4. Start the transport
await wsTransport.start();
console.log('WebSocketTransport started');
```

**Key points:**
- The native `WebSocket` must be in the `CONNECTING` or `OPEN` state when passed to `WebSocketTransport`
- The `newChannel` event listener is required to accept channels opened by the server
- `start()` must be called before using the transport

---

## Using NestedTransport for Multiplexing

JSMAWS uses a **relay channel** named `'bidi'` to carry `bidi-frame` messages. These messages are the byte stream for a `NestedTransport`, which multiplexes multiple application channels.

### Opening the Relay Channel

```javascript
// Open the 'bidi' channel on the WebSocketTransport
const bidiChannel = await wsTransport.requestChannel('bidi');
await bidiChannel.addMessageTypes(['bidi-frame']);
```

**Important:** The channel name must be `'bidi'` — this is the pre-designated relay channel name used by JSMAWS. The server will only accept this channel name.

### Creating the NestedTransport

```javascript
// Establish NestedTransport over the bidi channel
const nestedTransport = new NestedTransport({
    channel: bidiChannel,
    messageType: 'bidi-frame',
});

// Accept all incoming channels
nestedTransport.addEventListener('newChannel', (event) => {
    event.accept();
});

// Start the nested transport
await nestedTransport.start();
console.log('NestedTransport started');
```

### Opening Application Channels

Once the `NestedTransport` is running, you can open application channels. The channel name must match the name used by the mod-app:

```javascript
// Open the application channel (must match the mod-app's channel name)
const appChannel = await nestedTransport.requestChannel('myapp');
await appChannel.addMessageTypes(['data', 'control']);
```

**Channel naming:**
- The channel name is arbitrary but must match between client and mod-app
- Common names: `'echo'`, `'chat'`, `'data'`, `'rpc'`
- Multiple channels can be opened over the same `NestedTransport`

---

## Sending and Receiving Messages

### Sending Messages

Use `channel.write(messageType, data)` to send messages:

```javascript
// Send a text message
await appChannel.write('data', 'Hello, server!');

// Send JSON
await appChannel.write('data', JSON.stringify({ type: 'ping', timestamp: Date.now() }));

// Send binary data (Uint8Array)
const binaryData = new Uint8Array([1, 2, 3, 4]);
await appChannel.write('data', binaryData);
```

**Notes:**
- `messageType` is a string (e.g., `'data'`, `'control'`) — must be registered via `addMessageTypes()`
- `data` can be a string or `Uint8Array`
- `write()` returns a Promise that resolves when the message is sent (flow control is handled automatically)

### Receiving Messages

Use `channel.read()` to receive messages:

```javascript
// Read a message (with UTF-8 decoding)
const msg = await appChannel.read({ only: 'data', decode: true });
if (!msg) {
    console.log('Channel closed');
    return;
}

// Process the message
await msg.process(() => {
    console.log('Received:', msg.text);
});
```

**Message object fields:**

| Field | Type | Description |
|-------|------|-------------|
| `messageType` | string | Message type (e.g., `'data'`) |
| `text` | string | Message data as UTF-8 string (if `decode: true`) |
| `data` | VirtualBuffer | Message data as binary (if `decode: false`) |
| `eom` | boolean | End-of-message flag (always `true` for single-chunk messages) |
| `process(callback)` | function | Releases flow control after processing |
| `done()` | function | Releases flow control without processing |

**Important:** Always call `await msg.process(callback)` or `await msg.done()` after reading a message. This releases the flow-control budget and allows additional messages to be delivered.

### Read Loop Pattern

```javascript
while (true) {
    const msg = await appChannel.read({ only: 'data', decode: true });
    if (!msg) break; // Channel closed

    await msg.process(() => {
        console.log('Received:', msg.text);
    });
}

console.log('Connection closed');
```

---

## Flow Control Considerations

PolyTransport uses a **sliding-window flow control** mechanism to prevent overwhelming the receiver. This is handled automatically, but there are a few things to be aware of:

1. **Always release flow control:** Call `msg.process()` or `msg.done()` after reading each message. Failing to do so will block the pipeline.

2. **Backpressure is automatic:** If the receiver is slow, `write()` will block until the receiver has processed enough messages to free up flow-control budget.

3. **No manual credit tracking:** Unlike some protocols, you don't need to manually track or send flow-control credits. PolyTransport handles this internally.

4. **Channel closure:** When the channel closes, `read()` returns `null`. This is the normal way to detect connection closure.

---

## Error Handling

### Connection Errors

```javascript
try {
    const ws = new WebSocket('wss://example.com/my-endpoint');
    const wsTransport = new WebSocketTransport({ ws });

    wsTransport.addEventListener('newChannel', (event) => event.accept());

    await wsTransport.start();

    // ... use the transport ...

} catch (error) {
    console.error('Connection error:', error.message);
}
```

### Channel Closure

```javascript
const msg = await appChannel.read({ only: 'data', decode: true });
if (!msg) {
    console.log('Channel closed by server');
    return;
}
```

### Graceful Shutdown

```javascript
// Close the nested transport (closes all application channels)
await nestedTransport.stop();

// Close the WebSocket transport
await wsTransport.stop();

console.log('Connection closed gracefully');
```

---

## Complete Example

Here's a complete example of a client connecting to a JSMAWS bidi endpoint:

```javascript
import { WebSocketTransport } from '@poly-transport/transport/websocket.esm.js';
import { NestedTransport } from '@poly-transport/transport/nested.esm.js';

async function connectToBidiEndpoint() {
    const url = 'wss://example.com/my-bidi-endpoint';

    console.log(`Connecting to ${url}...`);

    try {
        // 1. Create native WebSocket
        const ws = new WebSocket(url);

        // 2. Create WebSocketTransport
        const wsTransport = new WebSocketTransport({ ws });

        wsTransport.addEventListener('newChannel', (event) => event.accept());

        await wsTransport.start();
        console.log('WebSocketTransport started');

        // 3. Open the 'bidi' relay channel
        const bidiChannel = await wsTransport.requestChannel('bidi');
        await bidiChannel.addMessageTypes(['bidi-frame']);

        // 4. Create NestedTransport over the bidi channel
        const nestedTransport = new NestedTransport({
            channel: bidiChannel,
            messageType: 'bidi-frame',
        });

        nestedTransport.addEventListener('newChannel', (event) => {
            event.accept();
        });

        await nestedTransport.start();
        console.log('NestedTransport started');

        // 5. Open the application channel
        const appChannel = await nestedTransport.requestChannel('myapp');
        await appChannel.addMessageTypes(['data']);

        // 6. Send and receive messages
        await appChannel.write('data', 'Hello, server!');

        const msg = await appChannel.read({ only: 'data', decode: true });
        if (msg) {
            await msg.process(() => {
                console.log('Server replied:', msg.text);
            });
        }

        // 7. Close the connection
        await nestedTransport.stop();
        await wsTransport.stop();
        console.log('Connection closed');

    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Run the example
connectToBidiEndpoint();
```

---

## Browser Integration

PolyTransport works in modern browsers that support ES modules and the native `WebSocket` API.

### Using a CDN

```html
<!DOCTYPE html>
<html>
<head>
    <title>JSMAWS Bidi Client</title>
</head>
<body>
    <h1>JSMAWS Bidi Client</h1>
    <button id="connect">Connect</button>
    <button id="send">Send Message</button>
    <button id="disconnect">Disconnect</button>
    <pre id="log"></pre>

    <script type="module">
        import { WebSocketTransport } from 'https://cdn.jsdelivr.net/gh/mesgjs/poly-transport/transport/websocket.esm.js';
        import { NestedTransport } from 'https://cdn.jsdelivr.net/gh/mesgjs/poly-transport/transport/nested.esm.js';

        let wsTransport, nestedTransport, appChannel;

        const log = (msg) => {
            document.getElementById('log').textContent += msg + '\n';
        };

        document.getElementById('connect').addEventListener('click', async () => {
            try {
                const ws = new WebSocket('wss://example.com/my-bidi-endpoint');

                wsTransport = new WebSocketTransport({ ws });
                wsTransport.addEventListener('newChannel', (event) => event.accept());

                await wsTransport.start();
                log('WebSocketTransport started');

                const bidiChannel = await wsTransport.requestChannel('bidi');
                await bidiChannel.addMessageTypes(['bidi-frame']);

                nestedTransport = new NestedTransport({
                    channel: bidiChannel,
                    messageType: 'bidi-frame',
                });

                nestedTransport.addEventListener('newChannel', (event) => {
                    event.accept();
                });

                await nestedTransport.start();
                log('NestedTransport started');

                appChannel = await nestedTransport.requestChannel('myapp');
                await appChannel.addMessageTypes(['data']);

                log('Connected!');

                // Start read loop
                (async () => {
                    while (true) {
                        const msg = await appChannel.read({ only: 'data', decode: true });
                        if (!msg) break;

                        await msg.process(() => {
                            log('Received: ' + msg.text);
                        });
                    }
                    log('Connection closed');
                })();

            } catch (error) {
                log('Error: ' + error.message);
            }
        });

        document.getElementById('send').addEventListener('click', async () => {
            if (appChannel) {
                await appChannel.write('data', 'Hello from browser!');
                log('Sent: Hello from browser!');
            }
        });

        document.getElementById('disconnect').addEventListener('click', async () => {
            if (nestedTransport) await nestedTransport.stop();
            if (wsTransport) await wsTransport.stop();
            log('Disconnected');
        });
    </script>
</body>
</html>
```

### Browser Compatibility

PolyTransport requires:
- ES modules (`<script type="module">`)
- Native `WebSocket` API
- `async`/`await` support
- `Uint8Array` and `TextEncoder`/`TextDecoder`

**Supported browsers:**
- Chrome 61+
- Firefox 60+
- Safari 11+
- Edge 79+

---

## See Also

- [`docs/mod-app-development.md`](mod-app-development.md) — Writing mod-apps for JSMAWS (server-side)
- [`examples/clients/ws-echo.esm.js`](../examples/clients/ws-echo.esm.js) — Complete Deno client example
- [`examples/apps/websocket-echo.esm.js`](../examples/apps/websocket-echo.esm.js) — Server-side WebSocket echo mod-app
- [PolyTransport README](../resources/poly-transport/README.md) — Full PolyTransport API documentation
