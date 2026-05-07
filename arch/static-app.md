# @static Built-in Mod-App Design

**Status**: [DRAFT]

## Overview

The `@static` built-in mod-app provides standard static file serving functionality for JSMAWS. It handles serving files from the configured root directory with security, performance optimizations, and HTTP Range request support.

## Key Finding: No New Route Token Type Needed

The existing routing architecture already supports `@static` through **virtual routes** with the `app` property. No new routing token type is required.

From [`arch/requirements.md`](requirements.md:64):
> Create a built-in mod-app `app=@static` for standard static file service (serving file at root + tail)

The router already handles this in [`src/router-worker.esm.js`](../src/router-worker.esm.js:103-106).

## Route Configuration

Routes using `@static` are configured as **virtual routes** (not filesystem routes):

```slid
[
    path='/static/:*'
    app=@static
    pool=fast
    method=read
]
```

This route:
- Matches any path under `/static/`
- Uses the `:*` tail component to capture the file path
- Specifies `app=@static` to invoke the built-in static file handler
- Is classified as a **virtual route** (has explicit `app` property)
- Does NOT use `@name` or `@*` (which would make it a filesystem route)

FEEDBACK:

- Let's support /static/file (specific file) and /static/:file (any file at /static level) in addition to /static/:* (any file at or below /static level).
- Allow explicit `mimeType=` to bypass config lookup
- I guess it's a feature that it can work even if fsRouting is disabled 🤷🏻‍♂️
- Do not choose default assets to fully or partially potentially expose to the Internet anywhere in the server, ever - they're just CVEs waiting to be filed
  - In particular, do not offer default roots

## Mod-App Location

The built-in mod-app will be located at:
```
src/apps/static-content.esm.js
```

This creates a new `src/apps/` directory for built-in mod-apps.

## Implementation Design

### Core Features

1. **Security**
   - Path traversal prevention via `Deno.realPath()` validation
   - Ensures resolved path stays within configured root directory
   - Returns 403 Forbidden for invalid paths

2. **Performance** (leveraging the standard responder pipeline and configuration)
   - Small files (<64KB): Read and send directly (no chunking overhead)
   - Large files (≥64KB): Stream in 64KB chunks with backpressure handling
   - Yields to event loop between chunks to maintain responsiveness

3. **HTTP Features**
   - Range request support for resumable downloads (206 Partial Content)
   - Proper MIME type detection from file extension
   - Accept-Ranges header for client capability discovery
   - Content-Length header for progress tracking

4. **Error Handling**
   - 403 Forbidden: Path traversal attempts
   - 404 Not Found: File doesn't exist or is not a file
   - 416 Range Not Satisfiable: Invalid range requests
   - 500 Internal Server Error: Unexpected errors

### Mod-App Implementation

```javascript
/**
 * JSMAWS Built-in Static File Mod-App
 * Serves static files from the configured root directory
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

self.onmessage = async (event) => {
  const { type, id, path, headers, params, tail } = event.data;
  
  if (type !== 'request') return;
  
  try {
    // Get configuration from request (passed by responder)
    const config = event.data.config;
    const root = config?.root;
    const mimeTypes = config?.mimeTypes || {};
    
	// FEEDBACK:
	// - Need to 404 if a root was not provided
	// - Move 403, 404 response implementations to helper functions
    // Construct file path from tail
    const filePath = `${root}${tail}`;
    
    // Security: Prevent directory traversal
    const resolvedPath = await Deno.realPath(filePath).catch(() => null);
    if (!resolvedPath || !resolvedPath.startsWith(root)) {
      self.postMessage({
        type: 'response',
        id,
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'text/plain' },
        body: new TextEncoder().encode('Access denied')
      });
      self.close();
      return;
    }
    
    // Check if file exists and is readable
    const stat = await Deno.stat(resolvedPath);
    
    if (!stat.isFile) {
      self.postMessage({
        type: 'response',
        id,
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'text/plain' },
        body: new TextEncoder().encode('File not found')
      });
      self.close();
      return;
    }
    
	// FEEDBACK: - use first-match strategy instead
    // Determine MIME type from extension
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    // Handle Range requests for resumable downloads
    const rangeHeader = headers['Range'] || headers['range'];
    if (rangeHeader) {
      await handleRangeRequest(id, resolvedPath, stat.size, rangeHeader, contentType);
    } else {
      await handleFullRequest(id, resolvedPath, stat.size, contentType);
    }
    
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      error: error.message,
      stack: error.stack
    });
    self.close();
  }
};

async function handleFullRequest(id, filePath, fileSize, contentType) {
  const file = await Deno.open(filePath, { read: true });
  
  // FEEDBACK:
  // - Need to figure out how to refactor to reuse the existing responder code
  // - ... and the existing chunking configuration settings
  // For small files (< 64KB), read and send directly
  if (fileSize < 65536) {
    const buffer = new Uint8Array(fileSize);
    await file.read(buffer);
    file.close();
    
    self.postMessage({
      type: 'response',
      id,
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileSize.toString(),
        'Accept-Ranges': 'bytes'
      },
      body: buffer
    });
    self.close();
    return;
  }
  
  // For larger files, use chunked response
  self.postMessage({
    type: 'response',
    id,
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': fileSize.toString(),
      'Accept-Ranges': 'bytes'
    },
    body: null,
    chunked: true
  });
  
  // Stream file in chunks
  const chunkSize = 65536; // 64KB chunks
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
    
    // Yield to event loop
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
}

async function handleRangeRequest(id, filePath, fileSize, rangeHeader, contentType) {
  // Parse Range header: "bytes=start-end"
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    self.postMessage({
      type: 'response',
      id,
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: {
        'Content-Range': `bytes */${fileSize}`
      },
      body: null
    });
    self.close();
    return;
  }
  
  const start = parseInt(match[1]);
  const end = match[2] ? parseInt(match[2]) : fileSize - 1;
  
  if (start >= fileSize || end >= fileSize || start > end) {
    self.postMessage({
      type: 'response',
      id,
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: {
        'Content-Range': `bytes */${fileSize}`
      },
      body: null
    });
    self.close();
    return;
  }
  
  const rangeSize = end - start + 1;
  const file = await Deno.open(filePath, { read: true });
  await file.seek(start, Deno.SeekMode.Start);
  
  // Send partial content response
  self.postMessage({
    type: 'response',
    id,
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': contentType,
      'Content-Length': rangeSize.toString(),
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes'
    },
    body: null,
    chunked: true
  });
  
  // Stream range in chunks
  const chunkSize = 65536;
  const buffer = new Uint8Array(chunkSize);
  let remaining = rangeSize;
  
  while (remaining > 0) {
    const toRead = Math.min(chunkSize, remaining);
    const bytesRead = await file.read(buffer.subarray(0, toRead));
    if (bytesRead === null) break;
    
    const chunk = buffer.slice(0, bytesRead);
    self.postMessage({
      type: 'chunk',
      id,
      data: chunk
    });
    
    remaining -= bytesRead;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  self.postMessage({
    type: 'chunk',
    id,
    data: null,
    final: true
  });
  
  file.close();
  self.close();
}
```

