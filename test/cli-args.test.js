/**
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 * 
 * Tests for cli-args.esm.js
 */

import { assertEquals, assertExists, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { parseCliArgs, validateArgs, applyCliOverrides, processCli } from '../src/cli-args.esm.js';

Deno.test('CLI: Parse basic arguments', () => {
    const result = parseCliArgs(['jsmaws.slid']);
    assertEquals(result.configFile, 'jsmaws.slid');
    assertEquals(result.noSsl, false);
    assertEquals(result.logLevel, 'info');
    assertEquals(result.showHelp, false);
});

Deno.test('CLI: Parse --no-ssl flag', () => {
    const result = parseCliArgs(['--no-ssl', 'jsmaws.slid']);
    assertEquals(result.noSsl, true);
    assertEquals(result.configFile, 'jsmaws.slid');
});

Deno.test('CLI: Parse --config option', () => {
    const result = parseCliArgs(['--config', '/etc/jsmaws/config.slid']);
    assertEquals(result.configFile, '/etc/jsmaws/config.slid');
});

Deno.test('CLI: Parse --log-level option', () => {
    const result = parseCliArgs(['--log-level', 'debug', 'jsmaws.slid']);
    assertEquals(result.logLevel, 'debug');
});

Deno.test('CLI: Parse --help flag', () => {
    const result = parseCliArgs(['--help']);
    assertEquals(result.showHelp, true);
});

Deno.test('CLI: Parse multiple options', () => {
    const result = parseCliArgs(['--no-ssl', '--log-level', 'debug', '--config', 'custom.slid']);
    assertEquals(result.noSsl, true);
    assertEquals(result.logLevel, 'debug');
    assertEquals(result.configFile, 'custom.slid');
});

Deno.test('CLI: Default config file', () => {
    const result = parseCliArgs([]);
    assertEquals(result.configFile, 'jsmaws.slid');
});

Deno.test('CLI: Default log level', () => {
    const result = parseCliArgs(['jsmaws.slid']);
    assertEquals(result.logLevel, 'info');
});

Deno.test('CLI: Validate valid log levels', () => {
    const validLevels = ['error', 'warn', 'info', 'debug'];
    for (const level of validLevels) {
        const parsed = { logLevel: level, configFile: 'jsmaws.slid' };
        const errors = validateArgs(parsed);
        assertEquals(errors.length, 0, `Level ${level} should be valid`);
    }
});

Deno.test('CLI: Validate invalid log level', () => {
    const parsed = { logLevel: 'invalid', configFile: 'jsmaws.slid' };
    const errors = validateArgs(parsed);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0], 'Invalid log level');
});

Deno.test('CLI: Validate missing config file', () => {
    const parsed = { logLevel: 'info', configFile: '/nonexistent/path/config.slid' };
    const errors = validateArgs(parsed);
    assertEquals(errors.length, 1);
    assertStringIncludes(errors[0], 'not found');
});

Deno.test('CLI: Apply --no-ssl override', () => {
    const baseConfig = { ssl: true, port: 443 };
    const cliArgs = { noSsl: true, logLevel: 'info' };
    const result = applyCliOverrides(baseConfig, cliArgs);
    assertEquals(result.ssl, false);
    assertEquals(result.port, 443); // Other config unchanged
});

Deno.test('CLI: Apply log level override', () => {
    const baseConfig = { logging: { level: 'info' } };
    const cliArgs = { noSsl: false, logLevel: 'debug' };
    const result = applyCliOverrides(baseConfig, cliArgs);
    assertEquals(result.logging.level, 'debug');
});

Deno.test('CLI: Create logging config if not present', () => {
    const baseConfig = {};
    const cliArgs = { noSsl: false, logLevel: 'debug' };
    const result = applyCliOverrides(baseConfig, cliArgs);
    assertExists(result.logging);
    assertEquals(result.logging.level, 'debug');
});

Deno.test('CLI: No override when log level is default', () => {
    const baseConfig = { logging: { level: 'warn' } };
    const cliArgs = { noSsl: false, logLevel: 'info' };
    const result = applyCliOverrides(baseConfig, cliArgs);
    // Default 'info' should not override existing config
    assertEquals(result.logging.level, 'warn');
});

Deno.test('CLI: Process CLI with valid args', () => {
    const result = processCli(['jsmaws.slid'], { ssl: true });
    assertEquals(result.success, true);
    assertEquals(result.configFile, 'jsmaws.slid');
    assertExists(result.config);
});

Deno.test('CLI: Process CLI with --help', () => {
    const result = processCli(['--help']);
    assertEquals(result.success, false);
    assertEquals(result.showedHelp, true);
});

Deno.test('CLI: Process CLI with invalid log level', () => {
    const result = processCli(['--log-level', 'invalid', 'jsmaws.slid']);
    assertEquals(result.success, false);
    assertStringIncludes(result.error, 'Invalid log level');
});

Deno.test('CLI: Process CLI applies overrides', () => {
    const baseConfig = { ssl: true, port: 443 };
    const result = processCli(['--no-ssl', 'jsmaws.slid'], baseConfig);
    assertEquals(result.success, true);
    assertEquals(result.config.ssl, false);
});

Deno.test('CLI: Config file precedence - explicit config option', () => {
    const result = parseCliArgs(['--config', 'custom.slid', 'ignored.slid']);
    assertEquals(result.configFile, 'custom.slid');
});

Deno.test('CLI: Config file precedence - positional argument', () => {
    const result = parseCliArgs(['myconfig.slid']);
    assertEquals(result.configFile, 'myconfig.slid');
});

Deno.test('CLI: Multiple log level options', () => {
    const result = parseCliArgs(['--log-level', 'error', 'jsmaws.slid']);
    assertEquals(result.logLevel, 'error');
});

Deno.test('CLI: Combined short and long options', () => {
    const result = parseCliArgs(['--no-ssl', '--log-level', 'warn', '--config', 'test.slid']);
    assertEquals(result.noSsl, true);
    assertEquals(result.logLevel, 'warn');
    assertEquals(result.configFile, 'test.slid');
});

Deno.test('CLI: Empty args uses defaults', () => {
    const result = parseCliArgs([]);
    assertEquals(result.configFile, 'jsmaws.slid');
    assertEquals(result.noSsl, false);
    assertEquals(result.logLevel, 'info');
    assertEquals(result.showHelp, false);
});

Deno.test('CLI: Preserve other config properties', () => {
    const baseConfig = {
        ssl: true,
        port: 443,
        appRoot: '/var/www/apps',
        root: '/var/www',
        customProperty: 'value',
    };
    const cliArgs = { noSsl: true, logLevel: 'info' };
    const result = applyCliOverrides(baseConfig, cliArgs);
    assertEquals(result.ssl, false);
    assertEquals(result.port, 443);
    assertEquals(result.appRoot, '/var/www/apps');
    assertEquals(result.root, '/var/www');
    assertEquals(result.customProperty, 'value');
});
