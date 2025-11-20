# Test Plan [DRAFT]

## Unit Testing
- **Server Components**: Test each module (server.esm.js, router.esm.js, etc.) in isolation
- **SLID Parser**: Test parsing of SLID configuration files
- **App Loader**: Test importing and execution of applets
- **SSL Manager**: Test certificate file monitoring and reload triggers
- **Static Server**: Test range requests, CORS, multiple connections

## Integration Testing
- **Request Flow**: End-to-end tests for HTTP → HTTPS redirect → routing → response
- **Applet Execution**: Test loading and executing applets for internal/external requests
- **Configuration Reload**: Test SLID file changes trigger route updates
- **SSL Updates**: Test certificate changes trigger server reload

## Security Testing
- **Process Isolation**: Verify external requests run in separate processes
- **Message Validation**: Ensure all messages are properly validated
- **Resource Limits**: Test memory and CPU restrictions on applet execution
- **Access Control**: Verify internal requests are restricted to approved operations

## Performance Testing
- **Concurrent Requests**: Test handling multiple simultaneous connections
- **Static File Serving**: Benchmark large file downloads with range requests
- **Applet Execution**: Measure response times for different request types
- **Memory Usage**: Monitor resource consumption under load

## SSL and HTTPS Testing
- **Certificate Loading**: Test loading and using SSL certificates
- **ACME Integration**: Test detection of certificate updates from external client
- **HTTPS Redirect**: Verify HTTP requests are properly redirected
- **Certificate Validation**: Test with valid and expired certificates

## Configuration Testing
- **SLID Parsing**: Test various SLID file formats and edge cases
- **Route Matching**: Test routing logic with different URL patterns
- **File Monitoring**: Test detection of configuration file changes
- **Error Handling**: Test invalid configurations and recovery

## WebSocket Testing
- **Connection Handling**: Test WebSocket upgrade and connection management
- **Message Relay**: Test message passing between clients and applets
- **Sub-protocol Support**: Test different WebSocket sub-protocols

## Testing Framework
- Use Deno's built-in testing framework
- Test files named with `.test.js` extension
- Load actual external dependencies for unit tests where possible and mock otherwise
- Use integration test server for end-to-end tests