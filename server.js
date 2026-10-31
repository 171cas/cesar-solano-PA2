'use strict';

const net = require('net');
const path = require('path');
const { Worker } = require('worker_threads');

const args = process.argv.slice(2);

function argumentError(message) {
  console.error(`Error: ${message}`);
  console.error('Usage: node server.js <port>');
  process.exit(1);
}

if (args.length !== 1) {
  argumentError('Provide exactly one port argument.');
}

if (!/^[0-9]+$/.test(args[0])) {
  argumentError('The port must contain only decimal digits.');
}

const port = Number(args[0]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  argumentError('The port must be between 1 and 65535.');
}

// Resolve the worker relative to this file, even if the server is launched elsewhere.
const workerFile = path.join(__dirname, 'server-worker.js');

// Only the main thread owns sockets and shared state. Each client worker handles
// its own input and sends parsed lines here instead of changing this map directly.
// Keeping shared changes together prevents two workers from claiming the same name.
const registeredUsers = new Map();

// Track every socket, including clients who have not registered, for server shutdown.
const connectedSockets = new Set();
let shuttingDown = false;

// Send one UTF-8 line if the socket can still accept writes.
function sendLine(socket, text) {
  if (!socket.destroyed && socket.writable && !socket.writableEnded) {
    // Add a newline so the receiver can identify the end of the line.
    socket.write(`${text}\n`, 'utf8');
  }
}

// Send the same line to every registered user, including the sender when sending chat.
function broadcast(text) {
  for (const registeredSocket of registeredUsers.values()) {
    sendLine(registeredSocket, text);
  }
}

