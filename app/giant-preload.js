'use strict';

/**
 * The bridge for the giant peek's window (main.js, renderer/giant.html): a
 * click-through window over the buddy's screen. It only listens: what to draw
 * and where (app/giant.js plan), the phases, and "stop now". It cannot send
 * anything back.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));

contextBridge.exposeInMainWorld('giant', {
  onInit: on('giant:init'),
  onPhase: on('giant:phase'),
  onStop: on('giant:stop'),
});
