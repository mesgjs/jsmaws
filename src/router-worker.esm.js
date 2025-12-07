/**
 * JSMAWS Router Worker
 * Handles request routing based on SLID configuration
 *
 * Routes are matched in order, with the first matching route being used.
 * 
 * Route Types:
 * - Filesystem routes: Contain @name or @* applet components (require filesystem access)
 * - Virtual routes: Have explicit app property (including @static) or response property
 * - Response routes: Virtual routes with response code (and possibly href for redirects)
 * 
 * Supports:
 * - Literal path matching
 * - Parameter matching (:name, :?name, :*)
 * - Applet path matching (@name, @*)
 * - Regex pattern matching
 * - HTTP method filtering
 * - Pool-based request routing
 * - Response codes and redirects
 * - Static file serving via @static applet
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';
import { Configuration } from './configuration.esm.js';

/**
 * Route specification parsed from SLID configuration
 */
class Route {
	constructor (spec, config = null) {
		this.spec = spec;
		this.config = config; // Configuration instance
		this.pathParts = [];
		this.regexPattern = null;
		this.pool = null; // Pool name for this route
		this.method = ['get']; // HTTP methods
		this.response = null; // Response code or redirect
		this.href = null; // Redirect target
		this.app = null; // Applet path (or @static for static files)
		this.root = null; // Local root directory
		this.headers = new NANOS(); // Response headers
		this.isFilesystem = false; // Filesystem route (requires FS access)
		this.isVirtual = false; // Virtual route (explicit app or response)

		this.parseSpec();
	}

	/**
	 * Classify route as filesystem, virtual, or neither
	 * 
	 * Classification rules:
	 * - Filesystem route: Contains @name or @* applet component (regardless of app property)
	 * - Virtual route: Has non-empty app property (including @static) OR has response property
	 * - Response routes are a variation of virtual routes
	 */
	classifyRoute () {
		// Check for applet components in path
		for (const part of this.pathParts) {
			if (part.type === 'applet-named' || part.type === 'applet-any') {
				this.isFilesystem = true;
				this.isVirtual = false;
				return;
			}
		}

		// If no applet components, check for explicit app property or response
		if (this.app || this.response) {
			this.isFilesystem = false;
			this.isVirtual = true;
			return;
		}

		// Neither filesystem nor virtual - invalid route
		this.isFilesystem = false;
		this.isVirtual = false;
		console.warn(`Route has no applet resolution mechanism: ${this.spec.at('path', '(no path)')}`);
	}

	/**
	 * Check if this route fully matches a request (including filesystem verification for FS routes)
	 * @param {string} pathname URL pathname
	 * @param {string} method HTTP method
	 * @returns {Promise<Object|null>} Match result with extracted parameters, or null if no match
	 */
	async match (pathname, method) {
		const routingConfig = this.config?.routing;
		const fsRouting = routingConfig?.fsRouting;
		const rawRoot = this.root || routingConfig?.root;
		const root = rawRoot.endsWith('/') ? rawRoot : (rawRoot + '/');
		if (this.isFilesystem && (!fsRouting || !root)) {
			// Void ex facie
			return null;
		}

		// First, try path matching
		const pathMatch = this.matchPath(pathname, method);
		if (!pathMatch) {
			return null;
		}

		// Attach local or global request root for both FS and virtual routes
		pathMatch.root = root ? new URL(root, import.meta.url).pathname : null;

		// For filesystem routes, also verify the file exists
		if (this.isFilesystem) {
			return await this.verifyFilesystem(pathMatch);
		}

		// For non-filesystem routes, path match is sufficient
		return pathMatch;
	}

