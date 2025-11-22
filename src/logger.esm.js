/**
 * Centralized logging utility for JSMAWS with pluggable backends.
 * Supports console and syslog output with Apache-like log format.
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Log levels with numeric values for filtering
 */
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
};

/**
 * Reverse mapping for display
 */
const LEVEL_NAMES = {
    0: 'ERROR',
    1: 'WARN',
    2: 'INFO',
    3: 'DEBUG',
};

/**
 * Console backend for logging to stdout/stderr
 */
class ConsoleBackend {
    constructor (options = {}) {
        this.level = LOG_LEVELS[options.level?.toUpperCase() || 'INFO'];
        this.format = options.format || 'apache';
    }

    log (entry) {
        if (entry.level > this.level) return;

        const message = this.formatMessage(entry);
        const stream = entry.level <= LOG_LEVELS.WARN ? Deno.stderr : Deno.stdout;
        stream.writeSync(new TextEncoder().encode(message + '\n'));
    }

    formatMessage (entry) {
        if (this.format === 'apache') {
            return this.formatApache(entry);
        }
        return this.formatDefault(entry);
    }

    formatApache (entry) {
        const timestamp = new Date(entry.timestamp).toISOString();
        const level = LEVEL_NAMES[entry.level];
        const component = entry.component || 'server';

        // Apache-like format: [timestamp] [level] [component] message
        if (entry.remote && entry.method && entry.path) {
            // HTTP request format
            const duration = entry.duration ? ` ${entry.duration.toFixed(3)}s` : '';
            return `[${timestamp}] [${level}] [${component}] ${entry.remote} - "${entry.method} ${entry.path} HTTP/1.1" ${entry.status} ${entry.bytes}${duration}`;
        }

        // Generic format
        return `[${timestamp}] [${level}] [${component}] ${entry.message}`;
    }

    formatDefault (entry) {
        const timestamp = new Date(entry.timestamp).toISOString();
        const level = LEVEL_NAMES[entry.level];
        return `${timestamp} ${level} ${entry.message}`;
    }
}

/**
 * Syslog backend for logging to system syslog
 * Note: Requires syslog daemon to be running
 */
class SyslogBackend {
    constructor (options = {}) {
        this.level = LOG_LEVELS[options.level?.toUpperCase() || 'INFO'];
        this.facility = this.parseFacility(options.facility || 'local0');
        this.tag = options.tag || 'jsmaws';
        this.socketPath = options.socketPath || this.getDefaultSocketPath();
        this.socket = null;
        this.connected = false;
    }

    getDefaultSocketPath () {
        // Try common syslog socket paths based on OS
        if (Deno.build.os === 'darwin') {
            return '/var/run/syslog';
        }
        // Linux and other Unix-like systems
        return '/dev/log';
    }

    parseFacility (facility) {
        const facilities = {
            'kern': 0, 'user': 1, 'mail': 2, 'daemon': 3, 'auth': 4,
            'syslog': 5, 'lpr': 6, 'news': 7, 'uucp': 8, 'cron': 9,
            'local0': 16, 'local1': 17, 'local2': 18, 'local3': 19,
            'local4': 20, 'local5': 21, 'local6': 22, 'local7': 23,
        };
        return (facilities[facility] || 16) * 8;
    }

    async connect () {
        if (this.connected) return;

        try {
            this.socket = await Deno.connect({
                transport: 'unix',
                path: this.socketPath,
            });
            this.connected = true;
        } catch (error) {
            console.error(`Failed to connect to syslog at ${this.socketPath}: ${error.message}`);
            this.connected = false;
        }
    }

    async log (entry) {
        if (entry.level > this.level) return;

        if (!this.connected) {
            await this.connect();
        }

        if (!this.connected) {
            // Fallback to console if syslog unavailable
            return;
        }

        const message = this.formatMessage(entry);
        const priority = this.facility + entry.level;
        const syslogMessage = `<${priority}>${this.tag}[${Deno.pid}]: ${message}`;

        try {
            await this.socket.write(new TextEncoder().encode(syslogMessage));
        } catch (error) {
            console.error(`Failed to write to syslog: ${error.message}`);
            this.connected = false;
        }
    }

