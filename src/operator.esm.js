/**
 * JavaScript Multi-Applet Web Server (JSMAWS)
 * Operator process entry point
 *
 * This is the main entry point for the privileged operator process.
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { parseSLID } from './vendor.esm.js';
import { OperatorProcess, ServerConfig } from './operator-process.esm.js';

const DEFAULT_CONFIG_FILE = 'jsmaws.slid';

/**
 * Load configuration from a SLID file
 * @param {string} configPath Path to the SLID configuration file
 * @returns {Promise<NANOS>} Parsed configuration
 */
export async function loadConfig (configPath) {
	const configText = await Deno.readTextFile(configPath);
	const config = parseSLID(configText);
	return config;
}

/**
 * Main entry point
 */
async function main () {
	// Parse command line arguments
	const args = Deno.args;
	const configFile = args[0] || DEFAULT_CONFIG_FILE;

	// Load configuration from SLID file
	console.log(`Loading configuration from: ${configFile}`);
	const configData = await loadConfig(configFile);
	const config = ServerConfig.fromNANOS(configData);

	console.log('Operator configuration:');
	console.log(`  HTTP Port: ${config.httpPort}`);
	console.log(`  HTTPS Port: ${config.httpsPort}`);
	console.log(`  Hostname: ${config.hostname}`);
	console.log(`  SSL Mode: ${config.noSSL ? 'disabled' : 'enabled'}`);
	console.log(`  Cert File: ${config.certFile || '(not configured)'}`);
	console.log(`  Key File: ${config.keyFile || '(not configured)'}`);
	console.log(`  SSL Check Interval: ${config.sslCheckIntervalHours} hour(s)`);
	console.log(`  ACME Challenge Dir: ${config.acmeChallengeDir || '(not configured)'}`);

	// Create and start operator
	const operator = new OperatorProcess(config, configFile);
	globalThis.OperatorProcess = OperatorProcess;
	OperatorProcess.instance = operator;
	operator.configData = configData; // Store full config
	operator.initializeLogger();

	// Handle shutdown signals
	const shutdownHandler = async () => {
		await operator.shutdown();
		Deno.exit(0);
	};

	Deno.addSignalListener('SIGINT', shutdownHandler);
	Deno.addSignalListener('SIGTERM', shutdownHandler);

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
export { OperatorProcess, ServerConfig };
