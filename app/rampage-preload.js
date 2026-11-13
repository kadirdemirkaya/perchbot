'use strict';

/**
 * The bridge for the rampage's effect window (main.js, renderer/rampage.html):
 * a click-through window over the buddy's screen that draws the beams, the
 * missiles and the marks they leave. It only listens: the plan (app/rampage.js),
 * where the cursor is during the chase (its position, or null when it is on
 * another screen) and "stop now". It cannot send anything back.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));

contextBridge.exposeInMainWorld('effects', {
  onPlan: on('effects:plan'),
  onAim: on('effects:aim'),
  onStop: on('effects:stop'),
});