	/**
	 * Check if this route's path matches a request
	 * @param {string} pathname URL pathname
	 * @param {string} method HTTP method
	 * @returns {Object|null} Match result with extracted parameters, or null if no match
	 */
	matchPath (pathname, method) {
		// Skip filesystem routes when fsRouting is disabled
		if (this.isFilesystem && !this.config?.routing?.fsRouting) {
			return null;
		}

		// Check method
		if (!this.method.includes('any') && !this.method.includes(method.toLowerCase())) {
			return null;
		}

		// Check regex pattern if present and capture groups
		let regexMatch = null;
		if (this.regexPattern) {
			regexMatch = pathname.match(this.regexPattern);
			if (!regexMatch) {
				return null;
			}
		}

		// If no path parts, only regex matching applies
		if (this.pathParts.length === 0) {
			if (this.regexPattern && regexMatch) {
				// Use regex captures for app, tail, and params
				const result = {
					params: regexMatch.groups || {},
					app: this.app || regexMatch[1] || null,
					tail: regexMatch[2] || '',
					pool: this.pool,
					response: this.response,
					href: this.href
				};
				return result;
			}
			return null;
		}

		// Match path parts
		const urlParts = pathname.split('/').filter(p => p.length > 0);
		const result = {
			params: {},
			app: this.app,
			tail: '',
			pool: this.pool,
			response: this.response,
			href: this.href,
		};

		let urlIndex = 0;
		let prePath = []; // Track pre-applet path parts for filesystem routes

		for (let i = 0; i < this.pathParts.length; i++) {
			const part = this.pathParts[i];

			if (part.type === 'literal') {
				if (urlIndex >= urlParts.length || urlParts[urlIndex] !== part.value) {
					return null;
				}
				// Track literal parts before applet for filesystem path construction
				if (!result.app || result.app === this.app) {
					prePath.push(urlParts[urlIndex]);
				}
				urlIndex++;
			} else if (part.type === 'param') {
				if (urlIndex >= urlParts.length) {
					return null;
				}
				result.params[part.name] = urlParts[urlIndex];
				urlIndex++;
			} else if (part.type === 'applet-named') {
				if (urlIndex >= urlParts.length || urlParts[urlIndex] !== part.name) {
					return null;
				}
				// For filesystem routes, construct full applet path
				if (this.isFilesystem && !this.root) {
					result.app = [...prePath, part.name].join('/');
				} else {
					result.app = part.name;
				}
				urlIndex++;
			} else if (part.type === 'applet-any') {
				if (urlIndex >= urlParts.length) {
					return null;
				}
				// For filesystem routes, construct full applet path
				if (this.isFilesystem && !this.root) {
					result.app = [...prePath, urlParts[urlIndex]].join('/');
				} else {
					result.app = urlParts[urlIndex];
				}
				urlIndex++;
			} else if (part.type === 'optional-param') {
				if (urlIndex < urlParts.length) {
					result.params[part.name] = urlParts[urlIndex];
					urlIndex++;
				}
			} else if (part.type === 'tail') {
				// Consume remaining parts as tail
				result.tail = urlParts.slice(urlIndex).join('/');
				urlIndex = urlParts.length;
				break;
			}
		}

		// Check if all URL parts were consumed
		if (urlIndex !== urlParts.length) {
			return null;
		}

		// Merge regex capture groups into params if present
		if (regexMatch && regexMatch.groups) {
			result.params = { ...result.params, ...regexMatch.groups };
		}

		return result;
	}

	/**
	 * Parse method specification
	 * @param {string|NANOS} methodSpec Method specification
	 * @returns {Array} Array of lowercase method names
	 */
	parseMethod (methodSpec) {
		if (typeof methodSpec === 'string') {
			if (methodSpec === 'any') {
				return ['any'];
			} else if (methodSpec === 'read') {
				return ['get', 'head'];
			} else if (methodSpec === 'write') {
				return ['patch', 'post', 'put'];
			} else if (methodSpec === 'modify') {
				return ['delete', 'patch', 'put'];
			}
			return [methodSpec.toLowerCase()];
		}

		if (methodSpec instanceof NANOS) {
			// Iterate through NANOS values
			const methods = [];
			for (const m of methodSpec.values()) {
				if (m === 'read') {
					methods.push('get', 'head');
				} else if (m === 'write') {
					methods.push('patch', 'post', 'put');
				} else if (m === 'modify') {
					methods.push('delete', 'patch', 'put');
				} else {
					methods.push(m.toLowerCase());
				}
			}
			return methods;
		}

		return ['get'];
	}

