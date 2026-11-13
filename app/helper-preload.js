'use strict';

/**
 * The bridge for a helper's little window while it roams the screen
 * (main.js outings, renderer/helper.html). It only listens: what to draw,
 * how it moves, when it fades. It cannot send anything back.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));

contextBridge.exposeInMainWorld('helper', {
  onInit: on('helper:init'),
  onPose: on('helper:pose'),
  onFade: on('helper:fade'),
});
