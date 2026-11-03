'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 740,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let client;

  // Send plain output to this window; late child-process events may arrive after close.
  function update(channel, value) {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  }

  ipcMain.on('client:connect', (event, host, port) => {
    if (event.sender !== window.webContents || client) return;
    // Reuse the existing terminal client instead of duplicating its TCP code.
    // Electron runs client.js as Node.js in this child process, with piped input/output.
    client = spawn(process.execPath, [path.join(__dirname, '..', 'client.js'), host, port], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    client.stdout.setEncoding('utf8');
    client.stderr.setEncoding('utf8');
    client.stdout.on('data', (text) => update('client:output', text));
    client.stderr.on('data', (text) => update('client:output', text));
    client.on('error', (error) => update('client:output', `${error.message}\n`));
    // A connection can close between a button click and its write to the input pipe.
    client.stdin.on('error', () => {});
    client.on('close', () => {
      client = undefined;
      update('client:running', false);
    });
    update('client:running', true);
  });

  ipcMain.on('client:send', (event, line) => {
    if (event.sender !== window.webContents || typeof line !== 'string') return;
    // Each click sends one line, exactly as pressing Enter in the terminal client.
    if (client?.stdin.writable && !/[\r\n]/.test(line)) client.stdin.write(`${line}\n`);
  });

  // Reloading the page can recover its controls without starting a second client.
  ipcMain.on('client:status', (event) => {
    if (event.sender === window.webContents) update('client:running', Boolean(client));
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, 'index.html'));
  // Closing the app acts like Ctrl+C in the terminal; typing QUIT remains a polite exit.
  app.on('before-quit', () => client?.kill('SIGINT'));
});

app.on('window-all-closed', () => app.quit());
