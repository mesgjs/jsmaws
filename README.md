# JavaScript Modular Application Web Server (JSMAWS)

A Deno-based web server for secure execution of JavaScript modular applications ("mod-apps") with SSL management, static file serving, process isolation, and a comprehensive authentication framework.

JSMAWS follows an **inside-out** design philosophy: rather than an application that *contains* a web server, JSMAWS is a web server that *contains* independently deployable mod-apps. The server is the stable platform; mod-apps are the independently hot-swappable units running inside it — analogous to Apache Tomcat for Java servlets or PHP-FPM for PHP scripts, but for JavaScript mod-apps with stronger process isolation.

## Features

- **HTTP to HTTPS Redirect** — Automatic redirection with ACME challenge bypass
- **SSL Certificate Management** — Integration with Let's Encrypt / certbot; automatic reload on certificate renewal; expiry warnings at 30 days
- **Static File Serving** — Efficient delivery of static content with range request support, MIME type mapping, and directory traversal prevention
- **JavaScript Mod-App Execution** — Sub-process-based execution with full process isolation; supports regular responses, SSE streaming, and WebSocket bidirectional connections
- **Privilege Separation** — Operator process runs as root (to bind ports 80/443); all request-handling sub-processes run as an unprivileged user
- **User-Configurable Process Pools** — Named pools capable of independent scaling strategies, per-pool timeouts, and request limits (inspired by PHP-FPM)
- **Authentication Framework** — Built-in providers (`@jwt`, `@api-key`, `@basic`, `@test-identity`); optional auth sub-process pool for external providers; TTL-based caching; provider-level cache key extraction
- **Route Groups and Host-Based Routing** — Named reusable route groups with per-group auth/role overrides; multi-host SNI routing via `hostRoutes`
- **Header and Cookie Filtering** — Allowlist/denylist filtering of request and response headers/cookies at global or route-group level
- **Environment and Secrets Injection** — `:env:`, `:file:`, `:kv:` value references resolved at config load time; per-pool and per-route `appEnv` injection into mod-apps
- **SLID Configuration** — Human-readable configuration format using NANOS; hot-reloaded on file change or SIGHUP
- **Graceful Shutdown** — SIGTERM triggers a configurable deadline with spread across process layers; mod-apps receive `JSMAWS.shutdownDeadline` promise
- **WebSocket Support** — Full bidirectional communication via PolyTransport

## Requirements

