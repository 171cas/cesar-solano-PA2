'use strict';

// Run with: node test-game-session.js
// Exercise game rules directly, without TCP sockets or timing-dependent guesses.
const test = require('node:test');
const assert = require('node:assert/strict');
const createGameSession = require('./game-session');

const ERROR = 'Invalid submission. Enter exactly four digits with no repeated digits.';
const LOBBY = 'Server: Type READY to play or quit to leave.';
const WAITING = 'Server: A game is in progress. Wait for the next game.';
const PROMPT = 'Server: Submit exactly four digits with no repeated digits.';

// Capture the public messages instead of inspecting the session's private sets.
// A supplied sequence makes each game's answer known only inside the test.
function createTrace({ secrets = ['0472'], random = false } = {}) {
  const events = [];
  const supply = [...secrets];
  const options = {
    broadcast: (text) => events.push({ to: 'all', text }),
    sendToPlayer: (name, text) => events.push({ to: name, text }),
  };
  if (!random) {
    options.makeSecret = () => {
      assert(supply.length > 0, 'An unexpected extra game requested another secret');
      return supply.shift();
    };
  }
  const game = createGameSession(options);
  return {
    game,
    events,
    drain: () => events.splice(0),
    start(names) {
      // Register everyone before marking anyone ready, avoiding accidental solo starts.
      for (const name of names) game.addPlayer(name);
      for (const name of names) game.markReady(name);
      events.length = 0;
    },
  };
}

function broadcasts(trace) {
  return trace.events.filter((event) => event.to === 'all').map((event) => event.text);
}

test('A correct first submission stays hidden until every active player submits', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  trace.game.handleInput('Alice', '0472');
  assert.deepEqual(trace.drain(), [{ to: 'all', text: 'Alice has submitted a guess.' }]);
  trace.game.handleInput('Bob', '1356');
  assert.deepEqual(broadcasts(trace), [
    'Bob has submitted a guess.', 'Round 1 results:',
    'Alice: 0472 -> 4 bulls, 0 cows', 'Bob: 1356 -> 0 bulls, 0 cows',
    'Alice wins!', 'Bob loses.', 'Secret number: 0472', LOBBY,
  ]);
});

test('INFO before any completed round stays private and never reveals a pending correct guess', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  trace.game.showInfo('Alice');
  assert.deepEqual(trace.drain(), [{ to: 'Alice', text: 'Server: No completed rounds yet.' }]);
  trace.game.handleInput('Alice', '0472');
  trace.drain();
  for (const name of ['Alice', 'Bob']) {
    trace.game.showInfo(name);
    assert.deepEqual(trace.drain(), [{ to: name, text: 'Server: No completed rounds yet.' }]);
  }
  // INFO neither uses Bob's turn nor replaces Alice's already accepted guess.
  trace.game.handleInput('Bob', '1356');
  assert(broadcasts(trace).includes('Alice: 0472 -> 4 bulls, 0 cows'));
  assert(broadcasts(trace).includes('Alice wins!'));
});

test('INFO replays all completed rounds privately with aligned guesses and score counts', () => {
  const trace = createTrace();
  trace.start(['Bob', 'Alice']);
  trace.game.handleInput('Bob', '2589');
  trace.game.handleInput('Alice', '0123');
  trace.game.handleInput('Alice', '2740');
  trace.game.handleInput('Bob', '1356');
  trace.game.addPlayer('Waiting');
  trace.game.handleInput('Alice', '0472');
  trace.drain();

  const expected = [
    'Round 1 results:',
    'Alice: 0123 -> 1 bull,  1 cow',
    'Bob:   2589 -> 0 bulls, 1 cow',
    'Round 2 results:',
    'Alice: 2740 -> 0 bulls, 4 cows',
    'Bob:   1356 -> 0 bulls, 0 cows',
  ];
  // All registered viewers get the same revealed history, even after submitting.
  for (const name of ['Alice', 'Bob', 'Waiting']) {
    trace.game.showInfo(name);
    assert.deepEqual(trace.drain(), expected.map((text) => ({ to: name, text })));
  }
  // Previous results remain available after their author leaves; the current
  // correct submission is discarded and must never appear in INFO instead.
  trace.game.removePlayer('Alice');
  trace.drain();
  trace.game.showInfo('Bob');
  assert.deepEqual(trace.drain(), expected.map((text) => ({ to: 'Bob', text })));
  trace.game.handleInput('Bob', '2589');
  assert(broadcasts(trace).includes('Round 4 of 10'));
});

