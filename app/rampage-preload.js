'use strict';

/**
 * The bridge for the effect windows (main.js): click-through windows over the
 * buddy's screen. renderer/rampage.html draws the beams, the missiles and the
 * marks they leave; renderer/fist.html the rocket fist (hands). They only
 * listen: the plan (app/rampage.js, app/fist.js), where the cursor is during
 * the rampage's chase (its position, or null when it is on another screen)
 * and "stop now". They cannot send anything back.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));

contextBridge.exposeInMainWorld('effects', {
  onPlan: on('effects:plan'),
  onAim: on('effects:aim'),
  onStop: on('effects:stop'),
});
