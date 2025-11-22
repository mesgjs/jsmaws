# JSMAWS Configuration And Other Requirements

## General Configuration

- Default path: `jsmaws.slid`
- MIME types for extension-based content types
  - First match wins (if a longer suffix needs to "override" a shorter suffix, it should appear first).
  - Enumerate under `mimeTypes` level, e.g.: `[mimeTypes=['.htm'=text/html '.html'=text/html '.js'=text/javascript '.txt'=text/plain]]`
- `appRoot=/ar1/ar2`: the base path for relative `app` paths (add trailing `/` if missing)
- `root=/dr1/dr2/...`: the default filesystem "root" directory for `path` specifications

## Routing Configuration

- Routes should be under the `routes` level: `[routes=[[spec]...]]`
- Route specifications
  - A `path=part/part/...` to match the URL path
    - `:name` part: match any single path part (a URL part is required; assigned key `['params', name]`)
    - `@name` part: applet path part (URL part must match `name`; assigned key `app`; note that `@` is *not* part of the applet name)
      - The `app` value will be the full applet path ((global root + path or local root) + matching literal `name`)
    - `@*` part: match any applet (for *filesystem* (not *virtual*) routes) (assigned key `app`)
      - The `app` value will be the full applet path ((global root + path or local root) + matching file name)
    - `:?name` (post-applet) part: match any single path part (a URL part is optional; assigned key `['params', name]` if present)
    - `:*` (post-applet) part: matches the remainder of the URL path as a single string (may be empty; assigned key `tail`)
      - `:?` (and technically, another `:*`) could appear after this, but won't match (non-fatal; just won't be (re-)assigned)
      - Anything else after this guarantees the route will never match
    - Other parts: these are (potentially) "filesystem parts" (they must match the next URL part)
      - (In contrast, variable parts are not included in the construction of filesystem paths)
  - A `regex=pattern` to match the URL path
    - Can be used *in addition to* `path` to further constrain matches
    - Can be used *instead of* `path` for purely-regex-based virtual routes
      - When used without a filesystem-based applet match (`@name` or `@*`), `app` *MUST* be specified in the route configuration (user-input alone must not be able to determine which applet is executed)
  - A service `class` of `static`, `int` (internal), or `ext` (external)
  - `ws` flag: set to true (`@t`) if client-initiated websocket connections are allowed
    - IMPORTANT: Service `class` and `ws` are now DEPRECATED in favor or admin-defined responder `pools`
    - A built-in applet with the special name `@static` will handle static asset service
  - Or a response (`response=404` or `response='404 Not Found'`)
    - A redirect response should include a target `href`: `[path=/example response=307 href=https://example.com]`
  - Optional `method=method` or `method=[method...]`
    - Methods are mapped to lower case (e.g. `get`, not `GET`)
    - Default, if not specified, is to match only `get`
    - Can also specify `any` to match any method
    - `read` is short for `method=[get head]`
    - `write` is short for `method=[patch post put]`
    - `modify` is short for `method=[delete patch put]`
  - Optional absolute or relative applet path, `app=/?path/...`
    - This results in a "virtual route" - the URL path is never checked against the filesystem
    - Note: Applet spec via `app` should not be used in the same route as `@name` or `@*` (filesystem-based) applet selection
  - Optional local root, `root=/lr1/lr2/...`
  - Optional response headers (simple list of positional values): `headers=[name=value name=[value...]...]`
    - Value is normally scalar, but might be a sub-list for some headers (e.g. `Set-Cookie`)
  - ~~An applet request (class of `int` or `ext`)~~ All requests should load a JavaScript applet
    - Use the applet path from `app=path` if provided, otherwise use the applet matched from the URL path
    - If the applet ends in `.js`, use the applet path as-is; otherwise, try `.esm.js` (first) and `.js` extensions (second)
    - Create a built-in applet `app=@static` for standard static file service (serving file at root + tail)
- Routes are checked in order; the first matching route is used
- For both virtual and filesystem-based routes, if there are URL components after the applet that are not accounted for (i.e. "consumed") by variable-part matching, the route is deemed non-matching.
- `fsRouting` truthy enables filesystem-based routing (otherwise only virtual routes are supported)
  - Generate a (non-fatal) error and process only virtual routes if filesystem-based routes are encountered when fsRouting is disabled.

## Filesystem Paths For Filesystem-Based Routes

- Let the *pre-path* be defined as any *non-variable* path parts preceding the applet part (`@name` or `@*`)
- For filesystem-based (non-virtual) routes:
  - The applet must be present at `/dr1/dr2/.../pre-path/parts/.../applet{.esm,}.js` if the routing entry *does not have* a local root
  - The applet must be present at `/lr1/lr2/.../applet{.esm,}.js` if routing entry *does have* a local root (the pre-path must match the routing specification, but has no effect on the filesystem path)

## Ideas For Potential Future Enhancements

- As routing is likely to be more volatile than the rest of the server configuration, we might want to consider supporting the use of an optional, secondary configuration file
  - The file name itself would be part of the main configuration file (`routeConfigFile`), and should be relative to the main configuration file's directory if it's not an absolute path (suggested name: `jsmaws-routes.slid`)
- `poolMin` and `poolMax` for creating service instance pools for high-frequency requests

## Additional Specifications And Requirements (2025-11-20)

