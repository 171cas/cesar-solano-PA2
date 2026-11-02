# PA #2 — Multiplayer Bulls and Cows

**Author:** Cesar Solano
**Student #:** 2596761
**Course:** CSCI 4311

## Project description

A Bulls and Cows game with terminal and basic desktop clients using TCP sockets. Players try to guess the same secret four-digit number within 10 rounds. Each round uses hidden submissions: everyone submits a guess before the server reveals all guesses and their feedback. Players who guess correctly in the same round share the win.

The game supports one or more players. All communication goes through the server, which manages the secret number, readiness, submissions, round results, and wins or losses.

## Server architecture

The server uses Node.js `worker_threads` to run a separate JavaScript worker for each TCP connection.

- **TCP server (`server.js`):** Owns sockets, the username-to-socket registry, worker management, registration, command routing, and shutdown.
- **Game session (`game-session.js`):** Owns lobby membership, readiness, the active-player list, secret generation, hidden submissions, round scoring, wins and losses, cancellation, and lobby reset. Its private state lives in one session instance on the main thread. The server supplies message-delivery functions, so the session handles player names and rules without socket or worker dependencies.
- **Client workers (`server-worker.js`):** Each worker assembles its client's incoming text into complete lines, removes surrounding spaces and tabs, and checks username syntax and message length. It sends the parsed lines and validation results to the main thread through a private message channel.
- **Terminal client (`client.js`):** Sends newline-terminated UTF-8 input and displays the server's responses. Clients communicate through the server.

Worker results are applied synchronously on the main thread. Username claims and session changes finish before the next result is handled, preventing duplicate registrations and competing game starts.

The main thread decodes UTF-8 before forwarding chunks, preserving characters split across network reads. On input EOF, it waits for the worker to finish processing complete lines before closing the connection; incomplete final input is discarded. Late replies from a departing client's worker are ignored.

The server logs worker thread IDs when workers start and stop. Each disconnected client's worker is released, a failed worker closes only its own connection, and Ctrl+C or SIGTERM closes all connections and their workers.

## Requirements and running

Node.js is required. The project uses CommonJS and built-in modules only, with no package installation or compilation. The server and client have been tested with Node.js v18.20.3.

Start the TCP server:

```bash
node server.js 8989
```

Open a separate terminal for each client:

```bash
node client.js localhost 8989
```

The argument syntax is `node server.js <port>` and `node client.js <host> <port>`. Use the server's hostname or IP address instead of `localhost` when connecting from another computer. Ports must contain only decimal digits and be between 1 and 65535.

At the registration prompt, enter a unique username containing 3–16 ASCII letters, digits, underscores, or hyphens. Usernames are case-sensitive.

Connect and register everyone who wants to play together before typing `READY`. If only one player is registered, their `READY` starts a solo game immediately. Connections still at the username prompt do not count as players.

## Basic desktop GUI

The GUI is a small window around the existing `client.js`. It has host/port fields, a Connect button, a scrolling message log, and one input with a Send button. All registration, validation, and game rules work exactly as they do in the terminal.

Electron requires Node.js 22.12 or newer for installation. With nvm, install the version selected by `.nvmrc` and the single GUI dependency:

```bash
nvm install
nvm use
npm ci
```

Start the server with `node server.js 8989`, then run this in another terminal:

```bash
npm run gui
```

Click **Connect** and send a username at the server's prompt. Then send `READY`, guesses, or `quit` through the same input. For multiplayer, run `npm run gui` in a separate terminal for each player and register everyone before sending `READY`. Terminal and GUI players can play together.

Typing `quit` sends the normal polite departure. Closing the window disconnects like Ctrl+C in the terminal. The first GUI launch downloads the Electron runtime if needed. No GUI-specific server commands or changes to the game rules are required.

The three GUI files are `gui/main.js` (window and client process), `gui/preload.js` (form events and displayed output), and `gui/index.html` (basic controls). The GUI has no separate networking implementation, state snapshots, or styling files.

## Commands

