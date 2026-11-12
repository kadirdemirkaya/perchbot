'use strict';

/**
 * The only bridge between the sandboxed page and the main process.
 * The page receives display data and can send back exactly six things:
 * "ready", "capture the mouse: yes/no", a drag phase, a menu item id, the id
 * of a mini that finished its exit scene, and a fun-mode request (a trip
 * around the screen, or the right-click menu).
 * The main process validates every value again.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));
const DRAG_PHASES = new Set(['start', 'move', 'end', 'cancel']);
const AGENT_ID_RE = /^[a-f0-9]{6,16}$/;
const FUN_ACTIONS = new Set(['context', 'flee', 'stroll', 'hop', 'inspect', 'home', 'whip-off']);

contextBridge.exposeInMainWorld('buddy', {
  onInit: on('buddy:init'),
  onView: on('buddy:view'),
  onSettings: on('buddy:settings'),
  onLayout: on('buddy:layout'),
  onMenuItems: on('buddy:menu-items'),
  onPaused: on('buddy:paused'),
  onFlight: on('buddy:flight'),
  onCrew: on('buddy:crew'),
  onMove: on('buddy:move'),
  onPet: on('buddy:pet'),
  onFun: on('buddy:fun'),
  onReleased: on('buddy:released'),
  ready: () => ipcRenderer.send('buddy:ready'),
  capture: (wanted) => ipcRenderer.send('buddy:capture', wanted === true),
  drag: (phase) => {
    if (DRAG_PHASES.has(phase)) ipcRenderer.send('buddy:drag', phase);
  },
  menu: (id) => {
    if (typeof id === 'string' && id.length < 40) ipcRenderer.send('buddy:menu', id);
  },
  fun: (action) => {
    if (FUN_ACTIONS.has(action)) ipcRenderer.send('buddy:fun', action);
  },
  crewLeft: (id) => {
    if (typeof id === 'string' && id.length <= 32 && AGENT_ID_RE.test(id)) ipcRenderer.send('buddy:crew-left', id);
  },
});