- Top-level processes are called "operators"
- Operator processes retain privilege for port binding and file access (e.g. for SSL certificates)
- Operators accept requests (in socket "reuse" mode to allow load-balancing at the operator level)
- When `fsRouting` is *disabled*, operators may perform route resolution internally ("internal routing", a performance optimization opportunity)
- When `fsRouting` is *enabled*, operators must spawn "router" sub-processes to handle route resolution ("delegated routing", for security)
- Operators should clearly note (log) whether FS-routing is enabled or disabled upon start or reconfig
- Whichever process level is resolving routes also determines route-variable assignments
- Filesystem-based "router" processes give up privileged uid/gid, but retain read access for FS traversal
  - Routers receive route configuration (initial + updates) via IPC from their operator
- After route resolution, requests are passed to pools of "responder" processes for handling via IPC
- Responders have unprivileged uid/gid and read + write + network access at the process level:
  - For built-in `@static` and other file-based (non-URL-based) applet access
  - For operator IPC and logging
  - For network-based module loading
- Like sub-process-based routers, responders get configuration from their operator via IPC
- Responder processes manage internal worker pools (per configuration) to respond to requests forwarded by the operator after route resolution
  - Individual responder workers should only be granted network access and read access to the specific, route-resolved/assigned applet (when file-based rather than URL-based)
- Do responders need to implement chunking and/or a flow-control handshake/protocol to prevent write-blocking on large responses from stopping their main event loop?


## Answer: Flow-Control for Responder Response Streaming

**Question** (line 92): "Do responders need to implement chunking and/or a flow-control handshake/protocol to prevent write-blocking on large responses from stopping their main event loop?"

**Answer: YES, responders should implement flow-control, but the approach depends on the response size and connection type.**

### Analysis

The concern is valid: if a responder's main event loop sends a large response body to a client with slow network conditions, the write operation could block, preventing the responder from handling other requests or IPC messages.

### Recommended Solution: Tiered Approach

#### **Tier 1: Small Responses (< 64KB) - No Flow Control Needed**
- Write directly to the socket
- Acceptable blocking risk is minimal
- Simplifies implementation for common case (most API responses)

#### **Tier 2: Medium Responses (64KB - 10MB) - Async Write with Backpressure**
- Use Deno's async write operations (non-blocking)
- Monitor write buffer size
- If buffer exceeds threshold, pause reading from IPC until buffer drains
- This is **backpressure handling**, not chunking

#### **Tier 3: Large Responses (> 10MB) - Chunked Streaming**
- Implement chunked transfer encoding (HTTP/1.1 standard)
- Send response headers immediately
- Stream body in chunks (e.g., 64KB chunks)
- Between chunks, process other requests/IPC messages
- Responder workers handle individual chunks asynchronously

### Implementation Strategy

**In the responder process**:

```javascript
// Pseudo-code for response handling
async function sendResponse(clientSocket, response) {
  const bodySize = response.bodySize;
  
  // Tier 1: Small responses
  if (bodySize < 64 * 1024) {
    await clientSocket.write(response.body);
    return;
  }
  
  // Tier 2/3: Larger responses with flow control
  // Send headers first
  await clientSocket.write(formatHeaders(response));
  
  // Stream body with backpressure
  const chunkSize = 64 * 1024;
  let offset = 0;
  
  while (offset < bodySize) {
    const chunk = response.body.slice(offset, offset + chunkSize);
    
    // Check if write buffer is full
    if (clientSocket.writeBufferSize > 1024 * 1024) {
      // Wait for buffer to drain
      await clientSocket.drain();
    }
    
    await clientSocket.write(chunk);
    offset += chunkSize;
    
    // Yield to event loop to process other requests
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
```

### IPC Protocol Implications

**No changes needed to IPC protocol** because:

1. **Request/Response bodies are already separated** from SLID headers (see [`arch/ipc-protocol.md`](ipc-protocol.md))
2. **Responders can stream response bodies** without affecting IPC communication
3. **Worker capacity reporting** (in response messages) already handles queue depth

The responder can:
- Receive a request via IPC
- Start streaming response to client
- Continue processing other IPC messages in parallel
- Report worker availability in the next response message

### Key Design Points

1. **Backpressure, not chunking**: The primary mechanism is monitoring write buffer size and pausing/resuming based on client socket readiness
2. **Async I/O**: Use Deno's async write operations throughout
3. **Yield to event loop**: Between chunks, yield control to allow other requests to be processed
4. **HTTP/1.1 compliance**: Use chunked transfer encoding for large responses (standard HTTP feature)
5. **Per-worker isolation**: Individual workers handle their own responses; main event loop coordinates

### Configuration Consideration

Add optional configuration to `jsmaws.slid` for tuning:

```slid
[(
  # Response chunking configuration
  chunking=[
    maxDirectWrite=65536      # < 64KB: direct write (no flow-control)
    autoChunkThresh=10485760  # >= 10MB: chunked streaming
    chunkSize=65536           # Chunk size for streaming
    maxWriteBuffer=1048576    # 1MB: legacy, unused with timing-based detection
    bpWriteTimeThresh=50      # 50ms: write time indicating backpressure
  ]
)]
```

### Summary

**Implement flow-control YES**, using:
- **Backpressure monitoring** on write buffer size
- **Async writes** for all responses
- **Chunked streaming** for responses > 10MB
- **Event loop yielding** between chunks
- **No changes to IPC protocol** (already supports this)

This approach prevents write-blocking while maintaining simplicity for common cases and leveraging HTTP/1.1 standards for large responses.