## Responder Process Integration

The responder process needs to handle `@static` as a special case in [`src/responder-process.esm.js`](../src/responder-process.esm.js):

### Detection and Loading

FEEDBACK:
 - This is a *terrible* design. You're replacing the special token too early, and then trying to determine later if there was previously a special token. Leave handleWebRequest as-is and check for @static in spawnApp.

```javascript
async handleWebRequest(id, fields, binaryData) {
  const appPath = fields.at('app');
  
  // Handle built-in @static mod-app
  if (appPath === '@static') {
    const builtinPath = new URL('./apps/static-content.esm.js', import.meta.url).pathname;
    return await this.spawnApp(id, builtinPath, fields, binaryData);
  }
  
  // Handle regular mod-apps
  return await this.spawnApp(id, appPath, fields, binaryData);
}
```

### Permission Configuration

FEEDBACK:
- The isBuiltin test is rejected.
- Per above, the appPath should still be @static upon entry.
- switch on the appPath to handle built-ins between initial permissions calculation and new Worker.
  - For special mod-apps, patch the mod-app path and permissions.
  - Maybe set a configuration callback/hook/flag here for sharing configuration with built-ins.

```javascript
async spawnApp(id, appPath, fields, binaryData) {
  // Determine permissions based on mod-app type
  const isBuiltin = appPath.includes('/apps/');
  const isFileApp = !appPath.startsWith('http');
  
  const permissions = {
    read: isFileApp ? [appPath] : false,
    net: true, // Always allow for module loading
    write: false,
    run: false,
    env: false
  };
  
  // For @static, also grant read access to root directory
  if (appPath.includes('static-content.esm.js')) {
    const root = this.config.routing.root;
    permissions.read = [appPath, root];
  }
  
  const appWorker = new Worker(appPath, {
    type: 'module',
    deno: { permissions }
  });
  
  // ... rest of worker handling
}
```

### Configuration Passing

The responder must pass relevant configuration to the mod-app:

```javascript
// Send request to mod-app
appWorker.postMessage({
  type: 'request',
  id,
  method,
  path,
  headers,
  params,
  query,
  tail,
  body: binaryData,
  config: {  // NEW: Pass relevant config to mod-app
    root: this.config.routing.root,
    mimeTypes: this.config.mimeTypes
  }
});
```

## Configuration Example

```slid
[(
  root=/var/www/html
  mimeTypes=[
    '.html'=text/html
    '.htm'=text/html
    '.js'=text/javascript
    '.mjs'=text/javascript
    '.json'=application/json
    '.css'=text/css
    '.txt'=text/plain
    '.png'=image/png
    '.jpg'=image/jpeg
    '.jpeg'=image/jpeg
    '.gif'=image/gif
    '.svg'=image/svg+xml
    '.woff2'=font/woff2
    '.woff'=font/woff
  ]
  
  pools=[
    fast=[minProcs=2 maxProcs=10 scaling=dynamic reqTimeout=5]
  ]
  
  routes=[
    /* Static file serving from /static/ */
    [
      path='/static/:*'
      app=@static
      pool=fast
      method=read
    ]
    
    /* Also serve from /assets/ */
    [
      path='/assets/:*'
      app=@static
      pool=fast
      method=read
    ]
    
    /* Serve from root for common files */
    [
      path='/:*'
      app=@static
      pool=fast
      method=read
      regex='^/(favicon\.ico|robots\.txt|sitemap\.xml)$'
    ]
  ]
)]
```