- [Deno](https://deno.land/) 2.0 or later

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/jsmaws.git
cd jsmaws

# Run the test suite to verify your installation
./deno-test

# Start the server (HTTP-only development mode)
deno run \
    --allow-read \
    --allow-net \
    --allow-run \
    --allow-env \
    --allow-sys \
    --unstable-worker-options \
    src/operator.esm.js \
    --config jsmaws.slid
```

## Configuration

JSMAWS uses SLID format (`.slid` files) for configuration. The file is monitored for changes and reloaded automatically; a SIGHUP signal also triggers a reload.

### Minimal development configuration

```slid
[(
    noSSL=@t /* Run without SSL */
    httpPort=8080
    hostname=localhost

    root=/var/www/html
    appRoot=/var/www/apps

    routes=[
        [path=/static/:*  pool=fast  app=@static  method=read]
        [path=/api/:*     pool=standard  app=./apps/api.esm.js]
        [regex='^/.*'     response=404]
    ]
)]
```

### Production configuration (with SSL and auth)

```slid
[(
    hostname=0.0.0.0
    httpPort=80
    httpsPort=443

    certFile=/etc/letsencrypt/live/example.com/fullchain.pem
    keyFile=/etc/letsencrypt/live/example.com/privkey.pem
    acmeChallengeDir=/var/www/acme-challenge

    uid=33
    gid=33
    shutdownDelay=30
    shutdownSpread=0.1

    authn=[
        [provider=@jwt  secret=:env:JWT_SECRET  algorithm=HS256]
    ]

    pools=[
        fast=[minProcs=2  maxProcs=10  maxWorkers=8  maxReqs=1000  reqTimeout=5]
        standard=[minProcs=1  maxProcs=20  maxWorkers=4  maxReqs=100  reqTimeout=60]
        stream=[minProcs=0  maxProcs=50  maxWorkers=1  maxReqs=1  reqTimeout=0  idleTimeout=60  conTimeout=3600  resType=[stream bidi]]
    ]

    routes=[
        [path=/static/:*  pool=fast  app=@static  method=read]
        [path=/api/:*     pool=standard  app=./apps/api.esm.js]
        [path=/ws/:*      pool=stream  app=./apps/ws.esm.js  method=any]
        [regex='^/.*'     response=404]
    ]
)]
```

See [`docs/configuration.md`](docs/configuration.md) for the complete configuration reference.

## Project Structure

```
jsmaws/
├── src/
│   ├── operator.esm.js              # Main entry point (privileged process bootstrap)
│   ├── operator-process.esm.js      # OperatorProcess class (lifecycle, pools, config)
│   ├── operator-request-state.esm.js# Request state machine
│   ├── responder-process.esm.js     # Responder sub-process (executes mod-apps)
│   ├── router-worker.esm.js         # Router worker implementation
│   ├── pool-manager.esm.js          # Generic process pool manager
│   ├── process-manager.esm.js       # Sub-process lifecycle management
│   ├── ssl-manager.esm.js           # SSL certificate monitoring and expiry checks
│   ├── configuration.esm.js         # System-wide configuration class
│   ├── file-monitor.esm.js          # Generic file-change monitor
│   ├── logger.esm.js                # Centralized logging (console and syslog)
│   ├── operator-authn.esm.js        # Authentication chain (operator-resident providers)
│   ├── auth-process.esm.js          # Auth sub-process (external providers)
│   ├── value-resolver.esm.js        # :env:/:file:/:kv: value reference resolution
│   ├── apps/
│   │   ├── bootstrap.esm.js         # Mod-app bootstrap (JSMAWS namespace, channels)
│   │   └── static-content.esm.js    # Static file serving mod-app
│   └── auth/
│       ├── jwt.esm.js               # @jwt provider
│       ├── api-key.esm.js           # @api-key provider
│       ├── basic.esm.js             # @basic provider
│       └── test-identity.esm.js     # @test-identity provider (dev/testing only)
├── test/                            # Unit tests
├── test-e2e/                        # End-to-end tests
├── examples/
│   ├── apps/                        # Example mod-apps (hello-world, SSE clock, WebSocket echo)
│   └── clients/                     # Example test clients
├── docs/
│   ├── configuration.md             # Full configuration reference
│   ├── deployment.md                # Production deployment guide
│   ├── mod-app-development.md       # Writing mod-apps for JSMAWS
│   └── client-bidi-integration.md   # Client-side WebSocket/bidi integration
├── arch/                            # Architecture and design documents
├── jsmaws.slid                      # Default configuration file
└── deno-test                        # Test runner script
```

## Development

### Running tests

```bash
# All unit tests
./deno-test test

# End-to-end tests (requires a running server; starts/stops automatically)
./deno-test test-e2e
```

### Running examples

```bash
# Start the server with the example configuration
deno run --allow-all --unstable-worker-options \
    src/operator.esm.js --config examples/jsmaws-examples.slid

# In another terminal, run an example client
deno run --allow-net examples/clients/http-hello.esm.js
deno run --allow-net examples/clients/sse-clock.esm.js
deno run --allow-net examples/clients/ws-echo.esm.js
```

See [`examples/README.md`](examples/README.md) for details on the example mod-apps.

## Writing Mod-Apps

A mod-app is an ES module that exports a default handler function. JSMAWS bootstraps the mod-app in a Web Worker and exposes a frozen `globalThis.JSMAWS` namespace:

```javascript
// Copyright 2026 Kappa Computer Solutions, LLC and Brian Katzung
// my-app.esm.js — simple JSON response mod-app

export default async function handler () {
    const { server } = globalThis.JSMAWS;

    const req = await server.read({ only: 'req', decode: true });
    if (!req) return;

    const { method, url } = JSON.parse(req.text);
    await req.done();

    const body = JSON.stringify({ hello: 'world', method, url });
    await server.write('res', JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
    }));
}
```

See [`docs/mod-app-development.md`](docs/mod-app-development.md) for the complete mod-app development guide, including streaming (SSE) and bidirectional (WebSocket) patterns.

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for the full production deployment guide, including:

- System requirements and Deno installation
- Directory layout and privilege setup
- systemd unit file
- Let's Encrypt / certbot integration
- Log rotation
- Pool sizing recommendations
- Upgrade procedure

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/configuration.md`](docs/configuration.md) | Complete configuration reference |
| [`docs/deployment.md`](docs/deployment.md) | Production deployment guide |
| [`docs/mod-app-development.md`](docs/mod-app-development.md) | Writing mod-apps for JSMAWS |
| [`docs/client-bidi-integration.md`](docs/client-bidi-integration.md) | Client-side WebSocket/bidi integration |
| [`examples/README.md`](examples/README.md) | Example mod-apps and clients |

## Architecture

JSMAWS uses a multi-process architecture with privilege separation:

```
Privileged Operator Process (root)
  ├── Binds ports 80 / 443
  ├── Reads configuration (SLID)
  ├── Runs authentication chain (operator-resident providers)
  └── Manages process pools
        ├── "fast" pool   — short-duration, high-frequency requests
        ├── "standard" pool — general application requests
        └── "stream" pool — WebSocket / SSE connections
              └── Responder sub-processes (uid: www-data)
                    └── Mod-app Web Workers
```

Key design documents are in the [`arch/`](arch/) directory.

## License and Copyright

MIT License  
Copyright 2025–2026 Kappa Computer Solutions, LLC and Brian Katzung
