/**
 * Centralized logging utility for JSMAWS with pluggable backends.
 * Supports console and syslog output with Apache-like log format.
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Log levels with numeric values for filtering
 * NOTE: Lower numbers are higher levels, higher numbers are lower levels
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
        // Ignore below logging threshold
        if (entry.level > this.level) return true;

        const message = this.formatMessage(entry);
        switch (entry.level) {
        case LOG_LEVELS.ERROR: console.error(message); break;
        case LOG_LEVELS.WARN: console.warn(message); break;
        case LOG_LEVELS.INFO: console.info(message); break;
        case LOG_LEVELS.DEBUG: console.debug(message); break;
        }
        return true;
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
 * Syslog backend for logging to system syslog via TCP
 * Note: Requires syslog daemon to be running and accepting TCP connections
 */
class SyslogBackend {
    constructor (options = {}) {
        this.level = LOG_LEVELS[options.level?.toUpperCase() || 'INFO'];
        this.facility = this.parseFacility(options.facility || 'local0');
        this.tag = options.tag || 'jsmaws';
        this.host = options.host || '127.0.0.1';
        this.port = options.port || 514;
        this.socket = null;
        this.connected = null;
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
        if (this.socket) return true; // Already connected
        if (this.connected) return this.connected; // Connection attempt pending

        let resolve;
        const promise = this.connected = new Promise((res) => resolve = res);

        try {
            this.socket = await Deno.connect({
                transport: 'tcp',
                hostname: this.host,
                port: this.port,
            });
        } catch (error) {
            this.socket = null;
            console.error(`Failed to connect to syslog at ${this.host}:${this.port}: ${error.message}`);
        }

        this.connected = null;
        resolve(!!this.socket);
        return promise;
    }

    async log (entry) {
        // Ignore below threshold
        if (entry.level > this.level) return true;

        if (!this.socket) {
            await this.connect();
            if (!this.socket) return false;
        }

        const message = this.formatMessage(entry);
        const priority = this.facility + entry.level;
        const syslogMessage = `<${priority}>${this.tag}[${Deno.pid}]: ${message}\n`;

        try {
            await this.socket.write(new TextEncoder().encode(syslogMessage));
            return true;
        } catch (error) {
            console.error('Failed to send to syslog');
            try { this.socket.close(); }
            catch (_) { /**/ }
            this.socket = null;
            return false;
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
            const res = this.socket.close();
            this.socket = null;
        }
    }
}

/**
 * Main Logger class that manages backends and log entries
 */
export class Logger {
    constructor (options = {}) {
        this.console = null;
        this.syslog = null;
        this.fallback = null;
        this.backends = [];
        this.component = options.component || 'server';
        this.requestIdCounter = 0;

        // Initialize backends based on configuration
        const target = options.target || 'console';

        if (target === 'console' || target === 'both') {
            this.console = new ConsoleBackend(options);
        } else if (target === 'syslog') {
            this.fallback = new ConsoleBackend(options);
        }

        if (target === 'syslog' || target === 'both') {
            this.syslog = new SyslogBackend(options);
        }
    }

	// Allow logging as another component
    asComponent (component, fn) {
        const previous = this.component;
        this.component = component;
        fn();
        this.component = previous;
    }

    /**
     * Generate a unique request ID for tracking
     */
    generateRequestId () {
        return `req-${++this.requestIdCounter}`;
    }

    #getMessageContext (params) {
        const { message, context } = params.reduce((state, param) => {
            if (typeof param === 'string') state.message.push(param);
            else state.context ??= param;
            return state;
        }, { message: [], context: null });
        return { message: message.join(' '), context: context ?? {} };
    }

    /**
     * Log an error message
     */
    error (...params) {
        const { message, context } = this.#getMessageContext(params);
        this.log(LOG_LEVELS.ERROR, message, context);
    }

    /**
     * Log a warning message
     */
    warn (...params) {
        const { message, context } = this.#getMessageContext(params);
        this.log(LOG_LEVELS.WARN, message, context);
    }

    /**
     * Log an info message
     */
    info (...params) {
        const { message, context } = this.#getMessageContext(params);
        this.log(LOG_LEVELS.INFO, message, context);
    }

    /**
     * Log a debug message
     */
    debug (...params) {
        const { message, context } = this.#getMessageContext(params);
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

        if (this.console) this.console.log(entry);
        if (this.syslog) this.syslog.log(entry).then((result) => {
            if (!result && this.fallback) this.fallback.log(entry);
        }, (err) => console.error(`Logging error: ${err.message}`));
    }

    /**
     * Internal log method
     */
    log (level, ...params) {
        const { message, context } = this.#getMessageContext(params);
        switch (level) {
        case LOG_LEVELS.DEBUG:
        case LOG_LEVELS.INFO:
        case LOG_LEVELS.WARN:
        case LOG_LEVELS.ERROR:
            break;
        case 'debug': level = LOG_LEVELS.DEBUG; break;
        case 'warn': level = LOG_LEVELS.WARN; break;
        case 'error': level = LOG_LEVELS.ERROR; break;
        default:
            level = LOG_LEVELS.INFO; break;
        }
        const entry = {
            timestamp: Date.now(),
            level,
            component: this.component,
            message,
            ...context,
        };

        if (this.console) this.console.log(entry);
        if (this.syslog) this.syslog.log(entry).then((result) => {
            if (!result && this.fallback) this.fallback.log(entry);
        }, (err) => console.error(`Logging error: ${err.message}`));
    }

    /**
     * Close all backends (for graceful shutdown)
     */
    async close () {
        const promises = [this.console, this.syslog, this.fallback]
            .filter(b => typeof b?.close === 'function')
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