test('INFO handles the longest allowed username and ignores unregistered or stopped callers', () => {
  const trace = createTrace();
  trace.start(['ABCDEFGHIJKLMNOP', 'Bob']);
  trace.game.handleInput('Bob', '0123');
  trace.game.handleInput('ABCDEFGHIJKLMNOP', '2589');
  trace.drain();
  trace.game.showInfo('Bob');
  const rows = trace.drain().slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text.indexOf('2589'), 18);
  assert.equal(rows[1].text.indexOf('0123'), 18);
  // The arrow and both score digits also occupy matching columns.
  assert.equal(rows[0].text.indexOf('->'), rows[1].text.indexOf('->'));
  assert.equal(rows[0].text.indexOf('1 cow'), rows[1].text.indexOf('1 cow'));
  assert(rows.every((row) => row.to === 'Bob'));
  trace.game.showInfo('Unknown');
  trace.game.stop();
  trace.game.showInfo('Bob');
  assert.deepEqual(trace.drain(), []);
});

test('Invalid guesses get one exact private error and can be retried in the same round', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  for (const guess of ['', '123', '12345', '1123', '12a4', '+123', '1.23', '12 3', '１２３４', '١٢٣٤', '9'.repeat(501)]) {
    trace.game.handleInput('Alice', guess, { messageTooLong: guess.length > 500 });
    assert.deepEqual(trace.drain(), [{ to: 'Alice', text: ERROR }]);
  }
  trace.game.handleInput('Alice', '0472');
  assert.deepEqual(trace.drain(), [{ to: 'all', text: 'Alice has submitted a guess.' }]);
  trace.game.handleInput('Bob', '1356');
  assert(broadcasts(trace).includes('Round 1 results:'));
});

test('An accepted guess is locked; a second submission cannot replace it', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  trace.game.handleInput('Alice', '0123');
  trace.drain();
  trace.game.handleInput('Alice', '0472');
  assert.deepEqual(trace.drain(), [{
    to: 'Alice', text: 'Server: You have already submitted a guess for this round.',
  }]);
  trace.game.handleInput('Bob', '1356');
  assert(broadcasts(trace).includes('Alice: 0123 -> 1 bull, 1 cow'));
  assert(!broadcasts(trace).some((text) => text.includes('wins!')));
  assert(broadcasts(trace).includes('Round 2 of 10'));
});

test('Feedback counts positions, displaced digits, and absent digits correctly', () => {
  // Expected scores are hand-calculated, independent of the scoring implementation.
  for (const [secret, guess, feedback] of [
    ['4271', '1234', '1 bull, 2 cows'],
    ['0472', '0123', '1 bull, 1 cow'],
    ['0472', '2740', '0 bulls, 4 cows'],
    ['0472', '2589', '0 bulls, 1 cow'],
    ['0472', '1356', '0 bulls, 0 cows'],
    ['0472', '0472', '4 bulls, 0 cows'],
  ]) {
    const trace = createTrace({ secrets: [secret] });
    trace.start(['Solo']);
    trace.game.handleInput('Solo', guess);
    assert(broadcasts(trace).includes(`Solo: ${guess} -> ${feedback}`), `${secret} versus ${guess}`);
  }
});

test('Correct guesses in the same round share the win regardless of submission order', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob', 'Cesar']);
  trace.game.handleInput('Bob', '0472');
  trace.game.handleInput('Alice', '0472');
  assert.deepEqual(broadcasts(trace), [
    'Bob has submitted a guess.', 'Alice has submitted a guess.',
  ]);
  trace.drain();
  trace.game.handleInput('Cesar', '1356');
  assert.deepEqual(broadcasts(trace), [
    'Cesar has submitted a guess.', 'Round 1 results:',
    'Alice: 0472 -> 4 bulls, 0 cows', 'Bob: 0472 -> 4 bulls, 0 cows',
    'Cesar: 1356 -> 0 bulls, 0 cows', 'Alice and Bob win!', 'Cesar loses.',
    'Secret number: 0472', LOBBY,
  ]);
});

test('Ten unsuccessful multiplayer rounds produce one loss and reveal the secret', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  for (let round = 1; round <= 10; round++) {
    trace.game.handleInput('Alice', '1356');
    assert.deepEqual(trace.drain(), [{ to: 'all', text: 'Alice has submitted a guess.' }]);
    trace.game.handleInput('Bob', '2589');
    const ending = round === 10
      ? ['Everyone loses! No correct guesses after 10 rounds.', 'Secret number: 0472', LOBBY]
      : [`Round ${round + 1} of 10`, PROMPT];
    assert.deepEqual(broadcasts(trace), [
      'Bob has submitted a guess.', `Round ${round} results:`,
      'Alice: 1356 -> 0 bulls, 0 cows', 'Bob: 2589 -> 0 bulls, 1 cow', ...ending,
    ]);
    trace.drain();
  }
});

