/**
 * JSMAWS Built-in Static File Applet
 * Serves static files from the configured root directory
 * 
 * Features:
 * - Path traversal prevention via Deno.realPath() validation
 * - HTTP Range request support for resumable downloads
 * - Proper MIME type detection from file extension
 * - Chunked responses for large files with backpressure handling
 * - Security: Ensures resolved path stays within configured root
 * 
 * Copyright 2025 Kappa Computer Solutions, LLC and Brian Katzung
 */

/**
 * Send 404 Not Found response
 */
function send404 (id) {
	self.postMessage({
		type: 'frame',
		id,
		mode: 'response',
		status: 404,
		headers: { 'Content-Type': 'text/plain' },
		data: new TextEncoder().encode('File not found'),
		final: true,
		keepAlive: false
	});
	self.close();
}

/**
 * Send 416 Range Not Satisfiable response
 */
function send416 (id, fileSize) {
	self.postMessage({
		type: 'frame',
		id,
		mode: 'response',
		status: 416,
		headers: {
			'Content-Range': `bytes */${fileSize}`
		},
		data: null,
		final: true,
		keepAlive: false
	});
	self.close();
}

/**
 * Determine MIME type from file extension using first-match strategy
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
 */
async function handleFullRequest (id, resolvedPath, fileSize, contentType, chunkSize) {
	// Try to open file - if it fails (e.g., permission denied), return 404
	let file;
	try {
		file = await Deno.open(resolvedPath, { read: true });
	} catch (_error) {
		send404(id);
		return;
	}

	const message = {
		type: 'frame',
		id,
		mode: 'response',
		status: 200,
		headers: {
			'content-type': contentType,
			'content-length': fileSize.toString(),
			'accept-ranges': 'bytes'
		},
	};

	// For small files (<= chunkSize), send complete frame in single message
	if (fileSize <= chunkSize) {
		const buffer = new Uint8Array(fileSize);
		await file.read(buffer);
		file.close();

		console.debug('@static sending one-and-done');
		self.postMessage({
			...message,
			data: buffer,
			final: true,
			keepAlive: false
		});
		self.close();
		return;
	}

	// For larger files, send first frame message with headers
	console.debug('@static sending response frame');
	self.postMessage({
		...message,
		data: null,
		keepAlive: false
		// final omitted (defaults to false)
	});

	// Send file data chunks via frame messages
	const buffer = new Uint8Array(chunkSize);
	let final = false;

	console.debug('@static chunking file content');
	for (;;) {
		const bytesRead = await file.read(buffer);
		if (bytesRead === null) break;

		const chunk = buffer.slice(0, bytesRead);
		final = bytesRead < chunkSize;

		self.postMessage({
			type: 'frame',
			id,
			data: chunk,
			...(final && { final })
			// mode omitted (already established)
			// keepAlive omitted (sticky from first frame message)
			// final omitted unless last chunk (defaults to false)
		});

		if (final) break;

		// Yield to event loop
		await new Promise(resolve => setTimeout(resolve, 0));
	}

	// Send "final" if not sent before (e.g. if fileSize % chunkSize === 0)
	if (!final) {
		self.postMessage({
			type: 'frame',
			id,
			data: null,
			final: true,
		});
	}

	file.close();
	self.close();
}

/**
 * Handle Range request for resumable downloads
 */
async function handleRangeRequest (id, resolvedPath, fileSize, rangeHeader, contentType, chunkSize) {
	// Parse Range header: "bytes=start-end"
	const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
	if (!match) {
		send416(id, fileSize);
		return;
	}

	const start = parseInt(match[1]);
	const end = match[2] ? parseInt(match[2]) : fileSize - 1;

	if (start >= fileSize || end >= fileSize || start > end) {
		send416(id, fileSize);
		return;
	}

	const rangeSize = end - start + 1;
	
	// Try to open file - if it fails (e.g., permission denied), return 404
	let file;
	try {
		file = await Deno.open(resolvedPath, { read: true });
		await file.seek(start, Deno.SeekMode.Start);
	} catch (_error) {
		send404(id);
		return;
	}

	// Send first frame message with partial content headers
	self.postMessage({
		type: 'frame',
		id,
		mode: 'response',
		status: 206,
		headers: {
			'Content-Type': contentType,
			'Content-Length': rangeSize.toString(),
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'Accept-Ranges': 'bytes'
		},
		data: null,
		keepAlive: false
		// final omitted (defaults to false)
	});

	// Send range data chunks via frame messages
	const buffer = new Uint8Array(chunkSize);
	let remaining = rangeSize;

	while (remaining > 0) {
		const toRead = Math.min(chunkSize, remaining);
		const bytesRead = await file.read(buffer.subarray(0, toRead));
		if (bytesRead === null) break;

		const chunk = buffer.slice(0, bytesRead);
		remaining -= bytesRead;
		const isLastChunk = remaining === 0;

		self.postMessage({
			type: 'frame',
			id,
			data: chunk,
			...(isLastChunk && { final: true })
			// mode omitted (already established)
			// keepAlive omitted (sticky from first frame)
			// final omitted unless last chunk (defaults to false)
		});

		if (isLastChunk) break;

		await new Promise(resolve => setTimeout(resolve, 0));
	}

	// Send final frame message if needed
	if (rangeSize % chunkSize === 0) {
		self.postMessage({
			type: 'frame',
			id,
			data: null,
			final: true
		});
	}

	file.close();
	self.close();
}

/**
 * Main message handler
 */
console.debug('@static loaded');
self.onmessage = async (event) => {
	const { type, id, url, headers, routeParams, routeTail, config } = event.data;
	console.debug(`@static ${id} type ${type} root ${config?.root} tail ${routeTail}`);

	if (type !== 'request') return;

	try {
		// Validate that root was provided
		const root = config?.root;
		if (!root) {
			send404(id);
			return;
		}

		// Get configuration
		const mimeTypes = config?.mimeTypes || {};
		const explicitMimeType = config?.mimeType || null;
		const chunkSize = event.data.maxChunkSize || 65536; // Use maxChunkSize from request

		// Construct file path from routeTail
		const filePath = `${root}${routeTail}`;

		// Security: Prevent directory traversal
		const resolvedPath = await Deno.realPath(filePath).catch(() => null);
		if (!resolvedPath || !resolvedPath.startsWith(root)) {
			send404(id);
			return;
		}

		// Check if file exists and is readable
		const stat = await Deno.stat(resolvedPath).catch(() => null);

		if (!stat || !stat.isFile) {
			send404(id);
			return;
		}

		// Determine MIME type from extension (first-match strategy)
		const contentType = getMimeType(filePath, mimeTypes, explicitMimeType);

		// Handle Range requests for resumable downloads
		const rangeHeader = headers['Range'] || headers['range'];
		if (rangeHeader) {
			await handleRangeRequest(id, resolvedPath, stat.size, rangeHeader, contentType, chunkSize);
		} else {
			await handleFullRequest(id, resolvedPath, stat.size, contentType, chunkSize);
		}

	} catch (error) {
		self.postMessage({
			type: 'error',
			id,
			error: error.message,
			stack: error.stack
		});
		self.close();
	}
};