	/**
	 * Parse path specification into parts
	 * @param {string} pathSpec Path specification like "api/:id/users"
	 * @returns {Array} Array of path parts with metadata
	 */
	parsePath (pathSpec) {
		if (!pathSpec) return [];

		const parts = pathSpec.split('/').filter(p => p.length > 0);
		return parts.map(part => {
			if (part.startsWith(':?')) {
				return { type: 'optional-param', name: part.substring(2) };
			} else if (part === ':*') {
				return { type: 'tail' };
			} else if (part.startsWith(':')) {
				return { type: 'param', name: part.substring(1) };
			} else if (part === '@*') {
				return { type: 'applet-any' };
			} else if (part.startsWith('@')) {
				return { type: 'applet-named', name: part.substring(1) };
			} else {
				return { type: 'literal', value: part };
			}
		});
	}

	/**
	 * Parse route specification from NANOS object
	 */
	parseSpec () {
		// Parse path specification
		const pathSpec = this.spec.at('path');
		if (pathSpec) {
			this.pathParts = this.parsePath(pathSpec);
		}

		// Parse regex pattern
		const regexSpec = this.spec.at('regex');
		if (regexSpec) {
			try {
				this.regexPattern = new RegExp(regexSpec);
			} catch (error) {
				console.error(`Invalid regex pattern: ${regexSpec}`, error);
			}
		}

		// Parse pool name
		const poolSpec = this.spec.at('pool');
		if (poolSpec) {
			this.pool = poolSpec;
		}

		// Parse HTTP methods
		const methodSpec = this.spec.at('method');
		if (methodSpec) {
			this.method = this.parseMethod(methodSpec);
		}

		// Parse response code
		const responseSpec = this.spec.at('response');
		if (responseSpec) {
			this.response = responseSpec;
		}

		// Parse redirect href
		const hrefSpec = this.spec.at('href');
		if (hrefSpec) {
			this.href = hrefSpec;
		}

		// Parse applet path (including @static for static file serving)
		const appSpec = this.spec.at('app');
		if (appSpec) {
			this.app = appSpec;
		}

		// Parse local root
		const rootSpec = this.spec.at('root');
		if (rootSpec) {
			this.root = rootSpec;
		}

		// Parse response headers - work with NANOS directly
		const headersSpec = this.spec.at('headers');
		if (headersSpec && headersSpec instanceof NANOS) {
			this.headers = headersSpec;
		}

		// Classify route type based on parsed data
		this.classifyRoute();
	}

	/**
	 * Set configuration instance
	 * @param {Configuration} config Configuration instance
	 */
	setConfig (config) {
		this.config = config;
	}

	/**
		* Verify filesystem applet route exists (async)
		* This method should be called after matchPath() for filesystem routes
		* @param {Object} match from matchPath()
		* @returns {Promise<Object|null>} Match result with resolved app path, or null if not found
		*/
	async verifyFilesystem (match) {
		if (!this.isFilesystem || !match || !match.app) {
			return match;
		}

		if (!this.config) {
			throw new Error('Route configuration not set');
		}

		const root = match.root;
		if (!root) {
			throw new Error('No root path for filesystem verification');
		}

		// If appPath already has a .js extension, check it directly
		const appPath = match.app;
		if (appPath.endsWith('.js')) {
			const fullPath = `${root}${appPath}`;
			try {
				const stat = await Deno.stat(fullPath);
				if (stat.isFile) {
					// Return FULL absolute path for responder to load
					match.app = fullPath;
					return match;
				}
			} catch (error) {
				// File doesn't exist
				return null;
			}
		}

		// Try each extension in order
		// Note: Even if appPath exists as a directory, we still check for appPath.esm.js, appPath.js
		const extensions = this.config.routing.extensions;
		for (const ext of extensions) {
			const fullPath = `${root}${appPath}${ext}`;
			try {
				const stat = await Deno.stat(fullPath);
				if (stat.isFile) {
					// File exists, return FULL absolute path for responder to load
					match.app = fullPath;
					return match;
				}
			} catch (_error) {
				// File doesn't exist with this extension, try next
				continue;
			}
		}

		// No file found with any extension
		return null;
	}
}

