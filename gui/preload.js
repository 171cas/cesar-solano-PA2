'use strict';

const { ipcRenderer } = require('electron');

// Keep the page free of Node.js access. This preload connects its ordinary HTML
// controls to fixed IPC messages; it contains no networking or game rules.
window.addEventListener('DOMContentLoaded', () => {
  const connectForm = document.getElementById('connection');
  const inputForm = document.getElementById('input');
  const host = document.getElementById('host');
  const port = document.getElementById('port');
  const message = document.getElementById('message');
  const log = document.getElementById('log');
  const send = document.getElementById('send');

  ipcRenderer.on('client:output', (_event, text) => {
    // Assigning textarea text displays server output without interpreting HTML.
    log.value += text;
    log.scrollTop = log.scrollHeight;
  });
  ipcRenderer.on('client:running', (_event, running) => {
    connectForm.querySelectorAll('input, button').forEach((field) => { field.disabled = running; });
    message.disabled = !running;
    send.disabled = !running;
    if (running) message.focus();
  });

  connectForm.addEventListener('submit', (event) => {
    event.preventDefault();
    log.value = '';
    ipcRenderer.send('client:connect', host.value.trim(), port.value);
  });
  inputForm.addEventListener('submit', (event) => {
    event.preventDefault();
    ipcRenderer.send('client:send', message.value);
    message.value = '';
    message.focus();
  });
  ipcRenderer.send('client:status');
});