    formatMessage (entry) {
        if (entry.remote && entry.method && entry.path) {
            // HTTP request format
            const duration = entry.duration ? ` ${entry.duration.toFixed(3)}s` : '';
            return `${entry.remote} - "${entry.method} ${entry.path} HTTP/1.1" ${entry.status} ${entry.bytes}${duration}`;
        }

        return entry.message;
    }

    async close () {
        if (this.socket) {
            try {
                this.socket.close();
            } catch (error) {
                // Ignore close errors
            }
            this.socket = null;
            this.connected = false;
        }
    }
}

/**
 * Main Logger class that manages backends and log entries
 */
export class Logger {
    constructor (options = {}) {
        this.backends = [];
        this.component = options.component || 'server';
        this.requestIdCounter = 0;

        // Initialize backends based on configuration
        const target = options.target || 'console';

        if (target === 'console' || target === 'both') {
            this.backends.push(new ConsoleBackend(options));
        }

        if (target === 'syslog' || target === 'both') {
            this.backends.push(new SyslogBackend(options));
        }
    }

    /**
     * Generate a unique request ID for tracking
     */
    generateRequestId () {
        return `req-${++this.requestIdCounter}`;
    }

    /**
     * Log an error message
     */
    error (message, context = {}) {
        this.log(LOG_LEVELS.ERROR, message, context);
    }

    /**
     * Log a warning message
     */
    warn (message, context = {}) {
        this.log(LOG_LEVELS.WARN, message, context);
    }

    /**
     * Log an info message
     */
    info (message, context = {}) {
        this.log(LOG_LEVELS.INFO, message, context);
    }

    /**
     * Log a debug message
     */
    debug (message, context = {}) {
        this.log(LOG_LEVELS.DEBUG, message, context);
    }

    /**
     * Log an HTTP request
     */
    logRequest (method, path, status, bytes, duration, remote = '127.0.0.1') {
        const entry = {
            timestamp: Date.now(),
            level: status >= 400 ? LOG_LEVELS.WARN : LOG_LEVELS.INFO,
            component: this.component,
            method,
            path,
            status,
            bytes,
            duration,
            remote,
        };

        for (const backend of this.backends) {
            if (backend.log instanceof Function) {
                const result = backend.log(entry);
                if (result instanceof Promise) {
                    // Fire and forget for async backends
                    result.catch(err => console.error(`Logging error: ${err.message}`));
                }
            }
        }
    }

    /**
     * Internal log method
     */
    log (level, message, context = {}) {
        const entry = {
            timestamp: Date.now(),
            level,
            component: this.component,
            message,
            ...context,
        };

        for (const backend of this.backends) {
            if (backend.log instanceof Function) {
                const result = backend.log(entry);
                if (result instanceof Promise) {
                    // Fire and forget for async backends
                    result.catch(err => console.error(`Logging error: ${err.message}`));
                }
            }
        }
    }

    /**
     * Close all backends (for graceful shutdown)
     */
    async close () {
        const promises = this.backends
            .filter(b => b.close instanceof Function)
            .map(b => b.close());

        await Promise.all(promises);
    }
}

/**
 * Create a logger instance from configuration
 */
export function createLogger (config = {}) {
    return new Logger({
        target: config.target || 'console',
        level: config.level || 'info',
        format: config.format || 'apache',
        facility: config.facility || 'local0',
        component: config.component || 'server',
    });
}

/**
 * Global logger instance (singleton pattern)
 */
let globalLogger = null;

/**
 * Get or create the global logger
 */
export function getLogger (config = {}) {
    if (!globalLogger) {
        globalLogger = createLogger(config);
    }
    return globalLogger;
}

/**
 * Set the global logger (for testing or custom configuration)
 */
export function setLogger (logger) {
    globalLogger = logger;
}

export default Logger;
