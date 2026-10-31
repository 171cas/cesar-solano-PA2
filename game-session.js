'use strict';

// Create one session on the server's main thread. The sets stay private to this
// instance, so workers cannot change game membership or readiness directly.
// The supplied functions deliver messages; this module never handles sockets.
function createGameSession({ sendToPlayer, broadcast }) {
  // Include every registered player, including those waiting for the next game.
  const players = new Set();
  const readyPlayers = new Set();
  // A nonempty active set means a game is in progress. Snapshot its members at
  // game start so later arrivals cannot add themselves to an existing game.
  const activePlayers = new Set();
  let stopping = false;

  const lobbyHint = 'Server: Type READY to play or quit to leave.';
  const waitingHint = 'Server: A game is in progress. Wait for the next game.';

  // Unregistered connections are absent from players and cannot block the lobby.
  // Keep all checks and the membership change synchronous so a start happens once.
  function startIfEveryoneReady() {
    if (stopping || activePlayers.size > 0 || players.size === 0) {
      return;
    }
    for (const name of players) {
      if (!readyPlayers.has(name)) {
        return;
      }
    }

    for (const name of players) {
      activePlayers.add(name);
    }
    readyPlayers.clear();
    const names = Array.from(activePlayers).sort();
    broadcast(`Server: Game started. Players: ${names.join(', ')}.`);
  }

  // Waiting players stay connected after cancellation, but readiness never carries
  // into the next game. Each player must explicitly type READY in the new lobby.
  function returnToLobby() {
    activePlayers.clear();
    readyPlayers.clear();
    broadcast(lobbyHint);
  }

  // The server calls this only after validating and reserving a unique username.
  // Existing players keep their readiness; the newcomer always begins unready.
  function addPlayer(name) {
    if (stopping || players.has(name)) {
      return;
    }
    players.add(name);
    broadcast(`${name} joined.`);
    sendToPlayer(name, activePlayers.size > 0 ? waitingHint : lobbyHint);
  }

  // Apply READY as one lobby operation. Ignore callers without membership so an
  // unregistered or departed connection cannot create readiness for a ghost player.
  function markReady(name) {
    if (stopping || !players.has(name)) {
      return;
    }
    if (activePlayers.size > 0) {
      // Waiting players cannot join mid-game, and active players cannot restart it.
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

  // Remove membership before checking readiness or canceling the current game.
  // polite selects the explicit-quit notice; dropped connections use disconnected.
  function removePlayer(name, polite = false) {
    if (!players.delete(name)) {
      return;
    }
    readyPlayers.delete(name);
    const wasActive = activePlayers.delete(name);
    broadcast(polite ? `${name} left.` : `${name} disconnected.`);

    // Shutdown still removes players but must not trigger another game or lobby.
    if (stopping) {
      return;
    }
    if (wasActive && activePlayers.size === 0) {
      broadcast('Server: Game canceled. All players left.');
      returnToLobby();
    } else {
      // A remaining active player continues alone. With an open lobby, removing
      // an unready player can instead make every remaining player ready to start.
      startIfEveryoneReady();
    }
  }

  // The server routes non-command text here after its general input checks.
  // Whether it is lobby chat or private game input is a session rule, so the
  // networking code does not need access to the membership or readiness sets.
  function handleInput(name, line) {
    if (stopping || !players.has(name)) {
      return;
    }
    if (activePlayers.size > 0) {
      sendToPlayer(name, activePlayers.has(name)
        ? 'Server: Game in progress.'
        : waitingHint);
      return;
    }
    broadcast(`${name}: ${line}`);
  }

  // Called before the server closes its sockets. Later departure notifications
  // can still clean up membership, but readiness can no longer start a game.
  function stop() {
    stopping = true;
  }

  // Expose player operations, keeping the sets and lifecycle decisions private.
  return { addPlayer, markReady, removePlayer, handleInput, stop };
}

// Export the factory so importing this module does not create shared global state.
module.exports = createGameSession;
