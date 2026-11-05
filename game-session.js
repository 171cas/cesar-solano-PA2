'use strict';

const { randomInt } = require('crypto');

const MAX_ROUNDS = 10;
const INVALID_SUBMISSION = 'Invalid submission. Enter exactly four digits with no repeated digits.';

// Draw digits without replacement. Zero is available on the first draw too.
// Keep the result as text so a secret such as 0472 does not become 472.
function generateSecret() {
  const available = Array.from('0123456789');
  let secret = '';
  for (let position = 0; position < 4; position++) {
    const index = randomInt(available.length);
    secret += available.splice(index, 1)[0];
  }
  return secret;
}

// ASCII digits only: signs, decimals, spaces, and other numeral characters fail.
// The set counts distinct digits, so repeated digits cannot form a valid guess.
function isValidGuess(guess) {
  return typeof guess === 'string' && /^[0-9]{4}$/.test(guess) && new Set(guess).size === 4;
}

// Each digit can contribute once because both the secret and guess have no repeats.
// Check the exact position first so a bull is never counted again as a cow.
function scoreGuess(secret, guess) {
  let bulls = 0;
  let cows = 0;
  for (let position = 0; position < 4; position++) {
    if (guess[position] === secret[position]) {
      bulls++;
    } else if (secret.includes(guess[position])) {
      cows++;
    }
  }
  return { bulls, cows };
}

