'use strict';

/**
 * The only bridge between the sandboxed page and the main process.
 * The page receives display data and can send back exactly these things:
 * "ready", "capture the mouse: yes/no", a drag phase, a menu item id, the id
 * of a mini that finished its exit scene, a fun-mode request (a trip around
 * the screen, or the right-click menu), a rampage (where its eyes are), "a frame was drawn" during a trip
 * (the window then moves in step with the display), "hidden" while switching
 * sides, and a chat request: open / close the panel, or a question (or a
 * hands command) as one of the chat's intents. The panel has buttons only:
 * no text crosses this bridge.
 * The main process validates every value again.
 */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (callback) => ipcRenderer.on(channel, (_event, data) => callback(data));
const DRAG_PHASES = new Set(['start', 'move', 'end', 'cancel']);
const AGENT_ID_RE = /^[a-f0-9]{6,16}$/;
const FUN_ACTIONS = new Set(['context', 'flee', 'stroll', 'hop', 'inspect', 'home', 'whip-off', 'cruise', 'hang', 'loop', 'perch', 'peek', 'cat', 'cat-away', 'guest', 'guest-away', 'typing', 'land', 'find']);
const CHAT_OPS = new Set(['open', 'close', 'ask']);
/** The hands commands (app/chat.js HAND_INTENTS; a test keeps the two lists equal). */
const HAND_INTENTS = new Set(['openchrome', 'closechrome', 'newtab', 'closetab', 'youtube']);
const INTENT_RE = /^[a-z]{2,12}$/;

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
  onMoment: on('buddy:moment'),
  onPresence: on('buddy:presence'),
  onHands: on('buddy:hands'),
  /** Hands were off; the user clicked "Yes" in the bubble: turn them on and do `intent`. */
  handsOn: (intent) => {
    if (HAND_INTENTS.has(intent)) ipcRenderer.send('buddy:hands-on', intent);
  },
  /** "Close Chrome?" in the bubble: the user clicked "Yes". */
  handsGo: (intent) => {
    if (HAND_INTENTS.has(intent)) ipcRenderer.send('buddy:hands-go', intent);
  },
  onPet: on('buddy:pet'),
  onFun: on('buddy:fun'),
  onReleased: on('buddy:released'),
  onFlip: on('buddy:flip'),
  onChat: on('buddy:chat'),
  onBug: on('buddy:bug'),
  onOutingBack: on('buddy:outing-back'),
  onRampage: on('buddy:rampage'),
  onFollow: on('buddy:follow'),
  /** "Watch me type": go and look? ({ offer }), and the phases there ({ phase: 'look' | 'aha' | null }). */
  onTyping: on('buddy:typing'),
  /** "Come and tell me": go and tell the user? ({ offer }), and there ({ phase: 'here' }). */
  onFind: on('buddy:find'),
  onGuest: on('buddy:guest'),
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
  tripFrame: () => ipcRenderer.send('buddy:trip-frame'),
  flipReady: () => ipcRenderer.send('buddy:flip-ready'),
  /** A helper flew out to roam the screen: who, its colour, its spot and where it stood (page px). */
  outing: (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !AGENT_ID_RE.test(msg.id)) return;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const out = { id: msg.id, tint: num(msg.tint), off: num(msg.off), x: num(msg.x), y: num(msg.y) };
    if (Object.values(out).some((v) => v === null)) return;
    ipcRenderer.send('buddy:outing', out);
  },
  /** Its head caught fire twice in five minutes: where its eyes and chest hatch are (page px), which way it faces. */
  rampage: (msg) => {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.eyes)) return;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const point = (p) => (p && typeof p === 'object' && num(p.x) !== null && num(p.y) !== null ? { x: p.x, y: p.y } : null);
    const eyes = msg.eyes.slice(0, 2).map(point);
    const hatch = point(msg.hatch);
    if (!eyes.length || eyes.includes(null) || !hatch) return;
    ipcRenderer.send('buddy:rampage', { eyes, hatch, face: msg.face === 'left' ? 'left' : 'right' });
  },
  /** Call a roaming helper back. */
  outingEnd: (id) => {
    if (typeof id === 'string' && AGENT_ID_RE.test(id)) ipcRenderer.send('buddy:outing-end', id);
  },
  chat: (op, intent) => {
    if (!CHAT_OPS.has(op)) return;
    if (op !== 'ask') ipcRenderer.send('buddy:chat', { op });
    else if (typeof intent === 'string' && INTENT_RE.test(intent)) ipcRenderer.send('buddy:chat', { op, intent });
  },
  crewLeft: (id) => {
    if (typeof id === 'string' && id.length <= 32 && AGENT_ID_RE.test(id)) ipcRenderer.send('buddy:crew-left', id);
  },
});
