# IPC and Logging Update Plan

## Status: [APPROVED, COMPLETED]

## Overview

This document provides a detailed implementation plan for properly integrating the IPC protocol with console logging across operator, responder, and router processes, based on the requirements in [`arch/ipc-update.md`](ipc-update.md).

## Current State Analysis

### What Works
1. **IPC Protocol Foundation** ([`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js)):
   - SOH prefix (`\x01`) for IPC messages
   - SLID format with `[(...)]\n` boundary markers
   - `dataSize` parameter for binary data
   - `encodeLogLevel()` and `parseLogMessage()` functions exist

2. **Console Interception** ([`src/console-intercept.esm.js`](../src/console-intercept.esm.js)):
   - Intercepts all console methods (debug, info, log, warn, error)
   - Prefixes with `\x01[(log level)]\n` before calling original method
   - Applied in service processes via `ServiceProcess.start()`

3. **Service Process Base** ([`src/service-process.esm.js`](../src/service-process.esm.js)):
   - Calls `interceptConsole()` at startup (line 139)
   - IPC connection established via stdin/stdout

### Critical Issue: Non-Unified Buffering

**Current Implementation** (lines 179-278 in `ipc-protocol.esm.js`):
```javascript
this.textBuffer = '';              // String buffer for text
this.binaryBuffer = new Uint8Array(0);  // Separate binary buffer
this.binaryBytesNeeded = 0;        // Mode flag
```

**The Problem**:
- Uses **separate** text and binary buffers
- Switches between "text mode" and "binary mode"
- When in binary mode (lines 198-235), accumulates bytes in `binaryBuffer`
- **BUT**: Incoming `value` from `conn.read()` is always `Uint8Array`
- A single read might contain: partial SLID + binary data + next SLID start
- Current code can't handle this - it either decodes as text OR treats as binary

**Example Failure Scenario**:
```
Read 1: "\x01[(WREQ id=123 dataSize=1000)]\n" + first 500 bytes of binary
Read 2: next 500 bytes of binary + "\x01[(log info)]\n"
```

Current code would:
1. Decode Read 1 as text, parse SLID, set `binaryBytesNeeded=1000`
2. Switch to binary mode
3. Treat Read 2 entirely as binary (wrong!)
4. Miss the log message at the end of Read 2

### What's Missing

1. **Unified Buffering Strategy**:
   - ❌ Need single `Uint8Array` buffer for all incoming data
   - ❌ Need to segment buffer into text and binary regions
   - ❌ Need SLID-boundary awareness (accumulate until `)]\n`)
   - ❌ Need to handle multi-line console output
   - ❌ Need to handle I/O boundaries anywhere in the stream

2. **Operator Process** ([`src/operator.esm.js`](../src/operator.esm.js)):
   - ❌ No stdout/stderr monitoring for child processes
   - ❌ No log level tracking per stream
   - ❌ No forwarding of console output to logger

3. **Process Manager** ([`src/process-manager.esm.js`](../src/process-manager.esm.js)):
   - ✅ Monitors stderr with log level tracking (lines 232-265)
   - ❌ Does NOT monitor stdout at all
   - ❌ Log level tracking only for stderr (defaults to 'error')
   - ❌ No stdout monitoring means console.debug/info/log are lost

## Requirements from arch/ipc-update.md

1. **IPC Message Format**: `\x01[(/*SLID block */ dataSize=size)]\n` + optional binary data
2. **Console Message Format**: `\x01[(log level)]\n` + console output (which might contain newlines, thus appearing to be several "lines")
3. **Log Level Tracking**: Operator must track most recent log level per stream (stdout/stderr)
4. **Forwarding**: Non-IPC lines forwarded to logger at tracked level
5. **Stream Handling**: Both stdout and stderr contain mix of IPC and console messages
6. **Unified Buffering**: **Single buffer strategy handles I/O boundaries anywhere**

## Implementation Plan

### Phase 1: Implement Unified Buffering in IPCConnection

**File**: [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js)

**Core Concept**: All incoming data goes into a single `Uint8Array` buffer. We segment it based on what we're currently parsing:
- Text region: Decode and look for complete **SLID blocks** (not just lines)
  - SLID blocks start with `\x01[(` and end with `)]\n`
  - SLID blocks may span multiple lines (accumulate until complete)
  - Console output after log level prefix continues until next `\x01[(` marker
- Binary region: Extract exact byte count
- Remaining: Keep for next iteration

**Changes**:

1. Replace separate buffers with unified buffer:
```javascript
constructor (conn) {
    this.conn = conn;
    this.buffer = new Uint8Array(0);  // UNIFIED buffer (all bytes)
    this.decoder = new TextDecoder();
    this.closed = false;
    
    // State for message parsing
    this.pendingMessage = null;  // Message waiting for binary data
    this.binaryBytesNeeded = 0;  // How many binary bytes to extract
    
    // Callbacks for non-IPC content
    this.onConsoleOutput = null;  // (text, logLevel) => void
    this.currentLogLevel = 'log'; // Track most recent log level
}
```

2. Rewrite `readMessage()` with unified buffering:
```javascript
async readMessage () {
    while (true) {
        // Read more data if buffer is empty or we need more bytes
        if (this.buffer.length === 0 || 
            (this.binaryBytesNeeded > 0 && this.buffer.length < this.binaryBytesNeeded)) {
            const { done, value } = await this.conn.read();
            
            if (done) {
                if (this.buffer.length === 0) {
                    return null; // Clean close
                }
                throw new Error('Connection closed with pending data');
            }
            
            // Append to unified buffer
            const newBuffer = new Uint8Array(this.buffer.length + value.length);
            newBuffer.set(this.buffer);
            newBuffer.set(value, this.buffer.length);
            this.buffer = newBuffer;
        }
        
        // If we're waiting for binary data
        if (this.binaryBytesNeeded > 0) {
            if (this.buffer.length >= this.binaryBytesNeeded) {
                // Extract binary data
                const binaryData = this.buffer.slice(0, this.binaryBytesNeeded);
                this.buffer = this.buffer.slice(this.binaryBytesNeeded);
                
                // Return message with binary data
                const result = { 
                    message: this.pendingMessage, 
                    binaryData 
                };
                this.pendingMessage = null;
                this.binaryBytesNeeded = 0;
                return result;
            }
            // Need more data - continue loop
            continue;
        }
        
        // Process text data - decode and parse input
        // Decode buffer to text (may contain partial UTF-8 sequences)
        let text;
        let validBytes = this.buffer.length;
        
        // Try to decode, handling partial UTF-8 at end
        while (validBytes > 0) {
            try {
                text = this.decoder.decode(
                    this.buffer.slice(0, validBytes), 
                    { stream: false }
                );
                break;
            } catch (e) {
                // Partial UTF-8 sequence at end
                validBytes--;
            }
        }
        
        if (validBytes === 0) {
            // All bytes are partial UTF-8 - need more data
            continue;
        }
        
        // Parse the decoded text (may contain multiple lines, partial SLID blocks, console output)
        const parseResult = this.parseInput(text);
        
        if (parseResult.consumed === 0) {
            // Need more data to make progress
            if (validBytes < this.buffer.length) {
                // Have partial UTF-8 at end - keep it
                continue;
            }
            // All decoded but can't parse - need more data
            continue;
        }
        
        // Remove consumed characters from buffer
        const consumedBytes = new TextEncoder().encode(
            text.substring(0, parseResult.consumed)
        ).length;
        this.buffer = this.buffer.slice(consumedBytes);
        
        // If we got a message, return it
        if (parseResult.message) {
            return parseResult.message;
        }
        
        // Otherwise continue processing
    }
}
```

3. Add `parseInput()` method for SLID-boundary-aware parsing:
```javascript
/**
 * Parse decoded text input (may contain multiple lines, partial SLID blocks, console output)
 * @param {string} text Decoded text to parse
 * @returns {Object} { consumed: number, message: Object|null }
 *   - consumed: Number of characters consumed from input
 *   - message: Parsed message if complete, null otherwise
 */
parseInput (text) {
    // Look for SOH marker (start of SLID block)
    const sohMarker = SOH + '[(';
    const sohIndex = text.indexOf(sohMarker);
    
    if (sohIndex === -1) {
        // No SLID block start - all console output
        if (this.onConsoleOutput && text.trim()) {
            this.onConsoleOutput(text, this.currentLogLevel);
        }
        return { consumed: text.length, message: null };
    }
    
    // If there's console output before SOH, forward it
    if (sohIndex > 0) {
        const consoleText = text.substring(0, sohIndex);
        if (this.onConsoleOutput && consoleText.trim()) {
            this.onConsoleOutput(consoleText, this.currentLogLevel);
        }
        return { consumed: sohIndex, message: null };
    }
    
    // SOH is at start - look for complete SLID block
    // SLID blocks end with )]\n
    const endMarker = ')]\n';
    const endIndex = text.indexOf(endMarker, sohMarker.length);
    
    if (endIndex === -1) {
        // Incomplete SLID block - need more data
        return { consumed: 0, message: null };
    }
    
    // Extract complete SLID block (including end marker)
    const slidBlock = text.substring(0, endIndex + endMarker.length);
    
    // Parse the SLID block
    const result = this.parseSlidBlock(slidBlock);
    
    if (result) {
        // Return message
        return { consumed: slidBlock.length, message: result };
    } else {
        // SLID block parsed but no message to return (e.g., log level update)
        return { consumed: slidBlock.length, message: null };
    }
}
```

4. Add `parseSlidBlock()` method:
```javascript
/**
 * Parse a complete SLID block
 * @param {string} slidBlock Complete SLID block text (including boundary markers)
 * @returns {Object|null} Message result or null to continue
 */
parseSlidBlock (slidBlock) {
    // Parse SLID once (parseSLID automatically handles boundary markers)
    let message;
    try {
        message = parseSLID(slidBlock);
    } catch (error) {
        console.warn('Failed to parse SLID block:', error.message);
        return null;
    }
    
    const type = message.at(0);
    
    // Check for log level message
    if (type === 'log') {
        const logLevel = message.at(1); // debug, info, log, warn, error
        if (logLevel) {
            this.currentLogLevel = logLevel;
        }
        return null; // Continue - console output follows until next SOH
    }
    
    // Otherwise it's an IPC message
    const id = message.at('id');
    const fields = message.at(1);
    const dataSize = message.at('dataSize', 0);
    
    if (!(fields instanceof NANOS)) {
        console.warn('Invalid IPC message format: fields must be NANOS');
        return null;
    }
    
    if (dataSize > 0) {
        // Binary data follows
        this.pendingMessage = { type, id, fields };
        this.binaryBytesNeeded = dataSize;
        return null; // Continue to read binary
    } else {
        // No binary data - return immediately
        return {
            message: { type, id, fields },
            binaryData: null
        };
    }
}
```

5. Add console output handler setter:
```javascript
/**
 * Set callback for console output (non-IPC content)
 * @param {Function} callback (text, logLevel) => void
 */
setConsoleOutputHandler (callback) {
    this.onConsoleOutput = callback;
}
```

**Rationale**: 
- Single `Uint8Array` buffer handles all data
- Properly handles partial UTF-8 sequences at buffer boundaries
- **SLID-boundary aware**: Accumulates until complete `)]\n` marker found
- **Console output handling**: Text between log level marker and next `\x01[(` is console output (may contain newlines)
- Segments buffer based on current parsing state (SLID block vs binary vs console)
- I/O boundaries can be anywhere - buffer accumulates until complete unit available

### Phase 2: Update ProcessManager to Monitor Both Streams

**File**: [`src/process-manager.esm.js`](../src/process-manager.esm.js)

**Changes**:

1. Modify `spawnProcess()` to create separate IPC connections for stdout and stderr:
```javascript
async spawnProcess (type, poolName, poolConfig) {
    // ... existing spawn code ...
    
    const process = command.spawn();
    
    // Create IPC connection for stdout (handles IPC messages)
    const stdinWriter = process.stdin.getWriter();
    const stdoutReader = process.stdout.getReader();
    
    const ipcConn = new IPCConnection({
        read: () => stdoutReader.read(),
        write: (data) => stdinWriter.write(data),
        close: async () => {
            try {
                await stdoutReader.cancel();
                await process.stdin.close();
            } catch (e) {
                // Ignore close errors
            }
        },
    });
    
    // Set console output handler for stdout
    ipcConn.setConsoleOutputHandler((text, logLevel) => {
        this.logger[logLevel](`[${processId}] ${text}`);
    });
    
    // Create separate reader for stderr (console output only)
    const stderrReader = process.stderr.getReader();
    const stderrConn = new IPCConnection({
        read: () => stderrReader.read(),
        write: () => { throw new Error('Cannot write to stderr'); },
        close: async () => {
            try {
                await stderrReader.cancel();
            } catch (e) {
                // Ignore close errors
            }
        },
    });
    
    // Set console output handler for stderr
    stderrConn.setConsoleOutputHandler((text, logLevel) => {
        this.logger[logLevel](`[${processId}] ${text}`);
    });
    
    // ... rest of spawn code ...
    
    // Start monitoring stderr (console output only)
    this.monitorStderr(managedProc, stderrConn);
    
    return managedProc;
}
```

2. Add stderr monitoring method:
```javascript
/**
 * Monitor stderr for console output
 * @param {ManagedProcess} managedProc Process to monitor
 * @param {IPCConnection} stderrConn Stderr IPC connection
 */
monitorStderr (managedProc, stderrConn) {
    (async () => {
        try {
            // Keep reading from stderr (will only get console output)
            while (true) {
                const result = await stderrConn.readMessage();
                if (!result) break; // Stream closed
                
                // Stderr should never have IPC messages, but if it does, log error
                this.logger.error(`[${managedProc.id}] Unexpected IPC message on stderr: ${result.message.type}`);
            }
        } catch (error) {
            if (!this.isShuttingDown) {
                this.logger.error(`[${managedProc.id}] stderr monitoring error: ${error.message}`);
            }
        }
    })();
}
```

3. Remove old stderr monitoring code (lines 232-265) - now handled by `IPCConnection`

**Rationale**:
- Stdout IPC connection handles both IPC messages and console output
- Stderr IPC connection handles console output only (no IPC messages expected)
- Console output callback forwards to logger at correct level
- Log level tracking is per-connection (stdout vs stderr)

### Phase 3: Verify Operator Integration

**File**: [`src/operator.esm.js`](../src/operator.esm.js)

**Verification Points**:
- Line 117: `ProcessManager` receives logger ✅
- Lines 405-437: Request forwarding uses `process.ipcConn` ✅
- No direct stdout/stderr access in operator ✅

**No changes needed** - operator correctly delegates to `ProcessManager`.

### Phase 4: Verify Service Processes

**Files**: 
- [`src/responder-process.esm.js`](../src/responder-process.esm.js)
- [`src/router-process.esm.js`](../src/router-process.esm.js)

**Verification Points**:
- Console interception happens before any logging ✅ (line 139 in service-process.esm.js)
- All console.* calls will be prefixed with log level ✅
- IPC messages are sent via `ipcConn.writeMessage()` ✅

**No changes needed** - service processes are correctly configured.

### Phase 5: Testing and Validation

**Test Scenarios**:

1. **Unified Buffering Edge Cases**:
   - IPC message split across multiple reads
   - Binary data split across multiple reads
   - Partial UTF-8 sequence at read boundary
   - Log message + IPC message in single read
   - IPC message + partial binary + rest of binary in separate reads
   - Multi-line SLID block split across reads
   - Multi-line console output

2. **Console Output Levels**:
   - Service process calls `console.debug()`, `console.info()`, `console.log()`
   - Verify operator logs at correct levels (debug, info, log)
   - Service process calls `console.warn()`, `console.error()`
   - Verify operator logs at correct levels (warn, error)

3. **IPC Message Handling**:
   - Service process sends IPC message via `ipcConn.writeMessage()`
   - Verify message is NOT logged as console output
   - Verify message is properly received by operator

4. **Interleaved Output**:
   - Service process alternates console.log() and IPC messages
   - Verify both are handled correctly
   - Verify log levels persist across IPC messages

5. **Binary Data**:
   - Service process sends IPC message with binary data
   - Verify binary data doesn't corrupt console output
   - Verify console output after binary data is logged correctly

**Test Implementation**:

Create unit tests in `test/ipc-protocol.test.js`:
```javascript
// Test unified buffering with various I/O boundary scenarios
Deno.test('IPCConnection - unified buffering with split message', async () => {
    // Simulate reads that split message across boundaries
    // ...
});

Deno.test('IPCConnection - partial UTF-8 at boundary', async () => {
    // Test emoji or multi-byte character split across reads
    // ...
});

Deno.test('IPCConnection - multi-line SLID block', async () => {
    // Test SLID block spanning multiple lines
    // ...
});

Deno.test('IPCConnection - multi-line console output', async () => {
    // Test console output with newlines
    // ...
});
```

Create integration test in `test/ipc-logging-integration.test.js`:
```javascript
// Spawn responder process
// Send config update
// Trigger various console outputs
// Send IPC messages
// Verify operator logs contain expected output at correct levels
```

## Implementation Order

1. **Phase 1**: Unified Buffering in IPCConnection (4-6 hours)
   - Rewrite buffer management
   - Handle UTF-8 boundaries
   - Add `parseInput()` for SLID-boundary awareness
   - Add `parseSlidBlock()` for SLID parsing
   - Add console output callback
   - **Critical**: This is the foundation for everything else

2. **Phase 2**: Update ProcessManager (2-3 hours)
   - Add stdout monitoring via IPCConnection
   - Add stderr monitoring via IPCConnection
   - Remove old stderr monitoring code
   - Test with both streams

3. **Phase 3**: Verify Operator (30 minutes)
   - Review delegation to ProcessManager
   - Confirm no direct stream access

4. **Phase 4**: Verify Service Processes (30 minutes)
   - Confirm console interception
   - Confirm IPC usage

5. **Phase 5**: Testing (4-6 hours)
   - Create unit tests for unified buffering
   - Create integration tests
   - Test all edge cases
   - Fix any issues discovered

**Total Estimated Time**: 11-16 hours

## Edge Cases and Considerations

1. **Partial UTF-8 Sequences**: Handled by trying progressively smaller decode lengths
2. **Binary Data Boundaries**: Handled by exact byte counting in unified buffer
3. **Multi-line SLID Blocks**: **Fully supported** - accumulates until `)]\n` marker found
4. **Multi-line Console Output**: **Fully supported** - text after log level marker continues until next `\x01[(` 
5. **Stream Closure**: Handled by checking for pending data
6. **Log Level Persistence**: Tracked per-connection, resets on stream close
7. **Performance**: Single buffer copy per read, minimal overhead
8. **Memory**: Buffer grows only when needed, shrinks after extraction
9. **Invalid SLID Blocks**: Skipped with warning, processing continues

## Backward Compatibility

This update is **fully backward compatible**:
- Multi-line SLID blocks are now properly supported
- Multi-line console output is now properly supported
- Existing IPC messages work unchanged
- Console output that was previously lost will now be logged
- No changes to message formats
- No changes to applet protocol

## Success Criteria

1. ✅ All console.* calls from service processes appear in operator logs
2. ✅ Log levels are correctly tracked and applied
3. ✅ IPC messages are not logged as console output
4. ✅ Both stdout and stderr are monitored
5. ✅ Binary data doesn't corrupt console output
6. ✅ Multi-line SLID blocks handled correctly
7. ✅ Multi-line console output handled correctly
8. ✅ I/O boundaries can be anywhere (unified buffering)
9. ✅ Partial UTF-8 sequences handled correctly
10. ✅ All existing tests continue to pass
11. ✅ New unit and integration tests pass

## Related Documents

- [`arch/ipc-update.md`](ipc-update.md) - IPC protocol requirements and POC results
- [`arch/ipc-protocol.md`](ipc-protocol.md) - IPC protocol specification
- [`src/ipc-protocol.esm.js`](../src/ipc-protocol.esm.js) - IPC protocol implementation
- [`src/console-intercept.esm.js`](../src/console-intercept.esm.js) - Console interception
- [`src/process-manager.esm.js`](../src/process-manager.esm.js) - Process management
- [`src/service-process.esm.js`](../src/service-process.esm.js) - Service process base class

## Notes

- The proof-of-concept in `/ipc-test` validated the protocol design
- Console interception is already implemented and working
- **Main gap is unified buffering strategy with SLID-boundary awareness in IPCConnection**
- Secondary gap is stdout monitoring in ProcessManager
- No changes needed to applet protocol or responder/router logic
- Multi-line SLID blocks and console output are now fully supported