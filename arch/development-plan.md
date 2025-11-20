# Development Plan [DRAFT]

## Phase 1: Project Setup and Basic HTTP Server
- Create `src/` directory structure
- Implement basic HTTP server in `src/server.esm.js` using Deno's HTTP server
- Add HTTP to HTTPS redirect logic
  - Must support path-prefix bypass so as not to interfere with ACME/Certbot HTTP-01 challenge
- Basic request handling and response generation

## Phase 2: SSL Certificate Management
- Implement `src/ssl-manager.esm.js` to monitor certificate file changes
- Detect certificate updates from external ACME client (e.g., certbot)
- Handle server reload/restart when certificates are updated
- Support graceful certificate symlink updates
- For development and simple localhost experimentation, implement a "noSSL" mode (otherwise, SSL certificate issues should be fatal).

## Phase 3: Configuration and Routing
- Implement SLID parser (using `NANOS.parseSLID`) for configuration files
- Create `src/router.esm.js` for request routing based on SLID configuration
- Implement `src/config-monitor.esm.js` for monitoring SLID file changes
- Support dynamic route reloading on configuration updates
- See arch/configuration.md for configuration architecture

## Phase 4: New Requirements

- Add support for --no-ssl command-line parameter to temporarily override SLID configuration
- Create logging utility functions for centralizing Apache-like standard logging format with timestamps
- Logging system must support option of local (console) or `syslog` reporting (perhaps via `logtape`?)
  - Implementation must support any capabilities necessary to be compatible with external log rotation
- Change execution model:
  - Initial process is in charge of:
    - Accessing configuration files
    - Connecting to privileged ports
    - Managing pools of de-privileged service processes
      - Envisioned (tunable min/max sizes):
      - "int"-class pool for "static" and "int"-class requests (service process(es) persist(s), dispatching requests to workers)
      - "ext"-class pool for "ext"-class requests (each service process handles one request)
    - Forwarding requests, responses, and config changes to/from service processes
    - For security, the initial process must not handle any requests directly
  - Service processes are launched using global config options `user` and `group` to switch uid and gid (via `Deno.CommandOptions`), if present

## Phase 5: Static File Serving
- Implement `src/static-request.esm.js` for HTTPS static file delivery
- Add support for range requests (resumable downloads)
- Implement CORS headers
- Handle multiple requests per connection

## Phase 6: Applet Loading
- Implement `src/applet-loader.esm.js` to import .esm.js files
- Applets can be loaded directly as ES modules; for Mesgjs applets, `msjsload` handles module resolution and dependency loading
- Deno needs to be executed with the appropriate resource access privileges (any unnecessary access should be relinquished at launch, with necessary access determined via the SLID configuration)

## Phase 7: Internal Request Handling
- Implement `src/worker-manager.esm.js` for internal applet requests
- Restrict to approved, short-running operations
- Use Deno workers for isolation
- Support per-applet worker-pools based on SLID configuration for common requests

## Phase 8: External Request Handling
- Implement `src/subprocess-manager.esm.js` for external applet requests
- Spawn isolated sub-processes for full applet execution
- Relay messages between main process and sub-processes

## Phase 9: WebSocket Support
- Implement `src/websocket-handler.esm.js` for WebSocket connections
- Support WebSocket upgrades and message handling

## Phase 10: Integration and Optimization
- Integrate all components in main server \[this likely needs to happen incrementally during development\]
- Add error handling and logging \[moved to phase 4 to reduce technical debt\]
- Performance optimization and resource management
- Final testing and deployment preparation
