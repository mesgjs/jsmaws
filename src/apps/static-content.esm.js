/**
 * JSMAWS Built-in Static File Mod-App (Fetch API)
 * Serves static files from the configured root directory
 *
 * Features:
 * - Path traversal prevention via Deno.realPath() validation
 * - HTTP Range request support for resumable downloads
 * - Proper MIME type detection from file extension
 * - Standard Response and ReadableStream-based file streaming
 * - Security: Ensures resolved path stays within configured root
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Send a 404 Not Found response
 * @returns {Response} Standard Response object
 */
function send404 () {
	return new Response('File not found', {
		status: 404,
		headers: { 'content-type': 'text/plain' },
	});
}

/**
 * Send a 416 Range Not Satisfiable response
 * @param {number} fileSize - Total file size for Content-Range header
 * @returns {Response} Standard Response object
 */
function send416 (fileSize) {
	return new Response(null, {
		status: 416,
		headers: { 'Content-Range': `bytes */${fileSize}` },
	});
}

/**
 * Determine MIME type from file extension using first-match strategy
 * @param {string} filePath - File path to check extension of
 * @param {object} mimeTypes - Map of extension to MIME type
 * @param {string|null} explicitMimeType - Explicit MIME type override
 * @returns {string} MIME type string
 */
function getMimeType (filePath, mimeTypes, explicitMimeType) {
	// Use explicit MIME type if provided
	if (explicitMimeType) {
		return explicitMimeType;
	}

	// First-match strategy: check each extension in order
	for (const [ext, mimeType] of Object.entries(mimeTypes)) {
		if (filePath.endsWith(ext)) {
			return mimeType;
		}
	}

	// Default fallback
	return 'application/octet-stream';
}

/**
 * Handle full file request (no Range header)
 * @param {string} resolvedPath - Absolute resolved file path
 * @param {number} fileSize - File size in bytes
 * @param {string} contentType - MIME type for Content-Type header
 * @param {number} chunkSize - Maximum bytes per chunk
 * @returns {Promise<Response>} Standard Response object
 */
async function handleFullRequest (resolvedPath, fileSize, contentType, chunkSize) {
	// Try to open file - if it fails (e.g., permission denied), return 404
	let file;

	try {
		file = await Deno.open(resolvedPath, { read: true });
	} catch (_error) {
		return send404();
	}

	// Create a standard ReadableStream to stream file chunks
	const stream = new ReadableStream({
		async pull (controller) {
			const buffer = new Uint8Array(chunkSize);

			try {
				const bytesRead = await file.read(buffer);

				if (bytesRead === null) {
					file.close();
					controller.close();
				} else {
					controller.enqueue(buffer.subarray(0, bytesRead));
				}
			} catch (error) {
				file.close();
				controller.error(error);
			}
		},
		cancel () {
			file.close();
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': contentType,
			'content-length': fileSize.toString(),
			'accept-ranges': 'bytes',
		},
	});
}

/**
 * Handle Range request for resumable downloads
 * @param {string} resolvedPath - Absolute resolved file path
 * @param {number} fileSize - Total file size in bytes
 * @param {string} rangeHeader - Value of the Range request header
 * @param {string} contentType - MIME type for Content-Type header
 * @param {number} chunkSize - Maximum bytes per chunk
 * @returns {Promise<Response>} Standard Response object
 */
async function handleRangeRequest (resolvedPath, fileSize, rangeHeader, contentType, chunkSize) {
	// Parse Range header: "bytes=start-end"
	const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);

	if (!match) {
		return send416(fileSize);
	}

	const start = parseInt(match[1]);
	const end = match[2] ? parseInt(match[2]) : fileSize - 1;

	if (start >= fileSize || end >= fileSize || start > end) {
		return send416(fileSize);
	}

	const rangeSize = end - start + 1;

	// Try to open file - if it fails (e.g., permission denied), return 404
	let file;
	try {
		file = await Deno.open(resolvedPath, { read: true });
		await file.seek(start, Deno.SeekMode.Start);
	} catch (_error) {
		return send404();
	}

	let remaining = rangeSize;

	// Create a standard ReadableStream to stream the requested range
	const stream = new ReadableStream({
		async pull (controller) {
			if (remaining <= 0) {
				file.close();
				controller.close();
				return;
			}

			const toRead = Math.min(chunkSize, remaining);
			const buffer = new Uint8Array(toRead);

			try {
				const bytesRead = await file.read(buffer);

				if (bytesRead === null) {
					file.close();
					controller.close();
				} else {
					remaining -= bytesRead;
					controller.enqueue(buffer.subarray(0, bytesRead));
				}
			} catch (error) {
				file.close();
				controller.error(error);
			}
		},
		cancel () {
			file.close();
		},
	});

	return new Response(stream, {
		status: 206,
		headers: {
			'content-type': contentType,
			'content-length': rangeSize.toString(),
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'accept-ranges': 'bytes',
		},
	});
}

export default {
	/**
	 * Standard Fetch Model entry point
	 * @param {Request} request - Standard Request object with attached JSMAWS metadata
	 * @param {object} _env - Environment variables
	 * @returns {Promise<Response>} Standard Response object
	 */
	async fetch (request, _env) {
		// Extract JSMAWS-specific metadata attached by bootstrap
		const { routeTail, config, maxChunkSize } = request;

		// Validate that root was provided
		const root = config?.root;

		if (!root) {
			return send404();
		}

		try {
			const mimeTypes = config?.mimeTypes || {};
			const explicitMimeType = config?.mimeType || null;
			const chunkSize = maxChunkSize || 65536;

			// Construct file path from routeTail
			const filePath = `${root}${routeTail}`;

			// Security: Prevent directory traversal
			const resolvedPath = await Deno.realPath(filePath).catch(() => null);

			if (!resolvedPath || !resolvedPath.startsWith(root)) {
				return send404();
			}

			// Check if file exists and is readable
			const stat = await Deno.stat(resolvedPath).catch(() => null);

			if (!stat || !stat.isFile) {
				return send404();
			}

			// Determine MIME type from extension (first-match strategy)
			const contentType = getMimeType(filePath, mimeTypes, explicitMimeType);

			// Handle Range requests for resumable downloads
			const rangeHeader = request.headers.get('Range') || request.headers.get('range');

			if (rangeHeader) {
				return await handleRangeRequest(resolvedPath, stat.size, rangeHeader, contentType, chunkSize);
			} else {
				return await handleFullRequest(resolvedPath, stat.size, contentType, chunkSize);
			}

		} catch (error) {
			return new Response(JSON.stringify({
				error: error.message,
				stack: error.stack,
			}), {
				status: 500,
				headers: { 'content-type': 'application/json' },
			});
		}
	},
};