/**
	* Router class for managing routes and matching requests
	*/
class Router {
	constructor (config) {
		this.config = config; // Configuration instance
		this.routes = [];
		this.parseConfig();
	}

	/**
	 * Find the first matching route for a request
	 * @param {string} pathname URL pathname
	 * @param {string} method HTTP method
	 * @returns {Promise<Object|null>} Route match result or null
	 */
	async findRoute (pathname, method = 'GET') {
		for (const route of this.routes) {
			// Use the complete match() method which includes filesystem verification
			const match = await route.match(pathname, method);
			if (match) {
				// For virtual routes with relative app paths, resolve using appRoot
				const app = match.app;
				if (route.isVirtual && app && app !== '@static' && !app.startsWith('https://') && !app.startsWith('http://') && !app.startsWith('/')) {
					match.app = `${this.config.routing.appRoot}${match.app}`;
				}

				return {
					route,
					match,
				};
			}
		}
		return null;
	}

	/**
	 * Parse configuration and create routes
	 */
	parseConfig () {
		// Parse routes - routes is a NANOS containing route specifications
		const routesSpec = this.config.routes;
		if (routesSpec && routesSpec instanceof NANOS) {
			// Iterate through NANOS values (each is a route specification)
			this.routes = [];
			for (const routeSpec of routesSpec.values()) {
				const route = new Route(routeSpec, this.config);

				// Skip filesystem routes when fsRouting is disabled
				if (!this.config.routing.fsRouting && route.isFilesystem) {
					console.error(`Skipping filesystem route (fsRouting disabled): ${route.spec.at('path', '(no path)')}`);
					continue;
				}

				this.routes.push(route);
			}
		}
	}

	/**
	 * Update router configuration
	 * Configuration instance is updated externally; this just rebuilds routes
	 */
	updateConfig () {
		this.routes = [];
		this.parseConfig();
	}
}

// Web Worker message handler (when running as a worker)
if (typeof self !== 'undefined' && self.postMessage) {
	let router = null;
	let config = null;

	self.onmessage = async (event) => {
		const { type, id, data } = event.data;

		try {
			switch (type) {
				case 'init': {
					// Initialize router with configuration
					const { config: slidConfig } = data;
					config = Configuration.fromSLID(slidConfig);
					router = new Router(config);
					self.postMessage({ type: 'init-res', id, success: true });
					break;
				}

				case 'config': {
					// Update router configuration
					const { config: slidConfig } = data;
					if (router && slidConfig) {
						const nanosConfig = NANOS.parseSLID(slidConfig);
						config.updateConfig(nanosConfig);
						router.updateConfig();
						self.postMessage({ type: 'config-res', id, success: true });
					} else {
						throw new Error('Router not initialized');
					}
					break;
				}

				case 'route': {
					// Find matching route
					const { pathname, method } = data;
					if (!router) {
						throw new Error('Router not initialized');
					}

					const result = await router.findRoute(pathname, method);
					self.postMessage({
						type: 'route-res',
						id,
						success: true,
						result: result ? {
							route: {
								pool: result.route.pool,
								method: result.route.method,
								response: result.route.response,
								href: result.route.href, // target href for redirects
								app: result.route.app, // *route* app, *if present*
								root: result.route.root, // *route* root, *if present*
								isFilesystem: result.route.isFilesystem,
								isVirtual: result.route.isVirtual,
							},
							match: result.match,
						} : null,
					});
					break;
				}

				default:
					throw new Error(`Unknown message type: ${type}`);
			}
		} catch (error) {
			self.postMessage({
				type: `${type}-res`,
				id,
				success: false,
				error: error.message,
			});
		}
	};
}

export { Router, Route };
