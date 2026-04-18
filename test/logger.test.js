/**
 * Tests for logger.esm.js
 */

import { assertEquals, assertExists, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { Logger, createLogger, getLogger, setLogger } from '../src/logger.esm.js';

// Test helper to capture console output
class ConsoleCapture {
    constructor() {
        this.stdout = [];
        this.stderr = [];
        const { debug, info, warn, error } = console;
        this.originalConsole = { debug, info, warn, error };
    }

    start() {
        console.debug = console.info = (text) => this.stdout.push(text);
        console.warn = console.error = (text) => this.stderr.push(text);
    }

    stop() {
        Object.assign(console, this.originalConsole);
    }

    getStdout() {
        return this.stdout.join('');
    }

    getStderr() {
        return this.stderr.join('');
    }

    clear() {
        this.stdout = [];
        this.stderr = [];
    }
}

Deno.test('Logger: Create logger instance', () => {
    const logger = new Logger({ component: 'test' });
    assertExists(logger);
    assertEquals(logger.component, 'test');
});

Deno.test('Logger: Console backend - info level', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    logger.info('Test message');

    capture.stop();
    const output = capture.getStdout();
    assertStringIncludes(output, 'INFO');
    assertStringIncludes(output, 'Test message');
    assertStringIncludes(output, 'test');
});

Deno.test('Logger: Console backend - error level', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    logger.error('Error message');

    capture.stop();
    const output = capture.getStderr();
    assertStringIncludes(output, 'ERROR');
    assertStringIncludes(output, 'Error message');
});

Deno.test('Logger: Console backend - warn level', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    logger.warn('Warning message');

    capture.stop();
    const output = capture.getStderr();
    assertStringIncludes(output, 'WARN');
    assertStringIncludes(output, 'Warning message');
});

Deno.test('Logger: Console backend - debug level filtering', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    logger.debug('Debug message');

    capture.stop();
    const output = capture.getStdout() + capture.getStderr();
    assertEquals(output, ''); // Debug should not appear at INFO level
});

Deno.test('Logger: Console backend - debug level enabled', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'debug',
        component: 'test',
    });

    logger.debug('Debug message');

    capture.stop();
    const output = capture.getStdout();
    assertStringIncludes(output, 'DEBUG');
    assertStringIncludes(output, 'Debug message');
});

Deno.test('Logger: Apache format - HTTP request', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        format: 'apache',
        component: 'test',
    });

    logger.logRequest('GET', '/api/users', 200, 1234, 0.045, '192.168.1.100');

    capture.stop();
    const output = capture.getStdout();
    assertStringIncludes(output, 'GET');
    assertStringIncludes(output, '/api/users');
    assertStringIncludes(output, '200');
    assertStringIncludes(output, '1234');
    assertStringIncludes(output, '0.045s');
    assertStringIncludes(output, '192.168.1.100');
});

Deno.test('Logger: Apache format - HTTP error request', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        format: 'apache',
        component: 'test',
    });

    logger.logRequest('POST', '/api/data', 404, 0, 0.010, '10.0.0.1');

    capture.stop();
    const output = capture.getStderr();
    assertStringIncludes(output, 'WARN');
    assertStringIncludes(output, 'POST');
    assertStringIncludes(output, '/api/data');
    assertStringIncludes(output, '404');
});

Deno.test('Logger: Timestamp format', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    logger.info('Test');

    capture.stop();
    const output = capture.getStdout();
    // Check for ISO 8601 timestamp format
    assertStringIncludes(output, 'T');
    assertStringIncludes(output, 'Z');
});

Deno.test('Logger: createLogger factory function', () => {
    const logger = createLogger({
        target: 'console',
        level: 'debug',
        component: 'factory-test',
    });

    assertExists(logger);
    assertEquals(logger.component, 'factory-test');
});

Deno.test('Logger: Global logger singleton', () => {
    // Reset global logger
    setLogger(null);

    const logger1 = getLogger({ component: 'global-test' });
    const logger2 = getLogger({ component: 'different' });

    assertEquals(logger1, logger2); // Should be same instance
});

Deno.test('Logger: Request ID generation', () => {
    const logger = new Logger({ component: 'test' });

    const id1 = logger.generateRequestId();
    const id2 = logger.generateRequestId();

    assertStringIncludes(id1, 'req-');
    assertStringIncludes(id2, 'req-');
    assertEquals(id1 !== id2, true); // Should be different
});

Deno.test('Logger: Multiple log levels in sequence', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'debug',
        component: 'test',
    });

    logger.error('Error');
    logger.warn('Warning');
    logger.info('Info');
    logger.debug('Debug');

    capture.stop();
    const stdout = capture.getStdout();
    const stderr = capture.getStderr();
    const combined = stdout + stderr;

    assertStringIncludes(combined, 'ERROR');
    assertStringIncludes(combined, 'WARN');
    assertStringIncludes(combined, 'INFO');
    assertStringIncludes(combined, 'DEBUG');
});

Deno.test('Logger: Context data in log entry', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    logger.info('Test message', { userId: 123, action: 'login' });

    capture.stop();
    const output = capture.getStdout();
    assertStringIncludes(output, 'Test message');
});

Deno.test('Logger: Graceful close', async () => {
    const logger = new Logger({
        target: 'console',
        level: 'info',
        component: 'test',
    });

    // Should not throw
    await logger.close();
});

Deno.test('Logger: Default component name', () => {
    const logger = new Logger();
    assertEquals(logger.component, 'server');
});

Deno.test('Logger: Default log level is INFO', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        component: 'test',
    });

    logger.debug('Should not appear');
    logger.info('Should appear');

    capture.stop();
    const output = capture.getStdout();
    assertEquals(output.includes('Should not appear'), false);
    assertStringIncludes(output, 'Should appear');
});

Deno.test('Logger: HTTP request without duration', () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'console',
        level: 'info',
        format: 'apache',
        component: 'test',
    });

    logger.logRequest('GET', '/test', 200, 100, undefined, '127.0.0.1');

    capture.stop();
    const output = capture.getStdout();
    assertStringIncludes(output, 'GET');
    assertStringIncludes(output, '/test');
    assertStringIncludes(output, '200');
});

Deno.test('Logger: Multiple backends', async () => {
    const capture = new ConsoleCapture();
    capture.start();

    const logger = new Logger({
        target: 'both',
        level: 'info',
        component: 'test',
    });

    try {
        logger.info('Test message');
        
        // Wait for async log operations to complete
        await new Promise(resolve => setTimeout(resolve, 10));

        capture.stop();
        const output = capture.getStdout();
        // Should have logged to console backend
        assertStringIncludes(output, 'Test message');
    }
    finally {
        // Clean up TCP connection
        await logger.close();
    }
});