| Input | What it does |
| --- | --- |
| `READY` | Marks you ready. Starts a game when all registered lobby players are ready. |
| `AllUsers` | Privately lists all registered usernames, including players waiting for the next game. |
| `INFO` | During a game, privately lists all completed-round guesses and results in aligned columns. Does not use your guess. |
| `quit` | Disconnects you and announces `<username> left.` to the remaining players. |
| Other text in the lobby | Sends a chat message to registered players. |

Commands are case-sensitive and take no extra arguments. Surrounding spaces and tabs are ignored. Sending `READY` again while already ready gives a private `Server: You are already ready.` response. Malformed commands also receive private errors and do not change readiness.

Registration announces `<username> joined.` to registered players and privately tells the newcomer to type `READY` or `quit`. A player joining during an active game receives `Server: A game is in progress. Wait for the next game.` instead. Waiting players cannot mark themselves ready for or submit guesses to the active game, but can use `INFO` to read revealed results.

Once the game starts, enter a four-digit guess such as `0472` and press Enter. A valid guess is locked for the current round. Wait for all active players to submit before the server reveals the guesses and feedback. After the game ends, everyone types `READY` again to play another game.

Type `INFO` during a game to review completed rounds. Results go only to you, with guesses and scores aligned for easy reading. Current-round guesses stay hidden until everyone submits. If no round has finished, the server replies `Server: No completed rounds yet.` History is cleared when the game ends; using `INFO` in the lobby replies `Server: INFO is available during a game.`

```text
Round 1 results:
Alice: 0123 -> 1 bull,  1 cow
Bob:   2589 -> 0 bulls, 1 cow
```

## Game rules

### Secret number

- The server randomly generates one secret consisting of exactly four digits.
- No digit may appear more than once.
- Leading zero is allowed: `0472` is a valid secret or guess.
- The same secret is used by every player throughout the game and stays hidden during play.

### Lobby and READY

1. Players connect and register unique usernames.
2. Each player types `READY` when ready to begin.
3. Everyone receives a notice when a player is ready, such as `Alice is ready.`
4. While no game is active, the game starts when every player currently in the lobby is ready. At least one player must be present.
5. A single player can type `READY` to start a solo game.

### Game lifecycle

#### Joining

- After successful username registration, the server announces `<username> joined.` to all registered players, including the new player. For example: `Cesar joined.`
- Players can connect while a game is active. New players enter a waiting lobby for the next game and do not participate in or affect the current game.
- Reconnecting with a released username creates a new player. Previous readiness and submissions are not restored; if a game is active, the new connection waits for the next one.

#### Leaving and disconnecting

- A registered player can leave at any time by typing `quit`.
- On `quit`, the server disconnects that player and announces `<username> left.` to the remaining registered players. For example: `Cesar left.`
- If a connection drops unexpectedly, the server announces `<username> disconnected.` instead. For example: `Cesar disconnected.`
- Each departure is announced only once. Both types of departure use the same cleanup rules.
- If a player leaves the lobby while no game is active, the server checks whether every remaining lobby player is ready. If so, a new game starts. A game never starts with zero players.

#### Departures during a game

- Remove the departed player and any guess they submitted for the current round. Their guess is not included in the round results and cannot win that round.
- If every remaining active player has submitted a valid guess, reveal the round results and apply the normal win or next-round rules.
- If only one active player remains, continue the game in solo mode with the same secret and round count.
- A waiting player's departure does not advance or cancel the active game.
- If all active players leave, cancel the game and return to the lobby. Any waiting players remain connected and can start a new game using `READY`.
- There are no submission timers. A round waits for each active player to submit a valid guess or leave.

#### Finishing and playing again

- After a win or a loss at the round limit, display the outcome and return all connected players, including waiting players, to the lobby.
- Reset everyone to not ready and clear the previous game's submissions and round state. The same reset applies when a game is canceled because all active players left.
- Each player must type `READY` again. When all lobby players are ready, generate a new random secret and start at round 1.
- Players can play another game without restarting the server or reconnecting.

### Hidden submissions