// Use the same readable name list for shared winners and multiple losing players.
function formatNames(names) {
  if (names.length === 1) {
    return names[0];
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// Create one session on the main thread; workers cannot change its private state.
// Message functions deliver the output without introducing socket dependencies.
function createGameSession({ sendToPlayer, broadcast }) {
  // Include every registered player, including those waiting for the next game.
  const players = new Set();
  const readyPlayers = new Set();
  // Snapshot membership at game start. Later arrivals wait for the next game.
  const activePlayers = new Set();
  // Store guesses only for the current round, keyed by the submitting player.
  const submissions = new Map();
  // Save only revealed results. INFO must never read pending round submissions.
  const history = [];
  let secret;
  let round = 0;
  let stopping = false;

  const lobbyHint = 'Server: Type READY to play or QUIT to leave.';
  const waitingHint = 'Server: A game is in progress. Wait for the next game.';

  // The same prompt is used at startup and after each unsuccessful round.
  function announceRound() {
    broadcast(`Round ${round} of ${MAX_ROUNDS}`);
    broadcast('Server: Submit exactly four digits with no repeated digits.');
  }

  // Unregistered connections cannot block the lobby. All changes happen together
  // before the next worker result is handled, so simultaneous READYs start once.
  function startIfEveryoneReady() {
    if (stopping || activePlayers.size > 0 || players.size === 0) {
      return;
    }
    for (const name of players) {
      if (!readyPlayers.has(name)) {
        return;
      }
    }

    // Generate one shared secret per game and keep it unchanged across rounds.
    secret = generateSecret();
    round = 1;
    submissions.clear();
    history.length = 0;
    for (const name of players) {
      activePlayers.add(name);
    }
    readyPlayers.clear();
    const names = Array.from(activePlayers).sort();
    broadcast(`Server: Game started. Players: ${names.join(', ')}.`);
    announceRound();
  }

  // Keep connections and waiting players, while discarding all prior game state.
  // Wins, losses, and cancellation all require everyone to type READY again.
  function returnToLobby() {
    activePlayers.clear();
    readyPlayers.clear();
    submissions.clear();
    history.length = 0;
    secret = undefined;
    round = 0;
    broadcast(lobbyHint);
  }

  // Announce the outcome before clearing the secret. Waiting players see results
  // but never appear in the winner or loser lists for a game they did not enter.
  function finishGame(winners) {
    if (winners.length === 0) {
      broadcast(`Everyone loses! No correct guesses after ${MAX_ROUNDS} rounds.`);
    } else {
      broadcast(`${formatNames(winners)} ${winners.length === 1 ? 'wins' : 'win'}!`);
      const losers = Array.from(activePlayers).sort().filter((name) => !winners.includes(name));
      if (losers.length > 0) {
        broadcast(`${formatNames(losers)} ${losers.length === 1 ? 'loses' : 'lose'}.`);
      }
    }
    broadcast(`Secret number: ${secret}`);
    returnToLobby();
  }

  // A correct guess waits for every other active submission, preserving shared wins.
  // This is also checked after a departure, which may unblock the remaining players.
  function finishRoundIfEveryoneSubmitted() {
    if (stopping || activePlayers.size === 0) {
      return;
    }
    for (const name of activePlayers) {
      if (!submissions.has(name)) {
        return;
      }
    }

    broadcast(`Round ${round} results:`);
    const winners = [];
    const results = [];
    // Sorting gives everyone the same result order, independent of submission speed.
    for (const name of Array.from(activePlayers).sort()) {
      const guess = submissions.get(name);
      const { bulls, cows } = scoreGuess(secret, guess);
      results.push({ name, guess, bulls, cows });
      broadcast(`${name}: ${guess} -> ${bulls} bull${bulls === 1 ? '' : 's'}, ${cows} cow${cows === 1 ? '' : 's'}`);
      if (bulls === 4) {
        winners.push(name);
      }
    }

    history.push({ round, results });

    // Check wins first: a correct submission in round 10 still wins.
    if (winners.length > 0) {
      finishGame(winners);
    } else if (round === MAX_ROUNDS) {
      finishGame([]);
    } else {
      round++;
      submissions.clear();
      announceRound();
    }
  }

  // The server validates and reserves the username before adding its membership.
  // Existing players keep their readiness; a newcomer always begins unready.
  function addPlayer(name) {
    if (stopping || players.has(name)) {
      return;
    }
    players.add(name);
    broadcast(`${name} joined.`);
    sendToPlayer(name, activePlayers.size > 0 ? waitingHint : lobbyHint);
  }

  // Only registered lobby members can become ready. A waiting player's READY is
  // rejected privately and cannot carry over into the following game.
  function markReady(name) {
    if (stopping || !players.has(name)) {
      return;
    }
    if (activePlayers.size > 0) {
      // Membership is fixed until the game ends; READY cannot restart or join it.
      sendToPlayer(name, activePlayers.has(name)
        ? 'Server: A game is already in progress.'
        : waitingHint);
      return;
    }
    if (readyPlayers.has(name)) {
      sendToPlayer(name, 'Server: You are already ready.');
      return;
    }
    readyPlayers.add(name);
    broadcast(`${name} is ready.`);
    startIfEveryoneReady();
  }

  // Replay completed rounds privately without submitting or replacing a guess.
  // Waiting players may also read feedback that everyone has already seen.
  function showInfo(name) {
    if (stopping || !players.has(name)) {
      return;
    }
    if (activePlayers.size === 0) {
      sendToPlayer(name, 'Server: INFO is available during a game.');
      return;
    }
    if (history.length === 0) {
      sendToPlayer(name, 'Server: No completed rounds yet.');
      return;
    }

    // Use the longest historical name so guesses line up across every round,
    // including rows belonging to players who have since left the game.
    let nameWidth = 0;
    for (const { results } of history) {
      for (const result of results) {
        nameWidth = Math.max(nameWidth, result.name.length);
      }
    }
    for (const { round, results } of history) {
      sendToPlayer(name, `Round ${round} results:`);
      for (const { name: player, guess, bulls, cows } of results) {
        const label = `${player}:`.padEnd(nameWidth + 2);
        // A singular "bull" is shorter; pad after its comma to align cow counts too.
        const feedback = `${bulls} bull${bulls === 1 ? '' : 's'},`.padEnd(9);
        sendToPlayer(name, `${label}${guess} -> ${feedback}${cows} cow${cows === 1 ? '' : 's'}`);
      }
    }
  }

  // Remove a departed player's guess before checking the remaining submissions.
  // A removed correct guess cannot win. polite means the player sent QUIT.
  function removePlayer(name, polite = false) {
    if (!players.delete(name)) {
      return;
    }
    readyPlayers.delete(name);
    submissions.delete(name);
    const wasActive = activePlayers.delete(name);
    broadcast(polite ? `${name} left.` : `${name} disconnected.`);

    // Shutdown cleans up membership without producing more rounds or game starts.
    if (stopping) {
      return;
    }
    if (wasActive) {
      if (activePlayers.size === 0) {
        broadcast('Server: Game canceled. All players left.');
        returnToLobby();
      } else {
        finishRoundIfEveryoneSubmitted();
      }
    } else {
      // A lobby departure can make all remaining players ready to start.
      startIfEveryoneReady();
    }
  }

  // General commands are routed by the server. This method handles lobby chat or
  // game submissions; the worker's length flag applies only to lobby chat.
  function handleInput(name, line, { messageTooLong = false } = {}) {
    if (stopping || !players.has(name)) {
      return;
    }
    if (activePlayers.size === 0) {
      if (line === '') {
        return;
      }
      if (messageTooLong) {
        sendToPlayer(name, 'Server: Message too long.');
        return;
      }
      broadcast(`${name}: ${line}`);
      return;
    }
    if (!activePlayers.has(name)) {
      sendToPlayer(name, waitingHint);
      return;
    }
    if (submissions.has(name)) {
      sendToPlayer(name, 'Server: You have already submitted a guess for this round.');
      return;
    }
    if (!isValidGuess(line)) {
      // Every invalid guess uses the same exact private error, including blank or
      // oversized input. Nothing is stored, so the player can submit again.
      sendToPlayer(name, INVALID_SUBMISSION);
      return;
    }

    submissions.set(name, line);
    // Never include the guess or feedback in this notice, even for a correct guess.
    broadcast(`${name} has submitted a guess.`);
    finishRoundIfEveryoneSubmitted();
  }

  // Stop transitions before the server closes sockets and removes their players.
  function stop() {
    stopping = true;
  }

  // Expose player operations while keeping secrets, submissions, and sets private.
  return { addPlayer, markReady, showInfo, removePlayer, handleInput, stop };
}

// Importing the factory does not create or share a session between callers.
module.exports = createGameSession;