test('A shared win in round 10 takes precedence over the loss limit', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  for (let round = 1; round <= 9; round++) {
    trace.game.handleInput('Alice', '1356');
    trace.game.handleInput('Bob', '2589');
    trace.drain();
  }
  trace.game.handleInput('Alice', '0472');
  trace.game.handleInput('Bob', '0472');
  assert(broadcasts(trace).includes('Round 10 results:'));
  assert(broadcasts(trace).includes('Alice and Bob win!'));
  assert(!broadcasts(trace).some((text) => text.includes('Everyone loses')));
});

test('Waiting players see results, then join a fresh game with new readiness and a new secret', () => {
  const trace = createTrace({ secrets: ['0472', '1357'] });
  trace.start(['Alice', 'Bob']);
  trace.game.addPlayer('Cesar');
  trace.drain();
  trace.game.handleInput('Cesar', '0472');
  assert.deepEqual(trace.drain(), [{ to: 'Cesar', text: WAITING }]);
  trace.game.handleInput('Alice', '0472');
  trace.game.handleInput('Bob', '0472');
  assert(!broadcasts(trace).some((text) => text.includes('Cesar loses')));
  trace.drain();
  trace.game.markReady('Alice');
  trace.game.markReady('Bob');
  assert.deepEqual(broadcasts(trace), ['Alice is ready.', 'Bob is ready.']);
  trace.drain();
  trace.game.markReady('Cesar');
  assert.deepEqual(broadcasts(trace), [
    'Cesar is ready.', 'Server: Game started. Players: Alice, Bob, Cesar.', 'Round 1 of 10', PROMPT,
  ]);
  trace.drain();
  trace.game.handleInput('Alice', '0472');
  trace.game.handleInput('Bob', '1357');
  trace.game.handleInput('Cesar', '9860');
  assert(broadcasts(trace).includes('Round 1 results:'));
  assert(broadcasts(trace).includes('Bob wins!'));
  assert(broadcasts(trace).includes('Alice and Cesar lose.'));
  assert(broadcasts(trace).includes('Secret number: 1357'));
});

test('An unsubmitted departure unblocks the remaining player immediately', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  trace.game.handleInput('Alice', '0472');
  trace.drain();
  trace.game.removePlayer('Bob');
  assert.deepEqual(broadcasts(trace), [
    'Bob disconnected.', 'Round 1 results:', 'Alice: 0472 -> 4 bulls, 0 cows',
    'Alice wins!', 'Secret number: 0472', LOBBY,
  ]);
});

test('A departed correct guess is removed and cannot win the remaining round', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob', 'Cesar']);
  trace.game.handleInput('Alice', '0472');
  trace.game.handleInput('Bob', '1356');
  trace.drain();
  trace.game.removePlayer('Alice', true);
  assert.deepEqual(trace.drain(), [{ to: 'all', text: 'Alice left.' }]);
  trace.game.handleInput('Cesar', '2589');
  assert.deepEqual(broadcasts(trace), [
    'Cesar has submitted a guess.', 'Round 1 results:',
    'Bob: 1356 -> 0 bulls, 0 cows', 'Cesar: 2589 -> 0 bulls, 1 cow', 'Round 2 of 10', PROMPT,
  ]);
});

test('Cancellation discards old guesses and admits waiting players only after READY', () => {
  const trace = createTrace({ secrets: ['0472', '1357'] });
  trace.start(['Alice', 'Bob']);
  trace.game.addPlayer('Cesar');
  trace.game.handleInput('Alice', '0472');
  trace.game.removePlayer('Alice');
  trace.drain();
  trace.game.removePlayer('Bob');
  assert.deepEqual(broadcasts(trace), [
    'Bob disconnected.', 'Server: Game canceled. All players left.', LOBBY,
  ]);
  trace.drain();
  trace.game.markReady('Cesar');
  trace.game.handleInput('Cesar', '1357');
  assert(broadcasts(trace).includes('Round 1 results:'));
  assert(broadcasts(trace).includes('Cesar wins!'));
  assert(broadcasts(trace).includes('Secret number: 1357'));
});

test('Shutdown cannot reveal pending guesses or advance a round after a departure', () => {
  const trace = createTrace();
  trace.start(['Alice', 'Bob']);
  trace.game.handleInput('Alice', '0472');
  trace.drain();
  trace.game.stop();
  trace.game.removePlayer('Bob');
  trace.game.handleInput('Alice', '1356');
  assert.deepEqual(broadcasts(trace), ['Bob disconnected.']);
});

