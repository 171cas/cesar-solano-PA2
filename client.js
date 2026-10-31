'use strict';

const net = require('net');
const readline = require('readline');

// Validate arguments before trying to connect.
const args = process.argv.slice(2);

function argumentError(message) {
  console.error(`Error: ${message}`);
  console.error('Usage: node client.js <host> <port>');
  process.exit(1);
}

if (args.length !== 2) {
  argumentError('Provide exactly a hostname/IP and a port.');
}

const host = args[0];
if (host.trim().length === 0) {
  argumentError('The hostname/IP must not be empty or whitespace-only.');
}

if (!/^[0-9]+$/.test(args[1])) {
  argumentError('The port must contain only decimal digits.');
}

const port = Number(args[1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  argumentError('The port must be between 1 and 65535.');
}

// Format the server address for display, enclosing IPv6 hosts in brackets.
// Display IPv6 as [::1]:8989 and IPv4 or hostnames as 127.0.0.1:8989 or localhost:8989.
const endpoint = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;

// Start connecting to the server (asynchronously)
// the socket emits 'connect' on success or 'error' on failure.
const socket = net.createConnection({ host, port });
let terminalInput;

function endSending() {
  // End outgoing communication if the socket is intact and end() has not been called.
  if (!socket.destroyed && !socket.writableEnded) {
    socket.end();
  }
}

// Stop keyboard input and disconnect immediately
function handleCtrlC() {
  if (terminalInput) {
    terminalInput.close();
  }
  socket.destroy();
}

// Run handleCtrlC when the process receives an interrupt signal, usually from Ctrl+C.
process.on('SIGINT', handleCtrlC);

// Set up terminal input once the socket successfully connects to the server.
socket.on('connect', () => {
  // Create an interface that reads terminal input one line at a time.
  terminalInput = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Send each completed input line if the socket can still accept writes.
  terminalInput.on('line', (line) => {
    if (!socket.destroyed && !socket.writableEnded && socket.writable) {
      // Send the text followed by a newline so the server knows the line is complete.
      socket.write(`${line}\n`, 'utf8');
    }
  });

  // When terminal input closes, finish sending queued data and end outgoing communication.
  terminalInput.on('close', endSending);
  // When readline detects Ctrl+C, close terminal input and disconnect immediately.
  terminalInput.on('SIGINT', handleCtrlC);
});

// The decoder preserves UTF-8 characters even when their bytes arrive separately.
socket.setEncoding('utf8');

// Print the server's text exactly as received, including its existing newlines.
socket.on('data', (text) => {
  process.stdout.write(text);
});

// Handle socket errors, display a useful message, and mark the program's exit as unsuccessful.
socket.on('error', (error) => {
  if (error.code === 'ECONNREFUSED') {
    console.error(`Connection refused by ${endpoint}. Check that the server is running on that port.`);
  } else if (error.code === 'ENOTFOUND') {
    console.error(`Cannot resolve hostname ${host}. Check the hostname/IP.`);
  } else {
    console.error(`Connection error (${endpoint}): ${error.message}`);
  }
  process.exitCode = 1;
});

// When the connection closes, stop terminal input, remove the signal handler, and report closure.
socket.on('close', () => {
  if (terminalInput) {
    terminalInput.close();
  }
  process.removeListener('SIGINT', handleCtrlC);
  // Keep local status messages separate from the server text on stdout.
  console.error(`Connection to ${endpoint} closed.`);
});
