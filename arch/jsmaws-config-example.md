# JSMAWS Configuration Example with Pool Architecture

This document provides an example configuration for JSMAWS using the new pool-based architecture. The actual `jsmaws.slid` file will be updated in Code mode.

## Complete Configuration Example

```slid
[(
	/* JSMAWS Server Configuration */
	
	/* Network Configuration */
	httpPort=8080
	httpsPort=8443
	hostname=localhost
	
	/* SSL Certificate Configuration */
	/* Set noSSL=@t (true) for development/localhost (HTTP-only operation) */
	noSSL=@t
	
	/* Uncomment and set these when SSL certificates are available */
	/* certFile=/path/to/cert.pem */
	/* keyFile=/path/to/key.pem */
	
	/* SSL certificate monitoring interval in hours (default: 1) */
	/* sslCheckIntervalHours=1 */
	
	/* ACME Challenge Directory for Let's Encrypt */
	acmeChallengeDir=/var/www/acme-challenge
	
	/* Logging Configuration */
	logging=[
		target=console
		level=info
		format=apache
	]
	
	/* Process Management (numeric UID/GID) */
	uid=33      /* www-data user (typically 33 on Debian/Ubuntu) */
	gid=33      /* www-data group */
	
	/* MIME Types Configuration */
	/* First match wins - longer suffixes should appear first */
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
	
	/* Application Root Directory */
	/* Base path for relative mod-app paths */
	appRoot=/var/www/apps
	
	/* Default Filesystem Root */
	/* Base path for static files and filesystem-based routes */
	root=/var/www/html
	
	/* Pool Configuration */
	/* User-configurable process pools for different workload types */
	pools=[
		/* Fast pool: Short-duration, high-frequency requests */
		fast=[
			minProcs=2
			maxProcs=10
			scaling=dynamic
			maxReqs=1000
			idleTimeout=300
			reqTimeout=5
		]
		
		/* Standard pool: General application requests */
		standard=[
			minProcs=1
			maxProcs=20
			scaling=dynamic
			maxReqs=100
			idleTimeout=600
			reqTimeout=60
		]
		
		/* Stream pool: Long-lived streaming connections */
		stream=[
			minProcs=1
			maxProcs=50
			scaling=ondemand
			maxReqs=1
			conTimeout=3600
			reqTimeout=0
		]
	]
	
	/* Response Chunking Configuration */
	/* Controls how responders handle large response bodies */
	/* See arch/requirements.md for detailed flow-control answer */
	chunking=[
		maxDirectWrite=65536      /* < 64KB: direct write (no flow-control) */
		autoChunkThresh=10485760  /* >= 10MB: chunked streaming */
		chunkSize=65536           /* Chunk size for streaming */
		maxWriteBuffer=1048576    /* 1MB: legacy, unused with timing-based detection */
		bpWriteTimeThresh=50      /* 50ms: write time indicating backpressure */
	]
	
	/* Routing Configuration */
	/* Routes are checked in order; first match wins */
	/* Routes now reference pools by name */
	routes=[
		/* Static file serving - fast pool */
		[
			path='/static/*'
			pool=fast
			handler=static
			method=read
		]
		
		/* Health check endpoint - fast pool */
		[
			path='/api/health'
			pool=fast
			app=@health
			method=read
		]
		
		/* API routes - standard pool */
		[
			path='/api/@*/:?action'
			pool=standard
			method=any
		]
		
		/* Admin routes - standard pool with longer timeout */
		[
			path='/admin/@*/:?action'
			pool=standard
			method=any
		]
		
		/* WebSocket support - stream pool */
		[
			path='/ws/@*'
			pool=stream
			type=websocket
			method=any
		]
		
		/* Catch-all 404 response */
		[
			regex='^/.*'
			response=404
		]
	]
)]
```

## Key Changes from Previous Configuration

### 1. Pool Definitions Replace Class-Specific Configuration

**Old (class-based)**:
```slid
intPool=[minSize=2 maxSize=10 idleTimeout=300 maxRequests=1000]
extPool=[maxSize=50 timeout=60]
```

**New (user-configurable pools)**:
```slid
pools=[
	fast=[minProcs=2 maxProcs=10 scaling=dynamic maxReqs=1000 reqTimeout=5]
	standard=[minProcs=1 maxProcs=20 scaling=dynamic maxReqs=100 reqTimeout=60]
	stream=[minProcs=1 maxProcs=50 scaling=ondemand maxReqs=1 conTimeout=3600]
]
```

### 2. Routes Reference Pools by Name

**Old**:
```slid
[path='api/@*' class=int method=any]
[path='admin/@*' class=ext method=any]
[path='ws/@*' class=ext ws=@t method=any]
```

**New**:
```slid
[path='/api/@*' pool=standard method=any]
[path='/admin/@*' pool=standard method=any]
[path='/ws/@*' pool=stream type=websocket method=any]
```

### 3. Terser Parameter Names

