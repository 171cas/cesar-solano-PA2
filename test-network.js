'use strict';

// Run with: node test-network.js
// This tool starts and stops its own server. No manually started server is used.
const net = require('net');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const path = require('path');

const HOST = '127.0.0.1';
const TIMEOUT_MS = 4000;
const OBSERVE_MS = 250;
const PROMPT = 'Server: Enter your username:';
const INVALID_NAME = 'Server: Invalid username. Use 3–16 letters, digits, underscores, or hyphens.';
const DUPLICATE_NAME = 'Server: Username already exists. Enter another username:';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Track resources created by this script only, so cleanup cannot kill another server.
const processes = new Set();
const probes = new Set();
const clients = [];
const registered = new Map(); // Expected registry, maintained by successful test steps.
let server;
let port;
let interrupted;
let cleaningUp = false;
let stage = 'Setup';

// ----- Process ownership, timeouts, and cleanup -----
function launch(file, args) {
  const child = spawn(process.execPath, [path.join(__dirname, file), ...args], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = { child, stdout: '', stderr: '', closed: false, code: null, signal: null, expectedStop: false };
  processes.add(result);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => { result.stdout += text; });
  child.stderr.on('data', (text) => { result.stderr += text; });
  child.on('error', (error) => { result.error = error; });
  child.stdin.on('error', (error) => { result.inputError = error; });
  child.on('close', (code, signal) => {
    result.closed = true;
    result.code = code;
    result.signal = signal;
  });
  return result;
}

function checkHealth() {
  if (cleaningUp) return;
  if (interrupted) throw interrupted;
  if (server && !server.expectedStop && (server.closed || server.error)) {
    throw new Error(`Test server stopped unexpectedly: ${server.error?.message || server.stderr.trim()}`);
  }
  for (const client of clients) {
    if (client.error && !client.allowError) throw new Error(`${client.label}: ${client.error.message}`);
    if (client.closed && !client.allowClose) throw new Error(`${client.label}: unexpected socket closure`);
  }
}

async function waitFor(description, predicate, timeout = TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (true) {
    checkHealth();
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await pause(10);
  }
}

async function stopProcess(result) {
  assert(processes.has(result), 'Can only stop a process owned by this script');
  result.expectedStop = true;
  if (result.closed) return;
  result.child.kill('SIGTERM');
  try {
    await waitFor('owned process to exit', () => result.closed, 1000);
  } catch (error) {
    if (result.closed) return;
    result.child.kill('SIGKILL');
    await waitFor('owned process to exit after SIGKILL', () => result.closed, 1000);
  }
}

async function availablePort() {
  const probe = net.createServer();
  probes.add(probe);
  let error;
  let closed = false;
  probe.on('error', (value) => { error = value; });
  probe.on('close', () => { closed = true; });
  probe.listen(0);
  await waitFor('available port', () => probe.listening || error);
  if (error) throw error;
  const selected = probe.address().port;
  probe.close();
  await waitFor('port probe closure', () => closed);
  probes.delete(probe);
  return selected;
}

async function startServer() {
  // Retry if another process claims the port between releasing the probe and binding.
  for (let attempt = 0; attempt < 3; attempt++) {
    const selected = await availablePort();
    const result = launch('server.js', [String(selected)]);
    const ready = `Server listening on TCP port ${selected}.`;
    await waitFor('test server startup', () => result.stdout.includes(ready) || result.closed || result.error);
    if (result.error) throw result.error;
    if (result.closed && /already in use/i.test(result.stderr)) continue;
    assert(!result.closed && result.stdout.includes(ready), `Server startup failed: ${result.stderr.trim()}`);
    server = result;
    port = selected;
    console.log(`Isolated test server: ${HOST}:${port}`);
    return;
  }
  throw new Error('Could not start a server on an available test port');
}

async function closeSockets() {
  for (const client of clients) {
    client.allowClose = true;
    client.allowError = true;
    client.socket.destroy();
  }
  await waitFor('all test sockets to close', () => clients.every((client) => client.closed), 1000);
}

