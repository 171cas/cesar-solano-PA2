'use strict';

// Run with: node test-threading.js
// These checks start their own servers and never stop a manually started server.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PROMPT = 'Server: Enter your username:';
const LOBBY_HINT = 'Server: Type READY to play or quit to leave.';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bound asynchronous checks so a broken worker produces a failure instead of a hang.
async function waitFor(description, predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, `Timed out: ${description}`);
    await pause(10);
  }
}

// Ask the OS for an unused port, then release it before launching the test server.
async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, HOST, resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function startServer(t, failureMode) {
  let directory;
  let serverFile = path.join(__dirname, 'server.js');

  if (failureMode !== undefined) {
    // Run a copy of the real server with a worker wrapper in a temporary folder.
    // The wrapper can force a real worker exception or exit without adding fault
    // commands to the production server or modifying the project's worker file.
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pa2-threading-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    serverFile = path.join(directory, 'server.js');
    await fs.copyFile(path.join(__dirname, 'server.js'), serverFile);
    // Run the real session with a fixed secret in this isolated fixture. This
    // makes round outcomes reproducible when a worker fails during an active game.
    await fs.writeFile(path.join(directory, 'game-session.js'), `
      const createGameSession = require(${JSON.stringify(path.join(__dirname, 'game-session.js'))});
      module.exports = (options) => createGameSession({ ...options, makeSecret: () => '0472' });
    `);
    const failure = failureMode === 'throw'
      ? "throw new Error('Forced worker failure for test.');"
      : 'process.exit(0);';
    const wrapper = `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (message) => {
        if (message.type === 'data' && message.text === '__fail_worker__') {
          ${failure}
        }
      });
      require(${JSON.stringify(path.join(__dirname, 'server-worker.js'))});
    `;
    await fs.writeFile(path.join(directory, 'server-worker.js'), wrapper);
  }

  const port = await availablePort();
  // Launch from outside the project to also check that the worker path uses __dirname.
  const child = spawn(process.execPath, [serverFile, String(port)], {
    cwd: os.tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { child, port, stdout: '', stderr: '', closed: false, clients: [] };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => { server.stdout += text; });
  child.stderr.on('data', (text) => { server.stderr += text; });
  child.on('error', (error) => { server.error = error; });
  child.on('close', (code, signal) => {
    server.closed = true;
    server.code = code;
    server.signal = signal;
  });

  // Register cleanup before awaiting startup so failed assertions cannot leak workers.
  t.after(async () => {
    for (const client of server.clients) {
      client.socket.destroy();
    }
    if (!server.closed) {
      child.kill('SIGTERM');
      try {
        await waitFor('owned server shutdown', () => server.closed);
      } catch (error) {
        child.kill('SIGKILL');
        await waitFor('forced shutdown', () => server.closed);
        throw error;
      }
    }
  });

  await waitFor('server startup', () =>
    server.stdout.includes(`Server listening on TCP port ${port}.`) || server.closed || server.error);
  assert(!server.error, server.error?.message);
  assert(!server.closed, server.stderr);
  return server;
}

async function connect(server) {
  const socket = net.createConnection({ host: HOST, port: server.port });
  const client = { socket, lines: [], buffer: '', closed: false };
  server.clients.push(client);
  socket.setEncoding('utf8');
  socket.on('data', (text) => {
    client.buffer += text;
    let index;
    while ((index = client.buffer.indexOf('\n')) !== -1) {
      client.lines.push(client.buffer.slice(0, index));
      client.buffer = client.buffer.slice(index + 1);
    }
  });
  socket.on('error', (error) => { client.error = error; });
  socket.on('close', () => { client.closed = true; });
  await expectLine(client, PROMPT);
  assert(!client.error, client.error?.message);
  // Cache the local port before disconnection clears the socket's endpoint fields.
  client.port = socket.localPort;
  return client;
}

async function expectLine(client, line) {
  await waitFor(JSON.stringify(line), () => client.lines.includes(line) || client.closed);
  assert(client.lines.includes(line), `Missing response: ${line}`);
}

async function register(client, name) {
  client.socket.write(`${name}\n`);
  await expectLine(client, `${name} joined.`);
}

// The server logs IDs reported from inside each worker. Match by the client's port,
// allowing either IPv4 or an IPv4-mapped IPv6 address on the server side.
function workerId(server, client) {
  const records = [...server.stdout.matchAll(/Client worker started: thread (\d+) for ([^\n]+)/g)];
  const record = records.find((match) => match[2].endsWith(`:${client.port}`));
  assert(record, 'Client has no reported worker thread');
  return Number(record[1]);
}

async function expectWorkerStopped(server, id) {
  await waitFor(`thread ${id} cleanup`, () =>
    server.stdout.includes(`Client worker stopped: thread ${id} for `));
}

test('Clients have distinct worker threads, independent line buffers, and intact split UTF-8', async (t) => {
  const server = await startServer(t);
  const alice = await connect(server);
  const bob = await connect(server);
  const aliceThread = workerId(server, alice);
  const bobThread = workerId(server, bob);
  assert(aliceThread > 0 && bobThread > 0, 'Client handlers must run outside main thread 0');
  assert.notEqual(aliceThread, bobThread);

  // Alice's incomplete username must not delay or contaminate Bob's registration.
  alice.socket.write('Al');
  await register(bob, 'Bob');
  assert.deepEqual(alice.lines, [PROMPT]);
  alice.socket.write('ice\n');
  await expectLine(alice, 'Alice joined.');
  await expectLine(bob, 'Alice joined.');

  // Deliberately split an emoji inside its UTF-8 bytes, not between characters.
  const bytes = Buffer.from('split-😀\r\n');
  const split = bytes.indexOf(Buffer.from('😀')) + 1;
  alice.socket.write(bytes.subarray(0, split));
  await pause(30);
  alice.socket.write(bytes.subarray(split));
  await expectLine(alice, 'Alice: split-😀');
  await expectLine(bob, 'Alice: split-😀');
  assert.equal(alice.lines.filter((line) => line === 'Alice: split-😀').length, 1);
});

test('Final complete lines are processed before EOF cleanup; unfinished input is discarded', async (t) => {
  const server = await startServer(t);
  const observer = await connect(server);
  await register(observer, 'Observer');
  const sender = await connect(server);
  const id = workerId(server, sender);

  // Registration and a final message arrive together immediately before TCP FIN.
  sender.socket.end('FinUser\nfinal-message\nunfinished');
  await waitFor('sender closure', () => sender.closed);
  await expectLine(observer, 'FinUser disconnected.');
  await expectWorkerStopped(server, id);
  assert.deepEqual(observer.lines, [
    PROMPT,
    'Observer joined.',
    LOBBY_HINT,
    'FinUser joined.',
    'FinUser: final-message',
    'FinUser disconnected.',
  ]);
});

test('quit discards queued worker replies and releases the departing client thread', async (t) => {
  const server = await startServer(t);
  const observer = await connect(server);
  await register(observer, 'Observer');
  const sender = await connect(server);
  await register(sender, 'Leaver');
  const id = workerId(server, sender);

  sender.socket.write('quit\nSHOULD_NOT_BROADCAST\n');
  await waitFor('polite closure', () => sender.closed);
  await expectLine(observer, 'Leaver left.');
  await expectWorkerStopped(server, id);
  assert.equal(observer.lines.filter((line) => line === 'Leaver left.').length, 1);
  assert(!observer.lines.some((line) => line.includes('SHOULD_NOT_BROADCAST')));
  assert(!observer.lines.includes('Leaver disconnected.'));
});

for (const failureMode of ['throw', 'exit']) {
  test(`Unexpected worker ${failureMode} disconnects only its client and frees the username`, async (t) => {
    const server = await startServer(t, failureMode);
    const observer = await connect(server);
    await register(observer, 'Observer');
    const victim = await connect(server);
    await register(victim, 'Victim');
    const id = workerId(server, victim);

    // The test wrapper handles this text before the real parser sees it.
    victim.socket.write('__fail_worker__');
    await waitFor('failed worker client closure', () => victim.closed);
    await expectLine(observer, 'Victim disconnected.');
    await expectWorkerStopped(server, id);
    assert.equal(observer.lines.filter((line) => line === 'Victim disconnected.').length, 1);
    assert(!server.closed, 'A client worker failure stopped the server');
    assert.match(server.stderr, /Client worker error/);
    assert.match(server.stderr, failureMode === 'throw'
      ? /Forced worker failure for test/
      : /exited unexpectedly with code 0/);

    const replacement = await connect(server);
    await register(replacement, 'Victim');
    observer.socket.write('still-working\n');
    await expectLine(replacement, 'Observer: still-working');
  });

  test(`Worker ${failureMode} during a round unblocks the survivor and permits replay`, async (t) => {
    const server = await startServer(t, failureMode);
    const observer = await connect(server);
    await register(observer, 'Observer');
    const victim = await connect(server);
    await register(victim, 'Victim');
    const id = workerId(server, victim);

    observer.socket.write('READY\n');
    await expectLine(observer, 'Observer is ready.');
    victim.socket.write('READY\n');
    await expectLine(observer, 'Round 1 of 10');
    observer.socket.write('1356\n');
    await expectLine(observer, 'Observer has submitted a guess.');

    // No valid victim guess exists. Its worker failure must remove that player
    // and score the remaining submission, using the same departure path as a drop.
    victim.socket.write('__fail_worker__');
    await waitFor('failed active client closure', () => victim.closed);
    await expectWorkerStopped(server, id);
    await expectLine(observer, 'Round 2 of 10');
    assert.equal(observer.lines.filter((line) => line === 'Victim disconnected.').length, 1);
    assert.equal(observer.lines.filter((line) => line === 'Round 1 results:').length, 1);
    assert(observer.lines.includes('Observer: 1356 -> 0 bulls, 0 cows'));
    assert(!observer.lines.some((line) => line.startsWith('Victim: ')));
    assert(!server.closed, 'An active client worker failure stopped the server');

    const replacement = await connect(server);
    await register(replacement, 'Victim');
    await expectLine(replacement, 'Server: A game is in progress. Wait for the next game.');
    // The survivor keeps the original secret and round count. The replacement
    // connection remains a spectator until that game finishes and everyone readies.
    observer.socket.write('0472\n');
    await expectLine(replacement, LOBBY_HINT);
    // Different sockets can receive their data events in different orders.
    // Wait for the observer's outcome too before inspecting that client's lines.
    await expectLine(observer, 'Secret number: 0472');
    assert(observer.lines.includes('Round 2 results:'));
    assert(observer.lines.includes('Observer wins!'));
    assert(observer.lines.includes('Secret number: 0472'));
    observer.socket.write('READY\n');
    await expectLine(replacement, 'Observer is ready.');
    assert(!replacement.lines.includes('Server: Game started. Players: Observer, Victim.'));
    replacement.socket.write('READY\n');
    await expectLine(replacement, 'Server: Game started. Players: Observer, Victim.');
    await expectLine(replacement, 'Round 1 of 10');
    assert.equal(replacement.lines.filter((line) => line === 'Round 1 of 10').length, 1);
  });
}

test('SIGTERM closes registered and unregistered connections and all their workers', async (t) => {
  const server = await startServer(t);
  const registered = await connect(server);
  await register(registered, 'Registered');
  const unregistered = await connect(server);
  const ids = [workerId(server, registered), workerId(server, unregistered)];

  server.child.kill('SIGTERM');
  await waitFor('server process exit', () => server.closed);
  await waitFor('all client sockets to close', () => registered.closed && unregistered.closed);
  assert.equal(server.code, 0, server.stderr);
  assert.equal(server.signal, null, 'Server was killed instead of completing shutdown');
  assert.equal(server.stderr, '');
  for (const id of ids) {
    assert(server.stdout.includes(`Client worker stopped: thread ${id} for `));
  }
});