test('Separate session instances keep their secrets and submissions independent', () => {
  const first = createTrace();
  const second = createTrace({ secrets: ['1357'] });
  first.start(['Solo']);
  second.start(['Solo']);
  first.game.handleInput('Solo', '0472');
  assert(broadcasts(first).includes('Solo wins!'));
  assert.deepEqual(second.events, []);
  second.game.handleInput('Solo', '1357');
  assert(broadcasts(second).includes('Secret number: 1357'));
});

test('Production generation always yields four distinct ASCII digits', () => {
  // Collect secrets only through normal completed games. The test never reads
  // private state or assumes that independent random draws must differ.
  for (let sample = 0; sample < 32; sample++) {
    const trace = createTrace({ random: true });
    trace.start(['Solo']);
    for (let round = 1; round <= 10; round++) {
      trace.game.handleInput('Solo', '1356');
      if (broadcasts(trace).some((text) => text.startsWith('Secret number: '))) break;
    }
    const reveals = broadcasts(trace).filter((text) => text.startsWith('Secret number: '));
    assert.equal(reveals.length, 1);
    const secret = reveals[0].slice('Secret number: '.length);
    assert.match(secret, /^[0-9]{4}$/);
    assert.equal(new Set(secret).size, 4);
  }
});

// Use the same replay contract for every ending. Start from round 3 so a missing
// round reset cannot pass merely because the previous game ended in round 1.
for (const ending of ['win', 'loss', 'cancellation']) {
  test(`A ${ending} clears readiness, submissions, round count, and secret before replay`, () => {
    const trace = createTrace({ secrets: ['0472', '1357'] });
    trace.start(['Alice', 'Bob']);
    for (let round = 1; round <= 2; round++) {
      trace.game.handleInput('Alice', '1356');
      trace.game.handleInput('Bob', '2589');
      trace.drain();
    }
    trace.game.addPlayer('Cesar');
    trace.game.addPlayer('Dana');
    trace.drain();
    trace.game.markReady('Cesar');
    trace.game.markReady('Dana');
    assert.deepEqual(trace.drain(), [
      { to: 'Cesar', text: WAITING }, { to: 'Dana', text: WAITING },
    ]);

    if (ending === 'win') {
      trace.game.handleInput('Alice', '0472');
      trace.game.handleInput('Bob', '1356');
      assert(broadcasts(trace).includes('Alice wins!'));
    } else if (ending === 'loss') {
      for (let round = 3; round <= 10; round++) {
        trace.game.handleInput('Alice', '1356');
        trace.game.handleInput('Bob', '2589');
      }
      assert(broadcasts(trace).includes('Everyone loses! No correct guesses after 10 rounds.'));
    } else {
      // Leave a pending guess behind, then remove every active player. It must
      // not be scored or inherited by the waiting players' following game.
      trace.game.handleInput('Alice', '0472');
      trace.game.removePlayer('Alice', true);
      trace.game.removePlayer('Bob');
      assert(broadcasts(trace).includes('Server: Game canceled. All players left.'));
      assert(!broadcasts(trace).some((text) => text.startsWith('Secret number:')));
    }
    assert.equal(broadcasts(trace).filter((text) => text === LOBBY).length, 1);
    trace.drain();

    // Completed-game history is unavailable in the lobby and cannot leak into replay.
    trace.game.showInfo('Cesar');
    assert.deepEqual(trace.drain(), [{ to: 'Cesar', text: 'Server: INFO is available during a game.' }]);

    const remaining = ending === 'cancellation'
      ? ['Cesar', 'Dana'] : ['Alice', 'Bob', 'Cesar', 'Dana'];
    for (const name of remaining.slice(0, -1)) {
      trace.game.markReady(name);
    }
    // Previous participants and waiting players must all make a fresh READY.
    assert.deepEqual(broadcasts(trace), remaining.slice(0, -1).map((name) => `${name} is ready.`));
    trace.drain();
    const last = remaining[remaining.length - 1];
    trace.game.markReady(last);
    assert.deepEqual(broadcasts(trace), [
      `${last} is ready.`, `Server: Game started. Players: ${remaining.join(', ')}.`,
      'Round 1 of 10', PROMPT,
    ]);
    trace.drain();
    trace.game.showInfo(last);
    assert.deepEqual(trace.drain(), [{ to: last, text: 'Server: No completed rounds yet.' }]);
    for (const name of remaining) {
      trace.game.handleInput(name, '1357');
    }
    assert(broadcasts(trace).includes('Round 1 results:'));
    assert(broadcasts(trace).includes('Secret number: 1357'));
    assert(!broadcasts(trace).some((text) => text.includes('0472')));
    assert.equal(broadcasts(trace).filter((text) => text.endsWith(' -> 4 bulls, 0 cows')).length, remaining.length);
  });
}
