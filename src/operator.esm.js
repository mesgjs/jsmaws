/**
 * JavaScript Modular Application Web Server (JSMAWS)
 * Operator process entry point
 *
 * This is the main entry point for the privileged operator process.
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { OperatorProcess } from './operator-process.esm.js';
import { registerValueSchemes } from './schemes/index.esm.js';

const DEFAULT_CONFIG_FILE = 'jsmaws.slid';

/**
 * Main entry point
 */
async function main () {
	// Register value scheme handlers before any config resolution
	registerValueSchemes();

	// Parse command line arguments
	const args = Deno.args;
	const configFile = args[0] || DEFAULT_CONFIG_FILE;

	// Create operator with null config; initial config is loaded via loadConfigFile()
	// so that value references (:env:, :file:, :kv:) are resolved before use.
	const operator = new OperatorProcess(null, configFile);
	globalThis.OperatorProcess = OperatorProcess;

	// Load and apply initial configuration (same path as file-watch and SIGHUP reloads)
	console.log(`Loading configuration from: ${configFile}`);
	await operator.loadConfigFile(configFile);

	console.log('Operator configuration:');
	console.log(`  HTTP Port: ${operator.config.httpPort}`);
	console.log(`  HTTPS Port: ${operator.config.httpsPort}`);
	console.log(`  Hostname: ${operator.config.hostname}`);
	console.log(`  SSL Mode: ${operator.config.noSSL ? 'disabled' : 'enabled'}`);
	console.log(`  Cert File: ${operator.config.certFile || '(not configured)'}`);
	console.log(`  Key File: ${operator.config.keyFile || '(not configured)'}`);
	console.log(`  SSL Check Interval: ${operator.config.sslCheckIntervalHours} hour(s)`);
	console.log(`  ACME Challenge Dir: ${operator.config.acmeChallengeDir || '(not configured)'}`);

	operator.initializeLogger();

	// Handle shutdown signals
	const shutdownHandler = async () => {
		await operator.shutdown();
		Deno.exit(0);
	};

	Deno.addSignalListener('SIGINT', shutdownHandler);
	Deno.addSignalListener('SIGTERM', shutdownHandler);

	// Handle SIGHUP for graceful config reload (standard Unix practice)
	operator.registerSighupHandler();

	// Start the operator
	await operator.start();
}

// Run if this is the main module
if (import.meta.main) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		Deno.exit(1);
	});
}

// Export for testing and module usage
export { OperatorProcess };
