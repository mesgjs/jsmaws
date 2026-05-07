# IPC Communications Test

## Background

- Responder and router processes depend upon stdout for communication with the operator.
- console.debug, console.info, and console.log also write to stdout (without distinction)
- console.warn and console.error write to stderr (without distinction)

## Proposal (ADOPTED)

- Use `\1[(/*SLID block */ dataSize=size)]\noptData` for IPC messages
- Specifically, SOH + '[(' distinguishes IPC messages from console communications
- A SLID block will always end `])\n` (followed by binary data of fixed length if dataSize is present and > 0)
- A SLID block may span multiple lines (i.e. may contain newline characters)
  - If a line contains the opening marker but not the closing marker, additional lines must be accumulated and concatenated until the result contains a complete SLID block.
- dataSize is a top-level value (like type and id), not a field, and defaults to 0 if omitted
- In the operator, a line that is not an IPC message is content to be logged
  - To be clear: both stdout and stderr from child processes will contain a mix of IPC messages and log content
- In service processses, intercept console reporting methods to send a logging level message before calling the original method.
  - Prefix console messages with `\1[(log debug)]\n` or `info` or `log` (to stdout)
  - Prefix console messages with `\1[(log warn)]\n` or `error` (to stderr)
- In the operator's child stdout and stderr processing, track the most recently received logging level for forwarding console (non-IPC) messages to the logger at the correct level.
- I/O boundaries can be anywhere (e.g. IPC message + binary data within a single I/O operation, multiple I/O ops per IPC message or per binary data segment)
  - A unified buffering strategy must be used for both text-based IPC messages and binary data, segmenting and decoding segments appropriately
- ~~Determine if locking needs to be released between IPC messages in order for console messages to work.~~

## Proof-Of-Concept Testing (COMPLETED)

- Create proof-of-concept parent/child communications (under /ipc-test) to confirm that console messages and IPC messages can be properly distinguished (on both stdout and stderr, where applicable).
- Confirm that processes can send and receive multiple request/response handshakes, intermixed with logging.