// Keep the outgoing side open after a client finishes sending. Its worker may still
// be processing the final input, so closing immediately could discard complete lines.
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  // A connection already queued when shutdown began must not start another worker.
  if (shuttingDown) {
    socket.destroy();
    return;
  }
  connectedSockets.add(socket);

  // Save the client's endpoint for messages, including after its socket has closed.
  const address = socket.remoteAddress;
  // Enclose IPv6 addresses in brackets, for example [::1]:8989 or [::ffff:127.0.0.1]:8989.
  const endpoint = address.includes(':')
    ? `[${address}]:${socket.remotePort}`
    : `${address}:${socket.remotePort}`;

  console.log(`Client connected: ${endpoint}`);

  // Decode bytes here before passing text to the worker. The decoder preserves
  // UTF-8 characters whose bytes arrive in different socket data events.
  socket.setEncoding('utf8');
  // Leave the username undefined until the main thread accepts registration.
  let username;
  let worker;
  // Save the ID while the worker is alive; worker.threadId becomes -1 after exit.
  let workerId;
  // Once cleanup begins, ignore any worker replies that were already on their way.
  let closing = false;
  // Cleanup can be reached through Bye, a socket event, or a worker failure.
  let cleanedUp = false;

  // Remove this client and stop its worker exactly once; polite means it sent Bye.
  function cleanup(polite = false) {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    closing = true;

    // Remove the username only if it still belongs to this socket.
    if (username !== undefined && registeredUsers.get(username) === socket) {
      registeredUsers.delete(username);
      broadcast(polite
        ? `Server: Goodbye ${username}`
        : `Server: ${username} disconnected`);
    }

    // Termination also discards unfinished input held by this client's worker.
    // Set closing first: an expected termination must not count as a worker failure.
    if (worker !== undefined) {
      worker.terminate().catch((error) => {
        console.error(`Worker cleanup error (${endpoint}): ${error.message}`);
      });
    }
  }

  // A broken worker affects its own connection, not the server or other clients.
  function workerFailure(message) {
    if (closing) {
      return;
    }
    console.error(`Client worker error (${endpoint}): ${message}`);
    cleanup();
    socket.destroy();
  }

  // Apply a worker's parsed line to the registry on the main thread. This function
  // has no asynchronous pause, so each shared-state change finishes before the next.
  function handleLine(message) {
    const { line, validUsername, messageTooLong } = message;

    // After registration, treat input as a command or chat message.
    if (username !== undefined) {
      console.log(`Client line (${endpoint}, thread ${workerId}): ${line}`);
      // Ignore chat lines that are empty after removing surrounding spaces and tabs.
      if (line === '') {
        return;
      }

      if (line === 'AllUsers') {
        // Sort registered names by ASCII order, then reply only to this client.
        const names = Array.from(registeredUsers.keys());
        names.sort();
        sendLine(socket, `Server: Active users: ${names.join(', ')}`);
        return;
      }

      // Reject extra arguments without broadcasting the malformed command.
      if (/^AllUsers[ \t]/.test(line)) {
        sendLine(socket, 'Server: Invalid command. Use AllUsers alone.');
        return;
      }

      if (line === 'Bye') {
        cleanup(true);
        socket.end();
        // Later worker replies, including other lines in this chunk, are ignored.
        return;
      }

      if (/^Bye[ \t]/.test(line)) {
        sendLine(socket, 'Server: Invalid command. Use Bye alone.');
        return;
      }

      // The worker already counted Unicode code points, excluding the sender prefix.
      if (messageTooLong) {
        sendLine(socket, 'Server: Message too long.');
        return;
      }

      broadcast(`${username}: ${line}`);
      return;
    }

    // The worker checked for 3-16 ASCII letters, digits, underscores, or hyphens.
    // Invalid names get a private error and another chance to register.
    if (!validUsername) {
      console.log(`Registration rejected: ${JSON.stringify(line)} from ${endpoint} (invalid username).`);
      sendLine(socket, 'Server: Invalid username. Use 3–16 letters, digits, underscores, or hyphens.');
      sendLine(socket, 'Server: Enter your username:');
      return;
    }

    // Only this thread checks and updates the shared registry. Even if two workers
    // submit the same name together, the second check sees the first registration.
    if (registeredUsers.has(line)) {
      console.log(`Registration rejected: ${JSON.stringify(line)} from ${endpoint} (username already exists).`);
      sendLine(socket, 'Server: Username already exists. Enter another username:');
      return;
    }

    // Save the name and socket before broadcasting so the new user receives it too.
    username = line;
    registeredUsers.set(username, socket);
    console.log(`User registered: ${username} from ${endpoint}`);
    broadcast(`Server: Welcome ${username}`);
  }

  // Forward decoded chunks without parsing lines on the main thread. postMessage
  // queues them even while this connection's worker is still starting up.
  socket.on('data', (text) => {
    if (!closing) {
      worker.postMessage({ type: 'data', text });
    }
  });

  // Queue an end marker after the final chunk. The worker sends its complete lines
  // back before acknowledging this marker; only then may we remove the client.
  socket.on('end', () => {
    if (!closing) {
      worker.postMessage({ type: 'end' });
    }
  });

  // Socket errors discard pending input and clean up only this connection.
  socket.on('error', (error) => {
    console.error(`Client socket error (${endpoint}): ${error.message}`);
    cleanup();
    socket.destroy();
  });

  socket.on('close', () => {
    cleanup();
    connectedSockets.delete(socket);
    console.log(`Client disconnected: ${endpoint}`);
  });

  // Start a real JavaScript thread for this connection. Socket objects stay here;
  // only plain messages cross the worker channel, keeping ownership easy to follow.
  try {
    worker = new Worker(workerFile);
    workerId = worker.threadId;
  } catch (error) {
    // Resource exhaustion or invalid worker options can fail before a worker exists.
    workerFailure(error.message);
    return;
  }

  worker.on('message', (message) => {
    if (closing) {
      return;
    }

    if (message.type === 'ready') {
      // This ID comes from inside the worker, proving its handler runs off-thread.
      console.log(`Client worker started: thread ${message.threadId} for ${endpoint}`);
      sendLine(socket, 'Server: Enter your username:');
    } else if (message.type === 'line') {
      handleLine(message);
    } else if (message.type === 'end') {
      cleanup();
      socket.end();
    }
  });

  // Listen for failures so an uncaught exception inside a worker cannot crash us.
  worker.on('error', (error) => {
    workerFailure(error.message);
  });

  worker.on('exit', (code) => {
    console.log(`Client worker stopped: thread ${workerId} for ${endpoint} (exit code ${code}).`);
    // terminate() can produce code 1 during normal cleanup. closing distinguishes
    // that expected stop from a worker that exited while its client was still active.
    if (!closing) {
      workerFailure(`Thread ${workerId} exited unexpectedly with code ${code}.`);
    }
  });
});

// Handle server errors such as an occupied port or denied permission to listen.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Server error: Port ${port} is already in use.`);
  } else if (error.code === 'EACCES') {
    console.error(`Server error: Permission denied when binding to port ${port}.`);
  } else {
    console.error(`Server error on port ${port}: ${error.message}`);
  }
  process.exitCode = 1;
});

// Stop accepting clients and close existing sockets on Ctrl+C or SIGTERM. Their
// close handlers release their workers, allowing the process to exit naturally.
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log('Server shutting down.');
  server.close();
  for (const socket of connectedSockets) {
    socket.destroy();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, () => {
  console.log(`Server listening on TCP port ${port}.`);
});