1. Each active player submits one valid guess per round. Players waiting for the next game do not submit guesses.
2. The server keeps the guess hidden and announces only that the player has submitted, such as `Alice has submitted a guess.`
3. An accepted guess is locked for that round; the player cannot replace it or submit another guess.
4. The server waits until every remaining active player has submitted a valid guess.
5. The server then reveals each remaining active player's guess and its bulls and cows to everyone at the same time.
6. If nobody has won and fewer than 10 rounds have been completed, the next round begins.

There are no submission timers or speed-based tie breakers. In solo mode, each valid submission completes the round immediately.

### Submission validation

A valid guess contains exactly four digits with no repeated digits. Leading zero is allowed. For any invalid submission, the server sends this exact message only to the player who submitted it:

```text
Invalid submission. Enter exactly four digits with no repeated digits.
```

An invalid submission does not count as the player's guess and does not advance the round. The player must retry until a valid guess is accepted. Other players do not receive the error message or an invalid-submission notice. Blank and oversized guesses use the same error.

After a valid submission, further guesses in that round receive the private response `Server: You have already submitted a guess for this round.` The accepted guess is kept.

### Bulls and cows

| Feedback | Meaning |
| --- | --- |
| Bull | A correct digit in the correct position. |
| Cow | A correct digit in a different position. |

Each matching digit counts as either a bull or a cow, never both. A digit absent from the secret contributes neither.

For example, if the secret is `4271`, the guess `1234` receives **1 bull and 2 cows**: `2` is in the correct position, while `1` and `4` are present in different positions.

### Winning and losing

- A guess with four bulls is correct.
- Winners are determined after every remaining active player has submitted and the round results are revealed.
- Every player with a correct guess in that round wins. Multiple correct players share the win, regardless of submission order.
- When a round has a winner, the game ends; active players without a correct guess lose. Waiting players are not part of that game's outcome.
- The game lasts at most **10 rounds**, not 10 guesses shared across all players.
- Correct guesses in round 10 still win. If nobody has guessed correctly after round 10, everyone loses and the server reveals the secret number.

## Example round

Illustrative output for a game whose secret is `0472`:

```text
Round 3 of 10
Server: Submit exactly four digits with no repeated digits.
Alice has submitted a guess.
Bob has submitted a guess.
Cesar has submitted a guess.

Round 3 results:
Alice: 0123 -> 1 bull, 1 cow
Bob:   0472 -> 4 bulls, 0 cows
Cesar: 0472 -> 4 bulls, 0 cows

Bob and Cesar win!
Alice loses.
Secret number: 0472
Server: Type READY to play or quit to leave.
```

The submission notices do not reveal guesses or feedback. Results appear only after all players have submitted valid guesses.

## Verification

Run the game-session, networking, and threading checks:

```bash
node test-game-session.js
node test-network.js
node test-threading.js
```

The game-session tests exercise rules directly without sockets. The networking and threading scripts start and stop their own local servers and clients. No manually started server is needed.

The game-session checks cover validation, scoring, hidden and locked submissions, shared wins, the round-10 boundary, fresh games, random secret format, and departures during a round. Replay checks separately verify that wins, losses, and cancellations clear readiness, submissions, the secret, and the round count before the next game.

The networking checks cover argument errors, registration, duplicate usernames, concurrent messaging, line buffering, message limits, commands, and departures. They also verify solo and multiplayer startup, readiness privacy, concurrent `READY` messages, waiting players, cancellation, and readiness checks after departures. Complete TCP game checks exercise private errors, shared and individual wins, a 10-round loss, and replay without restarting.

TCP lifecycle checks verify removal of a departed correct guess, queued input after `quit`, username reuse, dropped connections unblocking rounds, waiting departures, continued solo rounds, and cancellation after the final active disconnect. The threading checks verify distinct worker IDs, independent client buffers, split UTF-8 input, complete lines arriving before EOF, worker cleanup, worker failure isolation, and server shutdown. Worker exceptions and unexpected exits are also tested during an active round, through continued play and a subsequent game.
