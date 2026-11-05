# PA #2 — Multiplayer Bulls and Cows

**Author:** Cesar Solano · **Student #:** 2596761 · **Course:** CSCI 4311

A TCP Bulls and Cows game for one or more players, with terminal and basic desktop clients. Players compete to guess the same secret number within 10 rounds.

The server and terminal client use only built-in Node.js modules and require no additional packages. The desktop GUI requires Electron.

## Installation

For the GUI, use Node.js 22.12+ and install Electron from the project folder. With nvm installed, run:

```bash
nvm install
nvm use
npm ci
```

`nvm install` and `npm ci` are initial setup steps. Repeat `npm ci` when dependencies change, and run `nvm use` in each new terminal. You can skip the nvm commands if a compatible Node.js version is already active.

## Running

Start the server and keep this terminal open:

```bash
node server.js 8989
```

### Terminal clients

In a separate terminal for each player:

```bash
node client.js localhost 8989
```

Use the server's hostname or IP instead of `localhost` when connecting from another computer.

### Desktop GUI

After installation, start each GUI client in a separate terminal. With nvm, select the project's Node.js version in that terminal before launching the GUI:

```bash
nvm use
npm run gui
```

Keep the server running separately. Enter its host and port, click **Connect**, and send your username, commands, and guesses through the input field. Launch one GUI per player; GUI and terminal clients can play together.

## Registration and commands

Enter a unique username of 3–16 ASCII letters, digits, underscores, or hyphens. Register everyone before sending `READY`: if you are the only registered player, it starts a solo game immediately.

| Input                           | Action                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `READY`                         | Mark yourself ready. Starts a game when all registered lobby players are ready.                                  |
| `INFO`                          | Privately show completed-round guesses and scores in aligned columns. Uses no turn; pending guesses stay hidden. |
| `AllUsers`                      | Privately list all registered players, including those waiting for the next game.                                |
| `CLEAR`                         | Clear the GUI message log without changing the game or its history (GUI only).                                   |
| `QUIT`                          | Disconnect and announce `<username> left.`                                                                       |
| Other text before a game starts | Chat with players in the lobby.                                                                                  |

Usernames and commands are case-sensitive. Commands take no arguments. Unexpected disconnects announce `<username> disconnected.`

## Game rules

- The server generates a secret of four distinct digits. Leading zero is allowed, such as `0472`.
- Submit one valid guess per round. Accepted guesses are locked; invalid guesses get a private error and can be retried without using a turn.
- Guesses stay hidden until all remaining active players submit. Everyone then sees all guesses and scores. There are no timers.
- A **bull** is a correct digit in the correct position; a **cow** is a correct digit in a different position.
- All correct guesses in the same round share the win. If nobody succeeds after 10 rounds, everyone loses. The secret is revealed when the game finishes.
- Late arrivals wait for the next game. Departing players' pending guesses are removed; remaining players continue. If all active players leave, the game is canceled.
- After a game ends or is canceled, readiness and game history reset. Everyone must send `READY` again to start a new game with a new secret.

## Architecture

All client communication goes through the server. Each TCP connection gets a real worker thread to parse and validate input; the main thread owns sockets and shared game state.

| File               | Responsibility                                                               |
| ------------------ | ---------------------------------------------------------------------------- |
| `server.js`        | Connections, registration, command routing, worker management, and shutdown. |
| `server-worker.js` | Per-client line buffering and input syntax checks.                           |
| `game-session.js`  | Lobby, readiness, hidden rounds, scoring, history, outcomes, and replay.     |
| `client.js`        | Terminal input and TCP communication.                                        |
| `gui/`             | A minimal Electron window that reuses `client.js`.                           |
