/**
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 * 
 * Command-line argument parser for JSMAWS
 * Handles configuration overrides and development flags
 */

import { parseArgs } from 'https://deno.land/std@0.208.0/cli/parse_args.ts';

/**
 * Parse command-line arguments
 * 
 * Usage:
 *   deno run src/server.esm.js [options] [config-file]
 * 
 * Options:
 *   --no-ssl              Disable SSL/HTTPS (development mode)
 *   --config <file>       Specify configuration file (default: jsmaws.slid)
 *   --log-level <level>   Set logging level (error, warn, info, debug)
 *   --help                Show help message
 */
export function parseCliArgs (args = Deno.args) {
    const parsed = parseArgs(args, {
        string: ['config', 'log-level'],
        boolean: ['no-ssl', 'help'],
        default: {
            'no-ssl': false,
            'log-level': 'info',
        },
    });

    const firstArg = parsed._?.[0];
    const configFile = parsed.config || (typeof firstArg === 'string' ? firstArg : undefined) || 'jsmaws.slid';

    return {
        noSsl: parsed['no-ssl'],
        configFile,
        logLevel: parsed['log-level'],
        showHelp: parsed.help,
        unknownArgs: parsed._?.slice(parsed.config ? 0 : 1) || [],
    };
}

/**
 * Display help message
 */
export function showHelp () {
    const help = `
JavaScript Multi-Applet Web Server (JSMAWS)

Usage:
  deno run --allow-all src/server.esm.js [options] [config-file]

Options:
  --no-ssl              Disable SSL/HTTPS (development mode only)
  --config <file>       Specify configuration file (default: jsmaws.slid)
  --log-level <level>   Set logging level: error, warn, info, debug (default: info)
  --help                Show this help message

Examples:
  # Normal operation with SSL
  deno run --allow-all src/server.esm.js jsmaws.slid

  # Development mode without SSL
  deno run --allow-all src/server.esm.js --no-ssl jsmaws.slid

  # Custom configuration file
  deno run --allow-all src/server.esm.js --config /etc/jsmaws/config.slid

  # Debug logging
  deno run --allow-all src/server.esm.js --log-level debug jsmaws.slid

Configuration Precedence:
  Command-line arguments > SLID configuration > Defaults

Security Warning:
  --no-ssl disables HTTPS and should ONLY be used for development.
  Never use --no-ssl in production environments.
`;
    console.log(help);
}

/**
 * Validate parsed arguments
 * Returns array of validation errors (empty if valid)
 */
export function validateArgs (parsed) {
    const errors = [];

    // Validate log level
    const validLevels = ['error', 'warn', 'info', 'debug'];
    if (!validLevels.includes(parsed.logLevel)) {
        errors.push(`Invalid log level: ${parsed.logLevel}. Must be one of: ${validLevels.join(', ')}`);
    }

    // Validate config file exists
    try {
        Deno.statSync(parsed.configFile);
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            errors.push(`Configuration file not found: ${parsed.configFile}`);
        } else {
            errors.push(`Cannot access configuration file: ${parsed.configFile} (${error.message})`);
        }
    }

    return errors;
}

/**
 * Apply CLI overrides to configuration object
 * 
 * Merges CLI arguments with SLID configuration, with CLI taking precedence
 */
export function applyCliOverrides (config, cliArgs) {
	const overridden = { ...config };

	// Override SSL setting if --no-ssl flag is set
	if (cliArgs.noSsl) {
		overridden.ssl = false;
		console.warn('[WARN] SSL/HTTPS disabled via --no-ssl flag (development mode only)');
	}

	// Override logging configuration if --log-level is set
	if (cliArgs.logLevel && cliArgs.logLevel !== 'info') {
		if (!overridden.logging) {
			overridden.logging = {};
		}
		overridden.logging.level = cliArgs.logLevel;
	}

	return overridden;
}

/**
 * Main entry point for CLI argument processing
 * 
 * Returns:
 *   {
 *     success: boolean,
 *     configFile: string,
 *     config: object (with CLI overrides applied),
 *     error?: string
 *   }
 */
export function processCli (args = Deno.args, baseConfig = {}) {
	const parsed = parseCliArgs(args);

	// Show help if requested
	if (parsed.showHelp) {
		showHelp();
		return {
			success: false,
			showedHelp: true,
			configFile: parsed.configFile,
			config: baseConfig,
		};
	}

	// Validate arguments
	const errors = validateArgs(parsed);
	if (errors.length > 0) {
		return {
			success: false,
			configFile: parsed.configFile,
			config: baseConfig,
			error: errors.join('\n'),
		};
	}

	// Apply CLI overrides to configuration
	const config = applyCliOverrides(baseConfig, parsed);

	return {
		success: true,
		configFile: parsed.configFile,
		config,
	};
}

export default {
	parseCliArgs,
	showHelp,
	validateArgs,
	applyCliOverrides,
	processCli,
};