async function cleanup() {
  cleaningUp = true;
  const errors = [];
  try { await closeSockets(); } catch (error) { errors.push(error.message); }
  for (const result of processes) {
    try { await stopProcess(result); } catch (error) { errors.push(error.message); }
  }
  for (const probe of probes) {
    try {
      if (probe.listening) {
        let closed = false;
        probe.close(() => { closed = true; });
        await waitFor('probe cleanup', () => closed, 1000);
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

// ----- Exact response expectations, with one UTF-8 line buffer per socket -----
function preview(text) {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}

async function expectResponses(expected = new Map(), finished = () => true) {
  await waitFor('expected responses', () => finished() && clients.every((client) =>
    client.lines.length >= (expected.get(client) || []).length));
  await pause(OBSERVE_MS); // Detect late duplicates and output that should be forbidden.
  checkHealth();
  for (const client of clients) {
    const actual = [...client.lines].sort();
    const wanted = [...(expected.get(client) || [])].sort();
    assert(actual.length === wanted.length,
      `${client.label}: expected ${wanted.length} lines, got ${actual.length}; first: ${preview(actual[0] || '')}`);
    for (let i = 0; i < wanted.length; i++) {
      assert(actual[i] === wanted[i],
        `${client.label}: got ${preview(actual[i])}, expected ${preview(wanted[i])}`);
    }
    assert(client.buffer === '', `${client.label}: incomplete response ${preview(client.buffer)}`);
    client.lines = [];
  }
}

async function connect(label) {
  const socket = net.createConnection({ host: HOST, port });
  const client = { label, socket, buffer: '', lines: [], closed: false, allowClose: false, allowError: false };
  clients.push(client);
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
  await expectResponses(new Map([[client, [PROMPT]]]));
  return client;
}

function broadcastExpectations(lines) {
  return new Map([...registered.values()].map((client) => [client, lines]));
}

async function register(client, name, input = `${name}\n`) {
  const expected = broadcastExpectations([`Server: Welcome ${name}`]);
  expected.set(client, [`Server: Welcome ${name}`]);
  client.socket.write(input, 'utf8');
  await expectResponses(expected);
  client.username = name;
  registered.set(name, client);
}

async function chat(client, input, normalized = input) {
  client.socket.write(`${input}\n`, 'utf8');
  await expectResponses(broadcastExpectations([`${client.username}: ${normalized}`]));
}

async function allUsers(client) {
  // The expected list is derived from successful test registrations, not server output.
  const names = [...registered.keys()].sort();
  client.socket.write('AllUsers\n', 'utf8');
  await expectResponses(new Map([[client, [`Server: Active users: ${names.join(', ')}`]]]));
}

async function check(label, action) {
  stage = label;
  await action();
  console.log(`PASS ${label}`);
}

// ----- Startup and error diagnostics, tested in separate child processes -----
async function expectFailure(file, args, diagnostic) {
  const scenario = `${file} ${JSON.stringify(args)}`;
  const result = launch(file, args);
  await waitFor(`${scenario} failure exit`, () => result.closed || result.error);
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  assert(result.code !== null && result.code !== 0 && !result.signal, `${scenario}: expected unsuccessful exit`);
  assert(diagnostic.test(output), `${scenario}: missing useful diagnostic (${preview(output)})`);
  assert(!/\n\s+at\s/.test(output), `${scenario}: unhandled stack trace`);
  return result;
}

async function startupChecks() {
  await check('Startup: invalid arguments', async () => {
    const serverCases = [[], ['8989', 'extra'], ['abc'], ['12.5'], ['+8989'], ['-1'], ['0'], ['65536']];
    const clientCases = [[], [HOST], [HOST, '8989', 'extra'], [HOST, 'abc'], [HOST, '12.5'],
      [HOST, '+8989'], [HOST, '-1'], [HOST, '0'], [HOST, '65536'], ['', '8989'], [' \t', '8989']];
    for (const [file, cases] of [['server.js', serverCases], ['client.js', clientCases]]) {
      for (const args of cases) {
        const result = await expectFailure(file, args, /Error:/);
        assert(result.stderr.includes(`Usage: node ${file}`), `${file}: missing usage`);
        assert(/exactly|decimal digits|between 1 and 65535|must not be empty/i.test(result.stderr), `${file}: vague argument error`);
      }
    }
  });
  await check('Startup: isolated server and occupied port', async () => {
    await startServer();
    await expectFailure('server.js', [String(port)], /already in use/i);
  });
  await check('Startup: client connection refused', async () => {
    const unused = await availablePort();
    const result = await expectFailure('client.js', [HOST, String(unused)], /Connection refused/i);
    assert(/Connection to .* closed\./.test(result.stderr), 'Client did not report closure');
  });
}

// ----- Registration, framing, chat, commands, capacity, and departures -----
async function protocolChecks() {
  const first = await connect('primary-1');
  const second = await connect('primary-2');
  const third = await connect('primary-3');
  const unregistered = await connect('unregistered observer');

  await check('Registration: invalid names rejected privately; retry stays open', async () => {
    for (const name of ['', 'ab', 'x'.repeat(17), 'UNO CS', 'bad!']) {
      first.socket.write(`${name}\n`, 'utf8');
      await expectResponses(new Map([[first, [INVALID_NAME, PROMPT]]]));
      assert(!first.closed && first.socket.writable, 'Rejected registration closed the connection');
    }
  });
  await check('Registration: split writes, 3/16-character boundaries, three clients', async () => {
    first.socket.write('A', 'utf8');
    await pause(150);
    await expectResponses(); // No complete username exists yet.
    await register(first, 'Amy', 'my\n');
    await register(second, 'LongName_1234567'); // Exactly 16 ASCII characters.
    await register(third, 'Cara');
  });
  await check('Buffering: two chat lines in one write', async () => {
    first.socket.write('combined-one\ncombined-two\n', 'utf8');
    await expectResponses(broadcastExpectations(['Amy: combined-one', 'Amy: combined-two']));
  });
  await check('Concurrency: all three clients receive all 30 intact messages once', async () => {
    const expected = [];
    for (let number = 1; number <= 10; number++) {
      for (const client of [first, second, third]) {
        const body = `burst-${String(number).padStart(2, '0')}`;
        expected.push(`${client.username}: ${body}`);
        client.socket.write(`${body}\n`, 'utf8');
      }
    }
    // Unordered comparisons preserve duplicate counts; no cross-sender order is assumed.
    await expectResponses(broadcastExpectations(expected));
  });
  await check('Registration: duplicates, case sensitivity, simultaneous attempts', async () => {
    const variant = await connect('case variant');
    variant.socket.write('Amy\n', 'utf8');
    await expectResponses(new Map([[variant, [DUPLICATE_NAME]]]));
    await register(variant, 'amy');
    const raceA = await connect('race-A');
    const raceB = await connect('race-B');
    raceA.socket.write('RaceName\n', 'utf8');
    raceB.socket.write('RaceName\n', 'utf8');
    await waitFor('both duplicate-race results', () => raceA.lines.length >= 1 && raceB.lines.length >= 1);
    const welcome = 'Server: Welcome RaceName';
    const winners = [raceA, raceB].filter((client) => client.lines.includes(welcome));
    assert(winners.length === 1, 'Simultaneous name attempts must have exactly one winner');
    const winner = winners[0];
    const loser = winner === raceA ? raceB : raceA;
    const expected = broadcastExpectations([welcome]);
    expected.set(winner, [welcome]);
    expected.set(loser, [DUPLICATE_NAME]);
    await expectResponses(expected);
    winner.username = 'RaceName';
    registered.set('RaceName', winner);
    await register(loser, 'RetryName');
  });
  await check('Isolation: unregistered client receives no welcome or chat', async () => {
    // All previous exact expectations also required this observer to remain silent.
    await chat(first, 'isolation-check');
    assert(unregistered.lines.length === 0 && unregistered.buffer === '', 'Unregistered client received a broadcast');
  });
  await check('Commands: private ASCII-sorted AllUsers and malformed commands', async () => {
    await allUsers(first);
    first.socket.write(' \tAllUsers\t \n', 'utf8');
    await expectResponses(new Map([[first, ['Server: Active users: Amy, Cara, LongName_1234567, RaceName, RetryName, amy']]]));
    for (const command of ['AllUsers', 'Bye']) {
      for (const separator of [' ', '\t']) {
        first.socket.write(`${command}${separator}extra\n`, 'utf8');
        await expectResponses(new Map([[first, [`Server: Invalid command. Use ${command} alone.`]]]));
      }
    }
    for (const text of ['allusers', 'bye', 'AllUsersExample', 'ByeExample']) await chat(first, text);
  });
  await check('Messages: 500/501 ASCII and emoji code points; continued chat', async () => {
    for (const character of ['a', '😀']) {
      await chat(first, ` \t${character.repeat(500)}\t `, character.repeat(500));
      first.socket.write(`${character.repeat(501)}\n`, 'utf8');
      await expectResponses(new Map([[first, ['Server: Message too long.']]]));
      await chat(first, 'continued-after-rejection');
    }
    first.socket.write('\n \t \n', 'utf8');
    await expectResponses();
  });
  await check('Capacity: ten simultaneous registered clients receive a broadcast', async () => {
    for (const name of ['-dash', '0zero', '_under', 'Zulu']) await register(await connect(name), name);
    assert(registered.size === 10, 'Expected ten registered test clients');
    assert([...registered.values()].every((client) => !client.closed), 'A registered client has closed');
    await chat(first, 'ten-client-broadcast');
    first.socket.write('AllUsers\n', 'utf8');
    await expectResponses(new Map([[first, ['Server: Active users: -dash, 0zero, Amy, Cara, LongName_1234567, RaceName, RetryName, Zulu, _under, amy']]]));
  });
  await check('Departure: unexpected disconnect, one notice, registry removal', async () => {
    third.allowClose = true;
    third.allowError = true;
    registered.delete(third.username);
    third.socket.resetAndDestroy();
    await expectResponses(broadcastExpectations(['Server: Cara disconnected']), () => third.closed);
    await allUsers(first);
    await chat(first, 'continued-after-disconnect');
    await register(await connect('reused departed name'), 'Cara');
  });
  await check('Departure: unregistered disconnect produces no announcement', async () => {
    unregistered.allowClose = true;
    unregistered.socket.end('unfinished-username');
    await expectResponses(new Map(), () => unregistered.closed);
  });
  await check('Departure: Bye ignores trailing input and sends one goodbye', async () => {
    first.allowClose = true;
    registered.delete(first.username);
    first.socket.write('Bye\nSHOULD_NOT_BROADCAST\n', 'utf8');
    await expectResponses(broadcastExpectations(['Server: Goodbye Amy']), () => first.closed);
    await allUsers(second); // Also verifies later end/close events did not notify again.
    await chat(second, 'continued-after-Bye');
  });
}

async function terminationCheck() {
  await check('Startup: client detects server termination and exits', async () => {
    await closeSockets();
    const result = launch('client.js', [HOST, String(port)]);
    // Leave stdin open: closure must stop readline rather than depend on input EOF.
    await waitFor('real client prompt', () => result.stdout.includes(`${PROMPT}\n`) || result.closed || result.error);
    assert(!result.closed && !result.error, 'Client failed before server termination');
    await stopProcess(server);
    await waitFor('client exit after server termination', () => result.closed || result.error);
    if (result.error) throw result.error;
    assert(result.code === 0 && !result.signal, 'Client should exit normally after server closure');
    assert(result.stdout === `${PROMPT}\n`, 'Client did not preserve server text');
    assert(result.stderr.includes(`Connection to ${HOST}:${port} closed.`), 'Client did not report server closure');
    assert(!/\n\s+at\s/.test(result.stderr), 'Client printed an unhandled stack trace');
  });
}

async function main() {
  const interrupt = () => { interrupted = new Error('Verification interrupted'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await startupChecks();
    stage = 'Protocol setup';
    await protocolChecks();
    await terminationCheck();
  } catch (error) {
    console.error(`FAIL ${stage}: ${error.message}`);
    process.exitCode = 1; // Stop on the first failing scenario; cleanup still runs.
  } finally {
    try { await cleanup(); }
    catch (error) {
      console.error(`FAIL Cleanup: ${error.message}`);
      process.exitCode = 1;
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

main();