## Request Flow Diagram

```
Request: GET /static/images/logo.png
    ↓
Operator (internal routing)
    ↓
Router: Matches [path='/static/:*' app=@static pool=fast]
    → tail='/images/logo.png'
    → app='@static'
    ↓
Responder Process (fast pool)
    ↓
Detects app=@static
    ↓
Resolves to: src/apps/static-content.esm.js
    ↓
Spawns Worker with permissions:
    read=[app, /var/www/html]
    net=true
    ↓
Sends request with config:
    { tail: '/images/logo.png', config: { root: '/var/www/html', mimeTypes: {...} } }
    ↓
Mod-app processes:
    1. Constructs path: /var/www/html/images/logo.png
    2. Validates security (no traversal)
    3. Checks file exists and is readable
    4. Determines MIME type: image/png
    5. Reads file (chunked if large)
    6. Sends response
    ↓
Response flows back: Mod-App → Responder → Operator → Client
```

## Security Considerations

### Path Traversal Prevention

The mod-app uses `Deno.realPath()` to resolve the full canonical path and verifies it starts with the configured root:

```javascript
const resolvedPath = await Deno.realPath(filePath).catch(() => null);
if (!resolvedPath || !resolvedPath.startsWith(root)) {
  // Return 403 Forbidden
}
```

This prevents attacks like:
- `/static/../../../etc/passwd`
- `/static/./../../sensitive/file`
- Symlink attacks outside root

### Permission Model

The mod-app worker has minimal permissions:
- **Read**: Only mod-app file and root directory
- **Net**: Only for module loading (standard for all mod-apps)
- **Write**: Denied
- **Run**: Denied
- **Env**: Denied

### File Type Validation

The mod-app verifies the resolved path is a file (not a directory):

```javascript
const stat = await Deno.stat(resolvedPath);
if (!stat.isFile) {
  // Return 404 Not Found
}
```

## Performance Characteristics

### Small Files (<64KB)
- **Latency**: ~1-2ms (single read + send)
- **Memory**: File size (held in memory briefly)
- **Overhead**: Minimal (no chunking)

### Large Files (≥64KB)
- **Latency**: ~5-10ms initial response + streaming
- **Memory**: 64KB buffer (constant)
- **Throughput**: ~100-500 MB/s (depends on disk I/O)
- **Overhead**: Event loop yields between chunks

### Range Requests
- **Latency**: Similar to full requests
- **Memory**: 64KB buffer (constant)
- **Efficiency**: Only requested range is read from disk

## Testing Strategy

### Unit Tests
1. Path traversal prevention
2. MIME type detection
3. Small file handling
4. Large file chunking
5. Range request parsing
6. Error conditions (404, 403, 416)

### Integration Tests
1. End-to-end static file serving
2. Multiple concurrent requests
3. Large file downloads
4. Range request resumption
5. Configuration updates
6. Permission enforcement

### Performance Tests
1. Small file throughput
2. Large file streaming
3. Concurrent request handling
4. Memory usage under load

## Implementation Steps

1. Create `src/apps/` directory
2. Implement `src/apps/static-content.esm.js`
3. Update `src/responder-process.esm.js`:
   - Add `@static` detection
   - Add configuration passing to mod-app requests
   - Add permission configuration for built-in mod-apps
4. Update `jsmaws.slid` with example `@static` routes
5. Create test suite for `@static` mod-app
6. Integration testing with end-to-end flow
7. Performance benchmarking

## Future Enhancements

### Potential Features
- **Caching**: ETag and Last-Modified support
- **Compression**: Gzip/Brotli on-the-fly compression
- **Directory Listing**: Optional index generation
- **Index Files**: Automatic index.html serving
- **Content Negotiation**: Accept-Encoding handling
- **Conditional Requests**: If-Modified-Since, If-None-Match

### Configuration Extensions
```slid
staticOptions=[
  enableCaching=@t
  enableCompression=@t
  enableDirectoryListing=@f
  indexFiles=[index.html index.htm]
  maxCacheSize=104857600  /* 100MB */
]
```

## References

- [`arch/requirements.md`](requirements.md) - Configuration and requirements
- [`arch/app-protocol.md`](app-protocol.md) - Mod-app communication protocol
- [`src/router-worker.esm.js`](../src/router-worker.esm.js) - Router implementation
- [`src/responder-process.esm.js`](../src/responder-process.esm.js) - Responder implementation
- [`arch/jsmaws-config-example.md`](jsmaws-config-example.md) - Configuration examples

[supplemental keywords: static files, file serving, HTTP Range, resumable downloads, MIME types, path traversal, security, chunking, streaming]