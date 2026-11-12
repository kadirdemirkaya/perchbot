'use strict';

/**
 * The only bridge between the sandboxed page and the main process.
 * The page receives display data and can send back exactly four things:
 * "ready", "capture the mouse: yes/no", a drag phase, and a menu item id.
 * The main process validates every value again.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));
const DRAG_PHASES = new Set(['start', 'move', 'end', 'cancel']);

contextBridge.exposeInMainWorld('buddy', {
  onInit: on('buddy:init'),
  onView: on('buddy:view'),
  onSettings: on('buddy:settings'),
  onLayout: on('buddy:layout'),
  onMenuItems: on('buddy:menu-items'),
  onPaused: on('buddy:paused'),
  onFlight: on('buddy:flight'),
  onReleased: on('buddy:released'),
  ready: () => ipcRenderer.send('buddy:ready'),
  capture: (wanted) => ipcRenderer.send('buddy:capture', wanted === true),
  drag: (phase) => {
    if (DRAG_PHASES.has(phase)) ipcRenderer.send('buddy:drag', phase);
  },
  menu: (id) => {
    if (typeof id === 'string' && id.length < 40) ipcRenderer.send('buddy:menu', id);
  },
});
