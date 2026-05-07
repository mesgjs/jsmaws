/**
 * JSMAWS Built-in Static File Mod-App
 * Serves static files from the configured root directory
 *
 * Features:
 * - Path traversal prevention via Deno.realPath() validation
 * - HTTP Range request support for resumable downloads
 * - Proper MIME type detection from file extension
 * - Chunked responses for large files with backpressure handling
 * - Security: Ensures resolved path stays within configured root
 *
 * Protocol: PolyTransport channel API via globalThis.JSMAWS.server
 * - Reads 'req' message (JSON) for request metadata
 * - Writes 'res' message (JSON text) for response status + headers
 * - Writes 'res-frame' messages (binary Uint8Array) for response body chunks
 * - Signals end-of-stream with zero-data 'res-frame' (undefined data, default eom:true)
 * - Writes 'res-error' message (JSON text) on error
 *
 * Copyright 2025-2026 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Send a 404 Not Found response
 * @param {object} server - PolyTransport channel (globalThis.JSMAWS.server)
 */
async function send404 (server) {
	await server.write('res', JSON.stringify({
		status: 404,
		headers: { 'content-type': 'text/plain' },
	}));
	await server.write('res-frame', 'File not found');
	await server.write('res-frame', null);
}

/**
 * Send a 416 Range Not Satisfiable response
 * @param {object} server - PolyTransport channel (globalThis.JSMAWS.server)
 * @param {number} fileSize - Total file size for Content-Range header
 */
async function send416 (server, fileSize) {
	await server.write('res', JSON.stringify({
		status: 416,
		headers: { 'Content-Range': `bytes */${fileSize}` },
	}));
	await server.write('res-frame', null);
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
 * @param {object} server - PolyTransport channel
 * @param {string} resolvedPath - Absolute resolved file path
 * @param {number} fileSize - File size in bytes
 * @param {string} contentType - MIME type for Content-Type header
 * @param {number} chunkSize - Maximum bytes per res-frame chunk
 */
async function handleFullRequest (server, resolvedPath, fileSize, contentType, chunkSize) {
	// Try to open file - if it fails (e.g., permission denied), return 404
	let file;
	try {
		file = await Deno.open(resolvedPath, { read: true });
	} catch (_error) {
		await send404(server);
		return;
	}

	// Send response metadata
	await server.write('res', JSON.stringify({
		status: 200,
		headers: {
			'content-type': contentType,
			'content-length': fileSize.toString(),
			'accept-ranges': 'bytes',
		},
	}));

	// For larger files, send file data in chunks
	const buffer = new Uint8Array(Math.min(fileSize, chunkSize));

	for (;;) {
		const bytesRead = await file.read(buffer);
		if (bytesRead === null) break;

		const chunk = buffer.slice(0, bytesRead);
		await server.write('res-frame', chunk);
	}

	// Send end-of-stream signal
	await server.write('res-frame', null);

	file.close();
}

/**
 * Handle Range request for resumable downloads
 * @param {object} server - PolyTransport channel
 * @param {string} resolvedPath - Absolute resolved file path
 * @param {number} fileSize - Total file size in bytes
 * @param {string} rangeHeader - Value of the Range request header
 * @param {string} contentType - MIME type for Content-Type header
 * @param {number} chunkSize - Maximum bytes per res-frame chunk
 */
async function handleRangeRequest (server, resolvedPath, fileSize, rangeHeader, contentType, chunkSize) {
	// Parse Range header: "bytes=start-end"
	const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
	if (!match) {
		await send416(server, fileSize);
		return;
	}

	const start = parseInt(match[1]);
	const end = match[2] ? parseInt(match[2]) : fileSize - 1;

	if (start >= fileSize || end >= fileSize || start > end) {
		await send416(server, fileSize);
		return;
	}

	const rangeSize = end - start + 1;

	// Try to open file - if it fails (e.g., permission denied), return 404
	let file;
	try {
		file = await Deno.open(resolvedPath, { read: true });
		await file.seek(start, Deno.SeekMode.Start);
	} catch (_error) {
		await send404(server);
		return;
	}

	// Send response metadata with partial content headers
	await server.write('res', JSON.stringify({
		status: 206,
		headers: {
			'content-type': contentType,
			'content-length': rangeSize.toString(),
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'accept-ranges': 'bytes',
		},
	}));

	// Send range data in chunks
	const buffer = new Uint8Array(chunkSize);
	let remaining = rangeSize;

	while (remaining > 0) {
		const toRead = Math.min(chunkSize, remaining);
		const bytesRead = await file.read(buffer.subarray(0, toRead));
		if (bytesRead === null) break;

		const chunk = buffer.slice(0, bytesRead);
		remaining -= bytesRead;

		await server.write('res-frame', chunk);
	}

	// Send end-of-stream signal
	await server.write('res-frame', null);

	file.close();
}

/**
 * Main mod-app entry point
 * Called by bootstrap after environment setup and JSMAWS namespace is frozen
 * @param {object} _setupData - Setup data from bootstrap (appPath, mode, etc.)
 */
export default async function (_setupData) {
	const server = globalThis.JSMAWS.server;

	// Read the incoming request
	const reqMsg = await server.read({ only: 'req', decode: true });
	if (!reqMsg) return;

	let requestData;
	await reqMsg.process(() => {
		requestData = JSON.parse(reqMsg.text);
	});

	const { headers, routeTail, maxChunkSize, config } = requestData;

	try {
		// Validate that root was provided
		const root = config?.root;
		if (!root) {
			await send404(server);
			return;
		}

		// Get configuration
		const mimeTypes = config?.mimeTypes || {};
		const explicitMimeType = config?.mimeType || null;
		const chunkSize = maxChunkSize || 65536;

		// Construct file path from routeTail
		const filePath = `${root}${routeTail}`;

		// Security: Prevent directory traversal
		const resolvedPath = await Deno.realPath(filePath).catch(() => null);
		if (!resolvedPath || !resolvedPath.startsWith(root)) {
			await send404(server);
			return;
		}

		// Check if file exists and is readable
		const stat = await Deno.stat(resolvedPath).catch(() => null);

		if (!stat || !stat.isFile) {
			await send404(server);
			return;
		}

		// Determine MIME type from extension (first-match strategy)
		const contentType = getMimeType(filePath, mimeTypes, explicitMimeType);

		// Handle Range requests for resumable downloads
		const rangeHeader = headers['Range'] || headers['range'];
		if (rangeHeader) {
			await handleRangeRequest(server, resolvedPath, stat.size, rangeHeader, contentType, chunkSize);
		} else {
			await handleFullRequest(server, resolvedPath, stat.size, contentType, chunkSize);
		}

	} catch (error) {
		await server.write('res-error', JSON.stringify({
			error: error.message,
			stack: error.stack,
		}));
	}
}
