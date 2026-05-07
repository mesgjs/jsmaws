# JavaScript Modular Application Web Server (JSMAWS)

A Deno-based web server for secure execution of JavaScript modular applications ("mod-apps") with SSL management, static file serving, and process isolation.

## Features

- **HTTP to HTTPS Redirect**: Automatic redirection with ACME challenge bypass
- **SSL Certificate Management**: Integration with Let's Encrypt ACME protocol
- **Static File Serving**: Efficient delivery of static content
- **JavaScript Mod-App Execution**: Support for both internal (worker-based) and external (subprocess-based) execution
- **WebSocket Support**: Real-time communication capabilities
- **SLID Configuration**: Human-readable configuration format using NANOS

## Installation

Requires [Deno](https://deno.land/) runtime.

## Configuration

Create a `jsmaws.slid` configuration file:

```
[(
	/* Network Configuration */
	httpPort=8080
	httpsPort=8443
	hostname=localhost
	
	/* SSL Certificate Configuration */
	/* Set noSSL=@t for development/localhost (HTTP-only operation) */
	noSSL=@t /* or @f, default */
	
	/* Uncomment and set these when SSL certificates are available */
	/* certFile=/path/to/cert.pem */
	/* keyFile=/path/to/key.pem */
	
	/* SSL certificate monitoring interval in hours (default: 1) */
	/* sslCheckIntervalHours=1 */
	
	/* ACME Challenge Directory */
	acmeChallengeDir=/var/www/acme-challenge
)]
```

All fields are optional and will use defaults if not specified:
- `httpPort`: 80
- `httpsPort`: 443
- `hostname`: localhost
- `noSSL`: false (set to true for HTTP-only development mode)
- `sslCheckIntervalHours`: 1 (certificate monitoring check interval)
- `acmeChallengeDir`: /var/www/acme-challenge

## Usage

Start the server with default configuration:

```bash
deno run --allow-net --allow-read src/server.esm.js
```

Or specify a custom configuration file:

```bash
deno run --allow-net --allow-read src/server.esm.js path/to/config.slid
```

## Development

Run tests:

```bash
deno test --allow-read
```

## Project Structure

```
jsmaws/
├── src/
│   ├── server.esm.js          # Main server implementation
│   ├── ssl-manager.esm.js     # SSL certificate monitoring
│   ├── vendor.esm.js          # External dependencies
│   └── ...                    # Additional modules (to be added)
├── test/
│   ├── server.test.js         # Server tests
│   └── ssl-manager.test.js    # SSL manager tests
├── jsmaws.slid                # Default configuration
└── README.md
```

## Development Status

### Completed
- Phase 1: Project Setup and Basic HTTP Server
  - HTTP server with ACME challenge support
  - HTTPS server with SSL certificate loading
  - SLID configuration file support
  - Basic request handling

- Phase 2: SSL Certificate Management
  - SSL certificate file monitoring (hourly checks by default)
  - Detection of certificate updates and symlink changes
  - Graceful HTTPS server reload on certificate updates
  - "noSSL" mode for development/localhost testing
  - Integration with main server

### In Progress
- Phase 3: Static File Serving

### Planned
- Phase 4: Configuration and Routing
- Phase 5: Mod-app Loading
- Phase 6: Internal Request Handling
- Phase 7: External Request Handling
- Phase 8: WebSocket Support
- Phase 9: Integration and Optimization

## License And Copyright

MIT License
Copyright 2025 Kappa Computer Solutions, LLC
