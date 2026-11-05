'use strict';

const { isMainThread, parentPort, threadId } = require('worker_threads');

// This file is a connection handler started by server.js, not a second TCP server.
// Each connection gets its own instance, running on a separate JavaScript thread.
if (isMainThread) {
  console.error('Error: Start the server with node server.js <port>.');
  process.exit(1);
}

// Keep unfinished input inside this worker, separate from every other client's input.
let lineBuffer = '';

// Receive text from the main thread through this worker's private message channel.
// Messages from the same sender are processed in order, including the final end marker.
parentPort.on('message', (message) => {
  if (message.type === 'end') {
    // All earlier text has been processed. Discard any line that had no final newline.
    lineBuffer = '';
    parentPort.postMessage({ type: 'end' });
    // Release the channel so this worker can exit after sending its final messages.
    parentPort.close();
    return;
  }

  // The socket decoder already preserves UTF-8 characters split across byte chunks.
  // A chunk may still contain part of a line or several complete lines.
  lineBuffer += message.text;

  let newlineIndex;
  // Extract complete lines and leave an unfinished final line for the next chunk.
  while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
    let line = lineBuffer.slice(0, newlineIndex);
    lineBuffer = lineBuffer.slice(newlineIndex + 1);

    // Accept CRLF endings by removing the trailing \r left after splitting at \n.
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    // Trim only surrounding spaces and tabs; preserve internal and other whitespace.
    line = line.replace(/^[ \t]+|[ \t]+$/g, '');

    // Check input syntax here, on this client's thread. The main thread decides
    // whether the line is a registration attempt or a message using its shared registry.
    // This also lets a username and a message arrive together without waiting for an ack.
    parentPort.postMessage({
      type: 'line',
      line,
      validUsername: /^[A-Za-z0-9_-]{3,16}$/.test(line),
      // Count Unicode code points: an emoji such as 😀 counts once, not twice.
      messageTooLong: Array.from(line).length > 500,
    });
  }
});

// Report the actual executing thread ID after the input handler has been installed.
// The main thread includes it in this connection's log messages.
parentPort.postMessage({ type: 'ready', threadId });