- `minSize` → `minProcs`
- `maxSize` → `maxProcs`
- `maxRequests` → `maxReqs`
- `timeout` → `reqTimeout` (request timeout) or `conTimeout` (connection timeout)
- `class` → `pool` (in routes)
- `ws` → `type=websocket` (more explicit)

### 4. New Pool Parameters

- **`scaling`**: Strategy for pool size management (`static`, `dynamic`, `ondemand`)
- **`conTimeout`**: Connection timeout for long-lived connections (WebSocket, SSE)
- **`reqTimeout`**: Per-request timeout (0 = no timeout)

### 5. Response Chunking Configuration

New response chunking parameters control how responders handle large response bodies to prevent write-blocking:

- **`maxDirectWrite`**: Maximum response size for direct write without flow-control (default: 65536 bytes / 64KB)
  - Responses smaller than this are written directly without backpressure monitoring
  - Tier 1: Direct write (no overhead)
  
- **`autoChunkThresh`**: Threshold at which chunked streaming is automatically activated (default: 10485760 bytes / 10MB)
  - Responses larger than this are streamed in chunks
  - Between `maxDirectWrite` and `autoChunkThresh`: Tier 2 backpressure monitoring
  - At or above `autoChunkThresh`: Tier 3 chunked streaming
  
- **`chunkSize`**: Size of chunks for streaming large responses (default: 65536 bytes / 64KB)
  - Used when streaming responses >= `autoChunkThresh`
  - Smaller chunks = more responsive but more overhead
  - Larger chunks = less overhead but less responsive
  
- **`maxWriteBuffer`**: IPC write buffer size threshold (default: 1048576 bytes / 1MB)
  - Legacy parameter, kept for compatibility
  - Not used with timing-based backpressure detection

- **`bpWriteTimeThresh`**: Backpressure write time threshold (default: 50 milliseconds)
  - Average write time indicating backpressure
  - Responder tracks recent write times to detect slow writes (indicating full buffers)
  - Responder reports `availableWorkers=0` until buffer drains
  - Operator sees no available workers and queues/routes request elsewhere

**Backpressure Signaling**: When a responder's IPC write buffer fills up (during large response streaming), it reports `availableWorkers=0` in the next response message. The operator interprets this as "no capacity" and either queues the request or routes to another responder. No explicit backpressure flag is needed.

See [`arch/requirements.md`](requirements.md) and [`arch/ipc-protocol.md`](ipc-protocol.md) for detailed flow-control answer.

## Minimal Configuration Example

For simple deployments, a single pool can handle all requests:

```slid
[(
	httpPort=8080
	noSSL=@t
	
	pools=[
		default=[minProcs=2 maxProcs=10 scaling=dynamic]
	]
	
	routes=[
		[path='/@*/:*' pool=default]
	]
)]
```

## Advanced Configuration Example

For complex deployments with multiple workload types:

```slid
[(
	/* ... network and SSL config ... */
	
	pools=[
		/* Static files - high capacity, minimal overhead */
		static=[
			minProcs=4
			maxProcs=4
			scaling=static
			maxReqs=10000
			reqTimeout=2
		]
		
		/* Public API - moderate capacity, strict timeout */
		public=[
			minProcs=2
			maxProcs=15
			scaling=dynamic
			maxReqs=500
			reqTimeout=30
		]
		
		/* Admin API - low capacity, longer timeout */
		admin=[
			minProcs=1
			maxProcs=5
			scaling=dynamic
			maxReqs=100
			reqTimeout=120
		]
		
		/* Background jobs - on-demand, long timeout */
		batch=[
			minProcs=0
			maxProcs=3
			scaling=ondemand
			reqTimeout=600
		]
		
		/* WebSocket - per-connection processes */
		websocket=[
			minProcs=0
			maxProcs=100
			scaling=ondemand
			maxReqs=1
			conTimeout=7200
		]
	]
	
	routes=[
		[path='/static/*' pool=static handler=static]
		[path='/api/public/*' pool=public app=@public]
		[path='/api/admin/*' pool=admin app=@admin]
		[path='/batch/*' pool=batch app=@batch]
		[path='/ws/*' pool=websocket type=websocket app=@*]
	]
)]
```

## Migration Notes

When updating existing `jsmaws.slid` files:

1. **Add pool definitions** before routes section
2. **Update route `class` to `pool`** and reference pool names
3. **Add `scaling` parameter** to each pool (typically `dynamic`)
4. **Rename parameters** to terser versions (`minSize` → `minProcs`, etc.)
5. **Add `reqTimeout`** to pools (default: 30s if omitted)
6. **For WebSocket routes**: Change `ws=@t` to `type=websocket` and use `stream` pool

## See Also

- [`pool-configuration-design.md`](pool-configuration-design.md) - Complete pool configuration specification
- [`phase-4-sub-plan.md`](phase-4-sub-plan.md) - Phase 4 implementation plan
- [`service-class-research.md`](service-class-research.md) - Research on servlet container patterns