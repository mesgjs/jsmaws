/**
 * JSMAWS Router
 * Handles request routing based on SLID configuration
 *
 * Routes are matched in order, with the first matching route being used.
 * Supports:
 * - Static file serving
 * - Internal (worker-based) applet requests
 * - External (subprocess-based) applet requests
 * - Virtual routes with regex matching
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

import { NANOS } from './vendor.esm.js';

/**
 * Route specification parsed from SLID configuration
 */
class Route {
	constructor (spec) {
		this.spec = spec;
		this.pathParts = [];
		this.regexPattern = null;
		this.class = 'static'; // 'static', 'int', 'ext'
		this.method = ['get']; // HTTP methods
		this.ws = false; // WebSocket support
		this.response = null; // Response code or redirect
		this.href = null; // Redirect target
		this.app = null; // Applet path
		this.root = null; // Local root directory
		this.headers = []; // Response headers
		this.isVirtual = false; // Virtual route (no filesystem check)

		this.parseSpec();
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

		// Parse service class
		const classSpec = this.spec.at('class');
		if (classSpec) {
			this.class = classSpec;
		}

		// Parse HTTP methods
		const methodSpec = this.spec.at('method');
		if (methodSpec) {
			this.method = this.parseMethod(methodSpec);
		}

		// Parse WebSocket flag
		const wsSpec = this.spec.at('ws');
		if (wsSpec) {
			this.ws = wsSpec === true || wsSpec === '@t';
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

		// Parse applet path
		const appSpec = this.spec.at('app');
		if (appSpec) {
			this.app = appSpec;
			this.isVirtual = true; // If app is specified, it's a virtual route
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
			} else if (part.startsWith('@*')) {
				return { type: 'applet-any' };
			} else if (part.startsWith('@')) {
				return { type: 'applet-named', name: part.substring(1) };
			} else {
				return { type: 'literal', value: part };
			}
		});
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
	 * Check if this route matches a request
	 * @param {string} pathname URL pathname
	 * @param {string} method HTTP method
	 * @returns {Object|null} Match result with extracted parameters, or null if no match
	 */
	match (pathname, method) {
		// Check method
		if (!this.method.includes('any') && !this.method.includes(method.toLowerCase())) {
			return null;
		}

		// Check regex pattern if present
		if (this.regexPattern && !this.regexPattern.test(pathname)) {
			return null;
		}

		// If no path parts, only regex matching applies
		if (this.pathParts.length === 0) {
			if (this.regexPattern) {
				return { params: {}, app: this.app, tail: '' };
			}
			return null;
		}

		// Match path parts
		const urlParts = pathname.split('/').filter(p => p.length > 0);
		const result = {
			params: {},
			app: this.app,
			tail: '',
		};

		let urlIndex = 0;

		for (let i = 0; i < this.pathParts.length; i++) {
			const part = this.pathParts[i];

			if (part.type === 'literal') {
				if (urlIndex >= urlParts.length || urlParts[urlIndex] !== part.value) {
					return null;
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
				result.app = part.name;
				urlIndex++;
			} else if (part.type === 'applet-any') {
				if (urlIndex >= urlParts.length) {
					return null;
				}
				result.app = urlParts[urlIndex];
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

		return result;
	}
}

/**
 * Router class for managing routes and matching requests
 */
class Router {
	constructor (config = new NANOS(), fsRouting = false) {
		this.config = config;
		this.routes = [];
		this.appRoot = '';
		this.root = '';
		this.fsRouting = fsRouting;

		this.parseConfig();
	}

	/**
	 * Parse configuration from NANOS object
	 */
	parseConfig () {
		// Parse app root
		const appRootSpec = this.config.at('appRoot');
		if (appRootSpec) {
			this.appRoot = appRootSpec.endsWith('/') ? appRootSpec : appRootSpec + '/';
		}

		// Parse default root
		const rootSpec = this.config.at('root');
		if (rootSpec) {
			this.root = rootSpec.endsWith('/') ? rootSpec : rootSpec + '/';
		}

		// Parse routes - routes is a NANOS containing route specifications
		const routesSpec = this.config.at('routes');
		if (routesSpec && routesSpec instanceof NANOS) {
			// Iterate through NANOS values (each is a route specification)
			this.routes = [];
			for (const routeSpec of routesSpec.values()) {
				const route = new Route(routeSpec);

				// Skip filesystem routes when fsRouting is disabled
				if (!this.fsRouting && this.isFilesystemRoute(route)) {
					console.warn(`Skipping filesystem route (fsRouting disabled): ${route.spec.at('path', '(no path)')}`);
					continue;
				}

				this.routes.push(route);
			}
		}
	}

	/**
	 * Check if a route requires filesystem access
	 * @param {Route} route Route to check
	 * @returns {boolean} True if route requires filesystem access
	 */
	isFilesystemRoute (route) {
		// Routes with @name or @* path components require filesystem access
		// (shouldn't be used with explicit app field, but check first just in case)
		for (const part of route.pathParts) {
			if (part.type === 'applet-named' || part.type === 'applet-any') {
				return true;
			}
		}

		// Virtual routes (explicit app field) don't require filesystem access
		if (route.isVirtual) {
			return false;
		}

		// Routes that are neither FS nor virtual don't resolve to an applet
		// These are typically static file routes or response-only routes
		// They don't require filesystem access for route resolution
		return false;
	}

	/**
	 * Find the first matching route for a request
	 * @param {string} pathname URL pathname
	 * @param {string} method HTTP method
	 * @returns {Object|null} Route match result or null
	 */
	findRoute (pathname, method = 'GET') {
		for (const route of this.routes) {
			const match = route.match(pathname, method);
			if (match) {
				return {
					route,
					match,
				};
			}
		}
		return null;
	}

	/**
	 * Update router configuration
	 * @param {NANOS} config New configuration
	 * @param {boolean} fsRouting Whether filesystem routing is enabled
	 */
	updateConfig (config, fsRouting = false) {
		this.config = config;
		this.routes = [];
		this.appRoot = '';
		this.root = '';
		this.fsRouting = fsRouting;
		this.parseConfig();
	}
}

// Web Worker message handler (when running as a worker)
if (typeof self !== 'undefined' && self.postMessage) {
	let router = null;

	self.onmessage = async (event) => {
		const { type, id, data } = event.data;

		try {
			switch (type) {
				case 'init': {
					// Initialize router with configuration
					const { config, fsRouting } = data;
					router = new Router(config, fsRouting);
					self.postMessage({ type: 'init-res', id, success: true });
					break;
				}

				case 'config': {
					// Update router configuration
					const { config, fsRouting } = data;
					if (router) {
						router.updateConfig(config, fsRouting);
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

					const result = router.findRoute(pathname, method);
					self.postMessage({
						type: 'route-res',
						id,
						success: true,
						result: result ? {
							route: {
								class: result.route.class,
								method: result.route.method,
								ws: result.route.ws,
								response: result.route.response,
								href: result.route.href,
								app: result.route.app,
								root: result.route.root,
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
