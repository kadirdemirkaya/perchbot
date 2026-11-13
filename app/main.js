'use strict';

/**
 * Agent Buddy overlay: Electron main process.
 *
 *   hooks/send.js --HTTP--> server.js --> core.js (state machine) --IPC--> renderer
 *
 * - One instance only. A second launch forwards its event to the first one
 *   (requestSingleInstanceLock additionalData) and exits.
 * - Transparent, frameless, never-focused window. It ignores the mouse (clicks
 *   reach the windows below) except while the pointer is over the character
 *   or its open hover menu; the renderer decides, and a watchdog here releases
 *   the mouse whenever the cursor is outside the window.
 * - No network access: http(s)/ws(s) requests are blocked, the page is served
 *   from a private buddy:// scheme with a strict CSP.
 * - Sub-agents ("minis") stand next to the character. The window grows towards
 *   the inner side for them, so the character itself never moves.
 * - Fun mode: the page asks for trips around the screen (roam.js plans them,
 *   this file moves the window frame by frame). Where it went is kept only
 *   for this run; the user's chosen place stays its home.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  screen,
  session,
  shell,
} = require('electron');

const { BuddyCore } = require('./core');
const { validateEvent } = require('./validate');
const { startServer } = require('./server');
const { buddyHome, settingsPath, loadSettings, saveSettings, effectivePort, rememberAccount } = require('./settings');
const { discoverCharacters } = require('./characters');
const { translate } = require('./i18n');
const placement = require('./placement');
const roam = require('./roam');
const outingsLib = require('./outings');
const fling = require('./fling');
const { buildTrayTemplate, buildFunMenuTemplate } = require('./tray');
const { buildMenuItems, MENU_IDS, switchFor } = require('./menu-items');
const chat = require('./chat');
const FEATURES = require('./features');
const { createLogger } = require('./log');

const ROOT = path.resolve(__dirname, '..');
const RENDERER_DIR = path.join(__dirname, 'renderer');
const ASSETS_DIR = path.join(__dirname, 'assets');
const HOME = buddyHome();
const SCHEME = 'buddy';
const ORIGIN = `${SCHEME}://local`;
/** "Quit now" keeps the overlay from relaunching for the current sessions this long. */
const MUTE_MS = 12 * 60 * 60 * 1000;
/** While the window takes mouse input, check this often that the cursor is still inside. */
const WATCHDOG_MS = 100;
/** Drag speed (DIP per move event) that gives the flames their full tilt. */
const TILT_SPEED = 14;
/** The tilt settles back to 0 when the cursor rests this long during a drag. */
const TILT_SETTLE_MS = 140;
/** Agent hashes from the hook (see validate.js); the page sends them back when a mini has left. */
const AGENT_ID_RE = /^[a-f0-9]{6,16}$/;
/** Events that start the overlay (as in hooks/send.js). */
const LAUNCH_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
/** What the page may ask for (fun mode): a trip, or the right-click menu. */
const FUN_ACTIONS = new Set(['context', 'flee', 'stroll', 'hop', 'inspect', 'home', 'whip-off']);
/**
 * While the window travels, the page reports every frame it draws (vsync) and
 * the window moves then. This timer only fills in if those reports stop: Node
 * timers on Windows tick every ~15.6 ms, so a 16 ms interval alone moves the
 * window in uneven 16 / 31 ms steps (about 45 per second): a visible stutter.
 */
const TRIP_FALLBACK_MS = 50;
/** States that do not interrupt a trip; any other one (work) stops it at once. */
const CALM_STATES = new Set(['idle', 'standby', 'greeting']);
/** The cat's exit scene, before the window shrinks back. */
const PET_EXIT_MS = 2200;
/** Switching sides: the longest wait for the page to hide before the window moves anyway. */
const FLIP_WAIT_MS = 150;
/** Going to another screen: the page fades out (overlay.css .stage.warping), then the window jumps. */
const WARP_WAIT_MS = 400;
/** ...and fades in on the other screen before the trip goes on there. */
const WARP_IN_MS = 260;
/** The side column while the chat panel is open (CSS px; see overlay.css .chat). */
const CHAT_WIDTH = 176;
/** The window level: above other always-on-top windows and full-screen apps (Electron levels). */
const TOP_LEVEL = 'screen-saver';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const isDev = process.argv.includes('--dev');
/**
 * Developers only (npm run dev): AGENT_BUDDY_PERF=1 logs how often and how long the
 * window is moved and resized, and turns on the page's frame trace ("[perf]" lines).
 */
const PERF = isDev && process.env.AGENT_BUDDY_PERF === '1';
/**
 * Developers only (npm run dev): AGENT_BUDDY_DEMO=duel | trips | plays | cheers | menu | chat
 * plays that part of fun mode by itself (menu: opens the hover menu; chat: asks two questions), for
 * screenshots and trying things out.
 */
const DEMOS = new Set(['duel', 'trips', 'plays', 'cheers', 'menu', 'chat']);
const demo = isDev && DEMOS.has(process.env.AGENT_BUDDY_DEMO) ? process.env.AGENT_BUDDY_DEMO : null;
const DEMO_TRIPS = ['stroll', 'hop', 'screen', 'inspect', 'home'];
/** Short lines in the speech bubble when it is hit or fights (locales: "quip"). */
const QUIPS = ['ouch', 'hey', 'enough', 'fedUp', 'fuming', 'blazing', 'erupt', 'enGarde', 'gotYou', 'parried', 'hurt', 'blocked', 'robotWins', 'youWin', 'busy', 'giggle', 'sneeze', 'bugFixed'];

// Keep Chromium's own data (caches, the single-instance lock) under
// ~/.agent-buddy too, so there is exactly one folder to delete on uninstall.
app.setPath('userData', path.join(HOME, 'electron'));

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const initialEvent = decodeInitialEvent(process.argv);

if (!app.requestSingleInstanceLock({ event: initialEvent })) {
  // An overlay is already running and has received our event. Nothing to do.
  app.quit();
} else {
  start();
}

function start() {
  let { settings, error: settingsError } = loadSettings();
  const log = createLogger({ dev: isDev, debug: settings.debug, dir: path.join(HOME, 'logs') });
  if (settingsError) log.warn(settingsError);

  const core = new BuddyCore({
    timings: { idleTimeoutMs: settings.idleTimeoutMinutes * 60 * 1000 },
    account: settings.account,
    // Sessions that report Claude Code's pid close when that process is gone.
    liveness: {},
  });

  /** @type {Map<string, object>} */
  let characters = new Map();
  let character = null;
  let win = null;
  let tray = null;
  let server = null;
  let rendererReady = false;
  let rendererRestarts = 0;
  let traySessionCount = -1;
  let quitting = false;

  // Geometry: the anchor is the bottom-centre of the character slot.
  let anchor = null;
  let pageLayout = null;
  let capturing = false;
  let watchdog = null;
  let drag = null;
  let paused = false;
  /** Hovering with sole thrusters: { airborne, boost (being dragged), tilt (-1..1) }. */
  let flight = { airborne: false, boost: false, tilt: 0 };
  /** Sub-agents from the core (AgentRegistry.list()), in arrival order. */
  let crew = [];
  /** The trip in progress: { plan, start, side, timer, then } (see roam.js). */
  let trip = null;
  /** On the way to another screen, faded out: { point, then, timer } (see warpTo). */
  let warping = null;
  /** Where a trip left the character (this run only); null = at home. */
  let roamAnchor = null;
  let demoIndex = -1;
  /** The whip from the right-click menu is in the user's hand (the page shows it). */
  let whipOn = false;
  /** The cat is on screen (called from a menu, which turns the "Cat" setting on). */
  let petOn = false;
  /** The bug of the bug hunt ({ id, phase } from core) and where it sits (0..1, see placement.bugSpot). */
  let bug = null;
  let bugOffset = 0.5;
  let petTimer = null;
  /** The chat panel is open: the side column is wider (CHAT_WIDTH). */
  let chatOpen = false;
  /**
   * The user is typing a question: only then may the window take the keyboard
   * (focusable). The rest of the time it never takes focus, also not for the
   * question buttons.
   */
  let chatTyping = false;

  // ------------------------------------------------------------------ events

  function dispatch(raw, source) {
    const evt = validateEvent(raw);
    if (!evt) {
      log.warn(`ignored invalid event (${source})`);
      return;
    }
    log.info(`event ${evt.event}${evt.tool ? ` tool=${evt.tool}` : ''}${evt.demo ? ` ${evt.demo}` : ''}${evt.pid ? ' +pid' : ''} (${source})`);
    if (quitting) {
      relaunchFor(evt);
      return;
    }
    if (evt.event === 'Demo') {
      onDemo(evt.demo);
      return;
    }
    core.handle(evt);
    refreshTrayIfNeeded();
  }

  core.on('state', (snap) => {
    log.info(`state ${snap.state}`);
    log.devOnly(`bubble: ${bubbleText(snap) || '(none)'}`);
    // Work comes first: a trip stops where it is the moment Claude Code needs the buddy.
    // (Not a throw: it only takes a moment, and the bubble shows the work at once anyway.)
    if (trip && trip.plan.kind !== 'fling' && !CALM_STATES.has(snap.state)) {
      log.devOnly(`trip: stopped by ${snap.state}`);
      endTrip(true);
      placeWindow();
    }
    sendView();
  });

  /**
   * What the page gets of the bug: no session, no command; which one, how it goes, and the
   * helper that found it (its short hash, the same id the page already has for that helper).
   */
  const bugPayload = () => (bug ? { id: bug.id, phase: bug.phase, agent: bug.agent || null } : null);

  // Bug hunt (app/bugs.js): every new bug turns up at a slightly different spot at its feet.
  core.on('bug', (next) => {
    if (next && (!bug || next.id !== bug.id)) bugOffset = Math.random();
    bug = next;
    log.devOnly(`bug: ${next ? `${next.id} ${next.phase}` : '(none)'}`);
    if (pageLayout && !drag) placeWindow();
    if (canSend()) win.webContents.send('buddy:bug', bugPayload());
  });

  core.on('crew', (list) => {
    crew = list;
    log.devOnly(`crew: ${list.map((a) => `${a.type}:${a.status}`).join(', ') || '(none)'}`);
    // Grow (or shrink) the window first, so a new mini has room when it appears.
    // (Before the window exists there is nothing to resize; screen is not ready yet.)
    if (pageLayout && !drag) {
      const next = computePlacement();
      if (next.page.sideWidth !== pageLayout.sideWidth || next.page.crew.capacity !== pageLayout.crew.capacity) {
        placeWindow();
      }
    }
    sendCrew();
  });

  // A Claude account seen for the first time in this run: offer it in the tray menu.
  core.on('account', (name) => {
    const known = rememberAccount(settings.knownAccounts, name);
    if (known !== settings.knownAccounts) updateSettings({ knownAccounts: known });
    else refreshTray();
  });

  core.on('gone', (_session, why) => log.info(`session closed: its Claude Code process is gone (${why})`));

  /**
   * A session starts (or a prompt comes) while this instance is on its way out:
   * the hook found the server closed and started a new overlay, but this one
   * still holds the single-instance lock, so the event landed here. Start a
   * fresh overlay with it once this one has exited; otherwise the buddy would
   * only come back with the next prompt.
   */
  let relaunching = false;
  function relaunchFor(evt) {
    if (relaunching || !LAUNCH_EVENTS.has(evt.event)) return;
    if (settings.account !== 'all' && evt.account !== settings.account) return;
    relaunching = true;
    const args = process.argv.slice(1).filter((a) => !a.startsWith('--initial-event='));
    args.push('--initial-event=' + Buffer.from(JSON.stringify(evt), 'utf8').toString('base64url'));
    log.info(`event ${evt.event} while quitting: starting again after exit`);
    app.relaunch({ args });
  }

  core.on('quit', (reason) => {
    log.info(`quitting (${reason})`);
    quitApp();
  });

  app.on('second-instance', (_event, _argv, _cwd, data) => {
    if (data && data.event) dispatch(data.event, 'second-instance');
  });

  // We decide when to quit (last session ended, tray, idle timeout).
  app.on('window-all-closed', () => {});

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });

  /** IPC from anything other than our own page is ignored. */
  const fromPage = (event) => win && !win.isDestroyed() && event.sender === win.webContents;

  ipcMain.on('buddy:ready', (event) => {
    if (!fromPage(event)) return;
    log.info(`renderer ready (${Math.round(process.uptime() * 1000)} ms after start)`);
    rendererReady = true;
    setCapture(false);
    sendInit();
  });

  ipcMain.on('buddy:capture', (event, wanted) => {
    if (fromPage(event) && typeof wanted === 'boolean') setCapture(wanted);
  });

  ipcMain.on('buddy:drag', (event, phase) => {
    if (fromPage(event) && ['start', 'move', 'end', 'cancel'].includes(phase)) onDrag(phase);
  });

  ipcMain.on('buddy:menu', (event, id) => {
    if (fromPage(event) && MENU_IDS.has(id)) onMenu(id);
  });

  // Ambient life / play mode: the page asks for a trip or the right-click menu.
  ipcMain.on('buddy:fun', (event, action) => {
    if (!fromPage(event) || !FUN_ACTIONS.has(action)) return;
    if (action === 'context') popUpFunMenu();
    else if (action === 'whip-off') whipOn = false;
    // With two screens, now and then a walk or a hop goes over to the other one.
    else if (action === 'home' || settings.ambientLife) startTrip(roam.pickTrip(action, displays().length));
  });

  // A mini finished its exit scene: forget the agent (the window may shrink).
  // A trip: one step per frame the page draws.
  ipcMain.on('buddy:trip-frame', (event) => {
    if (fromPage(event) && trip) stepTrip();
  });

  // Switching sides: the page is hidden now (see flipSides).
  ipcMain.on('buddy:flip-ready', (event) => {
    if (!fromPage(event)) return;
    if (warping) finishWarp();
    else finishFlip();
  });

  // The chat panel (app/chat.js): open / close, typing on / off, a question (its intent only).
  ipcMain.on('buddy:chat', (event, msg) => {
    if (!fromPage(event)) return;
    const req = chat.parseChatRequest(msg);
    if (req) onChat(req);
  });

  // A helper flew out of the window to roam the screen (crew "roam"): give it a window of its own.
  ipcMain.on('buddy:outing', (event, msg) => {
    if (!fromPage(event)) return;
    const req = outingsLib.parseOuting(msg);
    if (req) startOuting(req);
  });

  // The crew calls one back (its agent finished, ambient life off, resting...).
  ipcMain.on('buddy:outing-end', (event, id) => {
    if (!fromPage(event) || typeof id !== 'string' || !AGENT_ID_RE.test(id)) return;
    const o = outings.get(id);
    if (o) outingHome(o);
    else outingBack(id);
  });

  ipcMain.on('buddy:crew-left', (event, id) => {
    if (fromPage(event) && typeof id === 'string' && AGENT_ID_RE.test(id)) core.crew.release(id);
  });

  if (initialEvent) dispatch(initialEvent, 'launch');

  app
    .whenReady()
    .then(onReady)
    .catch((err) => {
      log.error(`startup failed: ${err && err.stack}`);
      app.exit(1);
    });

  // ------------------------------------------------------------------ startup

  async function onReady() {
    lockDownSession();
    registerProtocol();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    reloadCharacters();

    const port = effectivePort(settings);
    try {
      server = await startServer({
        port,
        onEvent: (evt) => dispatch(evt, 'http'),
        getHealth: () => ({
          version: app.getVersion(),
          state: core.state,
          sessions: core.sessionCount,
          mouse: capturing ? 'captured' : 'passthrough',
          flight: flight.airborne ? 'hover' : 'ground',
          trip: trip ? trip.plan.kind : roamAnchor ? 'away' : 'home',
        }),
      });
    } catch (err) {
      const message =
        err && err.code === 'EADDRINUSE'
          ? `Port ${port} on 127.0.0.1 is already in use by another program.\n\n` +
            'Agent Buddy does not switch ports automatically. Close the other program, ' +
            `or set a different "port" in:\n${settingsPath()}\n\nThe hook script reads the same setting.`
          : `Could not start the local server on 127.0.0.1:${port}: ${err && err.message}`;
      log.error(message.replace(/\n+/g, ' '));
      dialog.showErrorBox('Agent Buddy', message);
      app.exit(1);
      return;
    }
    log.info(`listening on 127.0.0.1:${port}`);

    createWindow();
    createTray();
    for (const name of ['display-metrics-changed', 'display-added', 'display-removed']) {
      screen.on(name, () => placeWindow());
    }
    for (const [name, value] of [
      ['lock-screen', true],
      ['unlock-screen', false],
      ['suspend', true],
      ['resume', false],
    ]) {
      powerMonitor.on(name, () => setPaused(value));
    }
  }

  /** No network, no permissions, no spellchecker downloads. */
  function lockDownSession() {
    const ses = session.defaultSession;
    ses.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
      (_details, callback) => {
        log.warn('blocked a network request from the renderer');
        callback({ cancel: true });
      },
    );
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    if (typeof ses.setSpellCheckerEnabled === 'function') ses.setSpellCheckerEnabled(false);
  }

  /** Serves buddy://local/renderer/* and buddy://local/characters/<id>/*. */
  function registerProtocol() {
    protocol.handle(SCHEME, async (request) => {
      const file = resolveAsset(request.url);
      if (!file) return new Response('Not found', { status: 404 });
      try {
        const data = await fs.promises.readFile(file);
        const ext = path.extname(file).toLowerCase();
        const headers = {
          'Content-Type': MIME[ext],
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        };
        if (ext === '.html') headers['Content-Security-Policy'] = CSP;
        return new Response(data, { headers });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }

  function resolveAsset(url) {
    let parts;
    try {
      const parsed = new URL(url);
      if (parsed.host !== 'local') return null;
      parts = decodeURIComponent(parsed.pathname).split('/').filter(Boolean);
    } catch {
      return null;
    }
    let base;
    let rest;
    if (parts[0] === 'renderer') {
      base = RENDERER_DIR;
      rest = parts.slice(1);
    } else if (parts[0] === 'characters' && characters.has(parts[1])) {
      base = characters.get(parts[1]).dir;
      rest = parts.slice(2);
    } else {
      return null;
    }
    if (!rest.length || rest.some((p) => p === '.' || p === '..' || /[\\:]/.test(p))) return null;
    const file = path.resolve(base, ...rest);
    if (!file.startsWith(path.resolve(base) + path.sep)) return null;
    if (!MIME[path.extname(file).toLowerCase()]) return null;
    return file;
  }

  function reloadCharacters() {
    const result = discoverCharacters([path.join(ROOT, 'characters'), path.join(HOME, 'characters')]);
    characters = result.characters;
    for (const error of result.errors) log.warn(`character: ${error}`);
    character =
      characters.get(settings.character) || characters.get('robot') || characters.values().next().value || null;
    if (!character) log.error('no usable character found');
  }

  // ------------------------------------------------------------------ window and geometry

  function scale() {
    return placement.scaleFor(settings.size);
  }

  function displays() {
    return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }));
  }

  function primaryDisplay() {
    const p = screen.getPrimaryDisplay();
    return { id: p.id, workArea: p.workArea };
  }

  /**
   * Recompute anchor, side and bounds from settings, the current displays and
   * the crew: the side column is as wide as the minis that fit need.
   */
  function computePlacement() {
    const resolved = placement.resolveAnchor(settings, displays(), primaryDisplay(), scale());
    // Away on a trip: stay there while that place is still on a screen.
    if (roamAnchor) {
      const display = displays().find((d) => placement.contains(d.workArea, placement.slotRect(roamAnchor, scale())));
      if (display) Object.assign(resolved, { anchor: { ...roamAnchor }, workArea: display.workArea });
      else roamAnchor = null;
    }
    // The current side stays while everything fits there (switching sides moves the window).
    const wanted = Math.max(
      placement.SIDE_WIDTH,
      chatOpen ? CHAT_WIDTH : 0,
      crew.length && pageLayout ? placement.crewWidth(Math.min(crew.length, placement.CREW.max), pageLayout.side) : 0,
    );
    const side = placement.sideWithRoom(resolved.anchor, resolved.workArea, scale(), pageLayout ? pageLayout.side : null, wanted);
    const capacity =
      character && character.mini ? placement.crewCapacity(resolved.anchor, side, resolved.workArea, scale()) : 0;
    const shown = Math.min(crew.length, capacity);
    const pet = petOn && character && character.pet ? placement.petSpots(shown, side) : null;
    const bugAt = bug ? placement.bugSpot(side, bugOffset) : null;
    const sideWidth = Math.max(
      placement.SIDE_WIDTH,
      placement.crewWidth(shown, side),
      pet ? pet.width : 0,
      bugAt ? bugAt.width : 0,
      chatOpen ? CHAT_WIDTH : 0,
    );
    const layout = placement.windowLayout(resolved.anchor, side, scale(), sideWidth);
    layout.page.crew = placement.crewGeometry(side, capacity);
    layout.page.pet = pet;
    layout.page.bug = bugAt;
    return { anchor: resolved.anchor, ...layout };
  }

  function createWindow() {
    const initial = computePlacement();
    anchor = initial.anchor;
    pageLayout = initial.page;
    flight = flightAt(anchor);

    win = new BrowserWindow({
      ...initial.bounds,
      show: false,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Tool window on Windows: also keeps it out of Alt+Tab.
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      backgroundColor: '#00000000',
      title: 'Agent Buddy',
      icon: path.join(ASSETS_DIR, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Sounds (when switched on) are made in the page; they follow a click,
        // the duel or a play, often a moment after the last user gesture.
        ...(FEATURES.sound ? { autoplayPolicy: 'no-user-gesture-required' } : {}),
        webgl: false,
        devTools: isDev,
        navigateOnDragDrop: false,
      },
    });

    setCapture(false, true);
    win.webContents.on('did-finish-load', () => applyZoom(true));
    win.webContents.on('render-process-gone', (_event, details) => {
      rendererReady = false;
      endAllOutings();
      setCapture(false);
      stopTyping();
      chatOpen = false;
      log.error(`renderer exited (${details.reason})`);
      if (!quitting && win && rendererRestarts++ < 3) {
        setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000);
      }
    });
    if (isDev) {
      win.webContents.on('console-message', (event) => log.devOnly(`renderer: ${event.message}`));
    }
    win.once('ready-to-show', () => {
      log.info(`window shown (${Math.round(process.uptime() * 1000)} ms after start)`);
      if (win) win.showInactive();
    });
    // The user clicked somewhere else while typing a question: the keyboard is theirs again.
    win.on('blur', () => {
      if (!chatTyping) return;
      stopTyping();
      if (canSend()) win.webContents.send('buddy:chat', { typing: false });
    });
    win.on('closed', () => {
      endAllOutings();
      win = null;
      rendererReady = false;
      stopWatchdog();
    });
    // At fractional display scales Windows creates the window a few pixels off
    // (e.g. 358 x 342 instead of 355 x 338 at 125 %); the first resize would then
    // shift the character by those pixels. Set the exact bounds once more.
    win.setBounds(initial.bounds);
    // Above other always-on-top windows and full-screen apps too, not only normal ones.
    win.setAlwaysOnTop(true, TOP_LEVEL);
    // Windows drops a no-focus window's topmost place now and then (another app comes to the
    // front): take it back every few seconds, the buddy and any helper out roaming.
    const keepOnTop = setInterval(() => {
      for (const w of [win, ...[...outings.values()].map((o) => o.hw)]) {
        if (w && !w.isDestroyed() && w.isVisible()) {
          w.setAlwaysOnTop(true, TOP_LEVEL);
          w.moveTop();
        }
      }
    }, 3000);
    win.on('closed', () => clearInterval(keepOnTop));
    win.loadURL(`${ORIGIN}/renderer/index.html`);
  }

  function placeWindow() {
    if (!win || win.isDestroyed() || drag || trip || flipping || warping) return;
    const next = computePlacement();
    // The menu column changes sides: the window moves under the character, and the
    // page redraws its new layout a frame or two later. Hide the page for that
    // moment instead of letting the character jump (see flipSides).
    if (pageLayout && next.page.side !== pageLayout.side && canSend()) {
      flipSides();
      return;
    }
    applyPlacement(next);
  }

  /** In the middle of switching sides: { timer }. */
  let flipping = null;

  function flipSides() {
    log.devOnly('layout: switching sides');
    flipping = { timer: setTimeout(finishFlip, FLIP_WAIT_MS) };
    win.webContents.send('buddy:flip', 'hide');
  }

  /** The page is hidden (or did not answer in time): move the window, then show it again. */
  function finishFlip() {
    if (!flipping) return;
    clearTimeout(flipping.timer);
    flipping = null;
    if (!win || win.isDestroyed()) return;
    applyPlacement(computePlacement());
    if (canSend()) win.webContents.send('buddy:flip', 'show');
  }

  function applyPlacement(next) {
    anchor = next.anchor;
    pageLayout = next.page;
    const before = win.getBounds();
    // Nothing to do when nothing changed (settings changes call this too).
    if (!sameBounds(before, next.bounds)) {
      const ms = timed(() => win.setBounds(next.bounds));
      if (PERF) log.devOnly(`[perf] setBounds ${box(before)} -> ${box(next.bounds)}: ${ms.toFixed(1)} ms`);
    }
    applyZoom();
    sendLayout();
    updateFlight(flightAt(anchor));
  }

  /** Flight state for the character's feet at `point` (screen DIP). */
  function flightAt(point, boost = false, tilt = 0) {
    const altitude = placement.altitudeOf(point, displays(), primaryDisplay());
    const airborne = placement.isAirborne(altitude, scale(), settings.hoverMode);
    return { airborne, boost: airborne && boost, tilt: airborne ? Math.round(tilt * 100) / 100 : 0 };
  }

  /** Send the flight state when it changed noticeably (tilt changes are throttled). */
  function updateFlight(next) {
    const same =
      next.airborne === flight.airborne && next.boost === flight.boost && Math.abs(next.tilt - flight.tilt) < 0.08;
    if (same && !(next.tilt === 0 && flight.tilt !== 0)) return;
    if (next.airborne !== flight.airborne) log.devOnly(`flight: ${next.airborne ? 'hover' : 'ground'}`);
    flight = next;
    if (canSend()) win.webContents.send('buddy:flight', flight);
  }

  let zoomApplied = null;
  function applyZoom(force = false) {
    if (!win || win.isDestroyed()) return;
    if (!force && zoomApplied === scale()) return;
    zoomApplied = scale();
    win.webContents.setZoomFactor(zoomApplied);
  }

  // ------------------------------------------------------------------ mouse: capture, watchdog, drag

  /**
   * capture = true: the window receives mouse input (pointer is on the
   * character or its menu). false: input passes through to the windows below;
   * mouse moves are still forwarded so the page can do hit testing.
   */
  function setCapture(wanted, force = false) {
    if (!win || win.isDestroyed()) return;
    if (wanted === capturing && !force) return;
    capturing = wanted;
    win.setIgnoreMouseEvents(!wanted, { forward: true });
    if (wanted) startWatchdog();
    else stopWatchdog();
  }

  /** Safety net: never hold the mouse while the cursor is outside the window. */
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (!win || win.isDestroyed() || drag) return;
      const cursor = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const inside = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
      if (!inside) {
        setCapture(false);
        if (canSend()) win.webContents.send('buddy:released');
      }
    }, WATCHDOG_MS);
  }

  function stopWatchdog() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
  }

  function onDrag(phase) {
    if (!win || win.isDestroyed()) return;
    if (phase === 'start') {
      if (trip) endTrip(true); // picked up mid-trip
      const cursor = screen.getCursorScreenPoint();
      drag = {
        cursor,
        anchor: { ...anchor },
        side: pageLayout.side,
        live: { ...anchor },
        lastX: cursor.x,
        tilt: 0,
        settle: null,
        stats: moveStats(),
        // Recent cursor positions: how fast it was thrown (fling.velocityFrom).
        samples: [{ t: Date.now(), x: cursor.x, y: cursor.y }],
      };
      log.devOnly(`drag start: cursor ${drag.cursor.x},${drag.cursor.y} anchor ${anchor.x},${anchor.y}`);
      updateFlight(flightAt(drag.live, true));
      return;
    }
    if (!drag) return;
    if (phase === 'move') {
      const cursor = screen.getCursorScreenPoint();
      drag.samples.push({ t: Date.now(), x: cursor.x, y: cursor.y });
      if (drag.samples.length > 12) drag.samples.shift();
      drag.live = { x: drag.anchor.x + cursor.x - drag.cursor.x, y: drag.anchor.y + cursor.y - drag.cursor.y };
      const ms = timed(() => win.setBounds(placement.windowLayout(drag.live, drag.side, scale(), pageLayout.sideWidth).bounds));
      if (PERF) drag.stats.add(ms);
      // Flames lean against the direction of travel; smoothed, and settle when the cursor rests.
      const speed = Math.max(-1, Math.min(1, (cursor.x - drag.lastX) / TILT_SPEED));
      drag.lastX = cursor.x;
      drag.tilt = drag.tilt * 0.6 + speed * 0.4;
      updateFlight(flightAt(drag.live, true, drag.tilt));
      clearTimeout(drag.settle);
      const current = drag;
      drag.settle = setTimeout(() => {
        if (drag !== current) return;
        drag.tilt = 0;
        updateFlight(flightAt(drag.live, true, 0));
      }, TILT_SETTLE_MS);
      return;
    }
    const end = screen.getCursorScreenPoint();
    const now = Date.now();
    // Where the cursor is now, not where the last move left it: no jump on release.
    const dropped = { x: drag.anchor.x + end.x - drag.cursor.x, y: drag.anchor.y + end.y - drag.cursor.y };
    drag.samples.push({ t: now, x: end.x, y: end.y });
    const velocity = fling.velocityFrom(drag.samples, now);
    const side = drag.side;
    log.devOnly(`drag ${phase}: cursor ${end.x},${end.y} anchor ${dropped.x},${dropped.y} speed ${Math.hypot(velocity.vx, velocity.vy).toFixed(2)}`);
    clearTimeout(drag.settle);
    if (PERF) log.devOnly(`[perf] drag: setBounds ${drag.stats.summary()}`);
    drag = null;
    if (phase === 'cancel') {
      placeWindow();
      return;
    }
    roamAnchor = null; // where the user puts it is its new home
    anchor = dropped;
    // Thrown: it glides on and slows down. Dropped: it eases into place (inside the
    // screen, onto a corner nearby, onto the ground just below); never a jump.
    const plan = fling.planFling({
      from: dropped,
      velocity,
      workArea: placement.nearestDisplay(dropped, displays()).workArea,
      scale: scale(),
      settle: (point) => placement.settleAnchor(point, displays(), primaryDisplay(), scale()),
    });
    if (plan) {
      startFling(plan, side);
      return;
    }
    saveDrop(dropped);
  }

  /** Where it came to rest after a drag or a throw is its new home. */
  function saveDrop(point) {
    const patch = placement.dropPlacement(point, displays(), primaryDisplay(), scale());
    log.info(patch.position ? 'dropped at a free position' : `snapped to ${patch.corner}`);
    roamAnchor = null;
    updateSettings(patch, placeWindow);
  }

  /** The glide after a throw (or the short settle after a drop): stepped like a trip. */
  function startFling(plan, side) {
    log.devOnly(`fling: ${plan.thrown ? 'thrown' : 'settle'}, ${plan.ms} ms to ${plan.to.x},${plan.to.y}`);
    setCapture(false);
    if (canSend()) win.webContents.send('buddy:released');
    trip = {
      plan,
      start: Date.now(),
      side,
      lastStep: Date.now(),
      timer: setInterval(() => trip && Date.now() - trip.lastStep >= TRIP_FALLBACK_MS && stepTrip(), TRIP_FALLBACK_MS),
      stats: moveStats(),
    };
    // The page: hands off the mouse while the window moves; a throw flies (or tumbles).
    const mode = !plan.thrown ? 'settle' : settings.hoverMode === 'stand' ? 'toss' : 'fly';
    if (canSend()) win.webContents.send('buddy:move', { mode, face: plan.face, kind: 'fling' });
  }

  // ------------------------------------------------------------------ trips (fun mode)

  function homeAnchor() {
    return placement.resolveAnchor(settings, displays(), primaryDisplay(), scale()).anchor;
  }

  /**
   * A trip (roam.js). One that is for another screen (inspect with the cursor
   * over there, home from over there, 'screen') goes in two legs: to the edge
   * that faces it, a fade, and on from the facing edge of the other screen.
   */
  function startTrip(kind, { stayHere = false } = {}) {
    if (!win || win.isDestroyed() || drag || trip || warping || paused || !anchor || !pageLayout) return;
    const all = displays();
    const here = placement.nearestDisplay(anchor, all);
    const cursor = screen.getCursorScreenPoint();
    const home = homeAnchor();
    const b = win.getBounds();
    // The whole window (helpers, the cat) must stay on the screen, not only the slot.
    const spans = { spanLeft: anchor.x - b.x, spanRight: b.x + b.width - anchor.x };
    // The second leg stays on the screen it came to (no ping-pong after a cursor that moved on).
    const target = stayHere ? here : roam.tripDisplay({ kind, here, displays: all, cursor, home });
    if (!target) return; // 'screen' with only one screen
    if (target.id !== here.id) {
      const way = roam.planCrossing({ from: anchor, fromArea: here.workArea, toArea: target.workArea, scale: scale(), hoverMode: settings.hoverMode, ...spans });
      if (!way) return;
      // Over there it goes on as it would on that screen ('screen': a flight somewhere).
      const onward = kind === 'screen' ? 'hop' : kind;
      const goOn = () => warpTo(way.entry, () => startTrip(onward, { stayHere: true }));
      const leg = roam.planTrip({ kind: 'goto', to: way.exit, from: anchor, home, workArea: here.workArea, cursor, scale: scale(), hoverMode: settings.hoverMode, ...spans });
      log.devOnly(`trip: ${kind} to another screen`);
      if (leg) beginTrip(leg, kind, goOn);
      else goOn();
      return;
    }
    const plan = roam.planTrip({
      kind,
      from: anchor,
      home,
      workArea: here.workArea,
      cursor,
      scale: scale(),
      hoverMode: settings.hoverMode,
      ...spans,
    });
    if (plan) beginTrip(plan, kind);
  }

  /** then: what comes after arriving (the second leg of a trip to another screen). */
  function beginTrip(plan, kind, then = null) {
    log.devOnly(`trip: ${plan.kind} by ${plan.mode}, ${plan.ms} ms`);
    // Never hold the mouse while the window moves under a cursor that does not.
    setCapture(false);
    if (canSend()) win.webContents.send('buddy:released');
    trip = {
      plan,
      start: Date.now(),
      side: pageLayout.side,
      lastStep: Date.now(),
      timer: setInterval(() => trip && Date.now() - trip.lastStep >= TRIP_FALLBACK_MS && stepTrip(), TRIP_FALLBACK_MS),
      stats: moveStats(),
      then,
    };
    if (canSend()) win.webContents.send('buddy:move', { mode: plan.mode, face: plan.face, kind });
    if (plan.mode === 'fly') {
      flight = { airborne: true, boost: true, tilt: plan.face === 'left' ? -0.6 : 0.6 };
      if (canSend()) win.webContents.send('buddy:flight', flight);
    }
  }

  function stepTrip() {
    if (!trip || !win || win.isDestroyed()) return;
    const now = Date.now();
    const t = now - trip.start;
    trip.lastStep = now;
    const isFling = trip.plan.kind === 'fling';
    anchor = isFling ? fling.positionAt(trip.plan, t) : roam.positionAt(trip.plan, t);
    // A throw: the flames lean against the way it flies, and it lands where it stops.
    if (isFling) {
      const lean = trip.plan.thrown && t < trip.plan.ms ? fling.speedAt(trip.plan, t) / (TILT_SPEED / 16) : 0;
      // (Same sign as while dragging: positive when it moves to the right.)
      updateFlight(flightAt(anchor, trip.plan.thrown && t < trip.plan.ms, Math.max(-1, Math.min(1, lean))));
    }
    // setBounds with the size, not setPosition: at fractional display scales
    // setPosition grows the window by about a pixel per call on Windows, which
    // shifted the character along the way and made it jump back on arrival.
    const bounds = placement.windowLayout(anchor, trip.side, scale(), pageLayout.sideWidth).bounds;
    const ms = timed(() => win.setBounds(bounds));
    if (PERF) trip.stats.add(ms);
    if (t >= trip.plan.ms) endTrip(false);
  }

  /** Arrived (or picked up on the way, cancelled = true). */
  function endTrip(cancelled) {
    if (!trip) return;
    clearInterval(trip.timer);
    if (PERF) log.devOnly(`[perf] trip ${trip.plan.kind}: setBounds ${trip.stats.summary()}`);
    const { plan, then } = trip;
    trip = null;
    const home = homeAnchor();
    roamAnchor = Math.hypot(anchor.x - home.x, anchor.y - home.y) < 3 ? null : { ...anchor };
    const cursor = screen.getCursorScreenPoint();
    // Fled after being hit, or thrown: that place is its new home (saved, like a drag).
    const moved = (plan.kind === 'flee' || plan.kind === 'fling') && !cancelled;
    if (moved) roamAnchor = null;
    if (canSend()) {
      win.webContents.send('buddy:move', {
        mode: null,
        kind: plan.kind,
        arrived: !cancelled,
        look: cursor.x < anchor.x ? 'left' : 'right',
      });
    }
    if (moved && plan.kind === 'fling') {
      saveDrop(anchor);
    } else if (moved) {
      const patch = placement.dropPlacement(anchor, displays(), primaryDisplay(), scale());
      log.info('moved after being hit: new place saved');
      updateSettings(patch, placeWindow);
    } else if (!cancelled && then) {
      then(); // at the edge: on to the other screen
      return;
    } else if (!cancelled) {
      placeWindow();
    }
    if (demo === 'trips' && demoIndex >= 0) setTimeout(() => nextDemoTrip(demoIndex + 1), 4500);
  }

  /**
   * To another screen: the page fades out, the window jumps to `point` (an
   * anchor on the other screen), the page fades in there, then `then`. Work
   * that comes in meanwhile keeps it where it lands (no second leg).
   */
  function warpTo(point, then) {
    if (!win || win.isDestroyed() || !canSend()) return;
    warping = { point, then, timer: setTimeout(finishWarp, WARP_WAIT_MS) };
    win.webContents.send('buddy:flip', 'warp');
  }

  function finishWarp() {
    if (!warping) return;
    const { point, then, timer } = warping;
    clearTimeout(timer);
    warping = null;
    if (!win || win.isDestroyed()) return;
    roamAnchor = { ...point };
    applyPlacement(computePlacement());
    log.devOnly('trip: now on the other screen');
    if (canSend()) win.webContents.send('buddy:flip', 'show');
    setTimeout(() => {
      if (!warping && !trip && !drag && !paused && CALM_STATES.has(core.state)) then();
      else placeWindow();
    }, WARP_IN_MS);
  }


  // ------------------------------------------------------------------ helpers out roaming

  /**
   * Helpers roaming the screen (outings.js): a mini flies out of the buddy's
   * window, gets a little click-through window of its own (renderer/helper.html)
   * and flies, walks and peeks round the screen(s) for a few legs, more
   * scattered than the buddy; then it flies back over its spot, fades and the
   * page drops it in again ('buddy:outing-back'). id -> outing.
   */
  const outings = new Map();

  /** The page's mini may come back (refused, or the roam is over). */
  function outingBack(id) {
    if (canSend()) win.webContents.send('buddy:outing-back', id);
  }

  function startOuting(req) {
    const payload = characterPayload();
    const mini = payload && payload.mini;
    if (!win || win.isDestroyed() || quitting || paused || !settings.ambientLife || !mini || outings.has(req.id) || outings.size >= outingsLib.OUTING.max) {
      outingBack(req.id);
      return;
    }
    const feet = outingsLib.toScreen({ x: req.x, y: req.y }, win.getBounds(), scale());
    const hw = new BrowserWindow({
      ...placement.helperWindow(feet, scale()).bounds,
      show: false,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
      backgroundColor: '#00000000',
      title: 'Agent Buddy helper',
      webPreferences: {
        preload: path.join(__dirname, 'helper-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        webgl: false,
        devTools: false,
        navigateOnDragDrop: false,
      },
    });
    hw.setIgnoreMouseEvents(true);
    hw.setAlwaysOnTop(true, TOP_LEVEL);
    const o = { id: req.id, off: req.off, hw, feet, face: 'right', legs: outingsLib.pickLegs(), timer: null, step: null, ending: false };
    o.limit = setTimeout(() => outingHome(o), outingsLib.OUTING.maxMs);
    outings.set(req.id, o);
    log.devOnly(`outing: ${req.id.slice(0, 4)} out for ${o.legs} legs`);
    hw.on('closed', () => {
      o.hw = null;
    });
    hw.webContents.once('did-finish-load', () => {
      if (!o.hw || o.ending) return;
      o.hw.webContents.setZoomFactor(scale());
      o.hw.webContents.send('helper:init', { mini: { svgUrl: mini.svgUrl, cssUrl: mini.cssUrl }, tint: req.tint });
      o.hw.showInactive();
      o.timer = setTimeout(() => outingLeg(o), 350);
    });
    hw.loadURL(`${ORIGIN}/renderer/helper.html`);
  }

  /** Where a helper may be on its screen: the work area, less what its window reaches below its feet. */
  function outingArea(display, geo) {
    return { ...display.workArea, height: display.workArea.height - geo.below };
  }

  function outingLeg(o) {
    if (!o.hw || o.ending) return;
    if (o.legs <= 0) {
      outingHome(o);
      return;
    }
    o.legs -= 1;
    const all = displays();
    const here = placement.nearestDisplay(o.feet, all);
    const cursor = screen.getCursorScreenPoint();
    const cursorHere = placement.nearestDisplay(cursor, all).id === here.id;
    const geo = placement.helperWindow(o.feet, scale());
    const spans = { spanLeft: geo.spanLeft, spanRight: geo.spanRight };
    let kind = roam.pickOutingLeg({ displayCount: all.length, cursorHere });
    if (kind === 'screen') {
      const target = roam.tripDisplay({ kind, here, displays: all });
      const way =
        target &&
        roam.planCrossing({ from: o.feet, fromArea: outingArea(here, geo), toArea: outingArea(target, geo), scale: scale(), hoverMode: settings.hoverMode, ...spans });
      if (way) {
        const go = () => outingWarp(o, way.entry, () => outingLeg(o));
        const leg = roam.planTrip({ kind: 'goto', to: way.exit, from: o.feet, workArea: outingArea(here, geo), cursor, scale: scale(), hoverMode: settings.hoverMode, ...spans });
        if (leg) outingMove(o, leg, go);
        else go();
        return;
      }
      kind = 'flee';
    }
    const plan = roam.planTrip({ kind, from: o.feet, home: o.feet, workArea: outingArea(here, geo), cursor, scale: scale(), hoverMode: settings.hoverMode, ...spans });
    if (plan) outingMove(o, plan, () => outingPause(o));
    else outingPause(o);
  }

  /** Along a planned leg (roam.positionAt), one step per ~16 ms. */
  function outingMove(o, plan, then) {
    clearInterval(o.step);
    o.face = plan.face;
    if (o.hw) o.hw.webContents.send('helper:pose', { move: plan.mode, face: plan.face });
    const start = Date.now();
    o.step = setInterval(() => {
      if (!o.hw) {
        clearInterval(o.step);
        return;
      }
      const t = Date.now() - start;
      o.feet = roam.positionAt(plan, t);
      o.hw.setBounds(placement.helperWindow(o.feet, scale()).bounds);
      if (t >= plan.ms) {
        clearInterval(o.step);
        o.step = null;
        then();
      }
    }, 16);
  }

  /** A look round, or a little show, before the next leg. */
  function outingPause(o) {
    if (!o.hw || o.ending) return;
    const p = outingsLib.pickPause();
    o.hw.webContents.send('helper:pose', { move: null, face: o.face, pose: p.pose, play: p.play });
    o.timer = setTimeout(() => outingLeg(o), p.ms);
  }

  /** To another screen: fade out, jump to `entry` (feet, screen DIP), fade in, then. */
  function outingWarp(o, entry, then) {
    if (!o.hw) return;
    o.hw.webContents.send('helper:fade', 'out');
    o.timer = setTimeout(() => {
      if (!o.hw) return;
      o.feet = { ...entry };
      o.hw.setBounds(placement.helperWindow(o.feet, scale()).bounds);
      o.hw.webContents.send('helper:fade', 'in');
      o.timer = setTimeout(then, outingsLib.OUTING.fadeMs + 40);
    }, outingsLib.OUTING.fadeMs + 20);
  }

  /** Back to the buddy: over its spot, fade, gone; the page drops the mini in. */
  function outingHome(o) {
    if (o.ending) return;
    o.ending = true;
    clearTimeout(o.timer);
    clearTimeout(o.limit);
    clearInterval(o.step);
    if (!o.hw || !win || win.isDestroyed() || !pageLayout) {
      endOuting(o);
      return;
    }
    const all = displays();
    const target = outingsLib.returnPoint(win.getBounds(), pageLayout.side, o.off, scale());
    const fadeAndEnd = () => {
      if (o.hw) o.hw.webContents.send('helper:fade', 'out');
      o.timer = setTimeout(() => endOuting(o), outingsLib.OUTING.fadeMs + 20);
    };
    // Not on the buddy's screen: it just fades where it is.
    if (placement.nearestDisplay(target, all).id !== placement.nearestDisplay(o.feet, all).id) {
      fadeAndEnd();
      return;
    }
    const geo = placement.helperWindow(o.feet, scale());
    const area = outingArea(placement.nearestDisplay(o.feet, all), geo);
    const plan = roam.planTrip({ kind: 'goto', to: target, from: o.feet, workArea: area, scale: scale(), hoverMode: settings.hoverMode, spanLeft: geo.spanLeft, spanRight: geo.spanRight });
    if (plan) outingMove(o, plan, fadeAndEnd);
    else fadeAndEnd();
  }

  function endOuting(o) {
    clearTimeout(o.timer);
    clearTimeout(o.limit);
    clearInterval(o.step);
    o.ending = true;
    outings.delete(o.id);
    if (o.hw && !o.hw.isDestroyed()) o.hw.destroy();
    o.hw = null;
    log.devOnly(`outing: ${o.id.slice(0, 4)} back`);
    outingBack(o.id);
  }

  /** Screen locked, quitting: everyone home at once, no flight. */
  function endAllOutings() {
    for (const o of [...outings.values()]) endOuting(o);
  }

  /** The right-click menu: play (duel, whip), walk, fly, home, the cat, the three switches. */
  function popUpFunMenu() {
    const template = buildFunMenuTemplate({
      settings,
      away: Boolean(roamAnchor),
      whip: whipOn,
      catHere: petOn,
      pet: hasPet(),
      on: {
        ...actions,
        duel: () => playDuel(),
        trip: (kind) => startTrip(kind),
        setWhip: (value) => {
          whipOn = value;
          if (canSend()) win.webContents.send('buddy:fun', { action: 'whip', on: value });
        },
        cat: (on) => (on ? callCat() : setPet(false)),
      },
    });
    popUpAtCursor(Menu.buildFromTemplate(template));
  }

  function startDuel() {
    if (settings.playMode && canSend()) win.webContents.send('buddy:fun', { action: 'duel' });
  }

  /** Play (hover or right-click menu): turns play mode on if needed, then the duel starts. */
  function playDuel() {
    const patch = switchFor('play', settings);
    if (patch) updateSettings(patch, startDuel);
    else startDuel();
  }

  /** Call the cat (hover or right-click menu): turns the Cat switch on if needed. */
  function callCat() {
    if (!hasPet()) return;
    const patch = switchFor('cat', settings);
    if (patch) updateSettings(patch, () => setPet(true));
    else setPet(true);
  }

  const hasPet = () => Boolean(character && character.pet);

  /**
   * The cat comes (the window makes room first) or goes (the page plays its
   * exit, then the window shrinks back).
   */
  function setPet(on, force = false) {
    const want = Boolean(on && (settings.cat || force) && character && character.pet);
    if (want === petOn) return;
    clearTimeout(petTimer);
    petOn = want;
    log.devOnly(`cat: ${want ? 'called' : 'sent away'}`);
    if (want) placeWindow();
    if (canSend()) win.webContents.send('buddy:pet', { on: want });
    if (!want) petTimer = setTimeout(placeWindow, PET_EXIT_MS);
    sendSettings();
  }

  /** The simulator (scripts/simulate.js "life") asks for one behaviour. */
  function onDemo(name) {
    const trips = { walk: 'stroll', fly: 'hop', inspect: 'inspect', home: 'home', screen: 'screen' };
    if (trips[name]) startTrip(trips[name]);
    else if (name === 'fling') demoFling();
    else if (name === 'cat') setPet(true, true); // the simulator shows it even with the setting off
    else if (name === 'cat-away') setPet(false);
    else if (name === 'chat') demoChat();
    else if (canSend()) win.webContents.send('buddy:fun', { action: 'demo', name });
  }

  /** The simulator: a throw towards the middle of the screen and up, as if the user flung it. */
  function demoFling() {
    if (!win || win.isDestroyed() || drag || trip || !anchor) return;
    const workArea = placement.nearestDisplay(anchor, displays()).workArea;
    const towards = anchor.x > workArea.x + workArea.width / 2 ? -1 : 1;
    const plan = fling.planFling({
      from: { ...anchor },
      velocity: { vx: towards * 2.2, vy: -1.1 },
      workArea,
      scale: scale(),
      settle: (point) => placement.settleAnchor(point, displays(), primaryDisplay(), scale()),
    });
    if (plan) startFling(plan, pageLayout.side);
  }

  /** The simulator: the panel opens, two questions are asked and answered, it closes. */
  function demoChat() {
    setChat(true, { hold: true });
    const steps = [
      [1200, () => onChat({ op: 'ask', intent: 'doing' })],
      [6200, () => onChat({ op: 'ask', intent: 'tools' })],
      [11200, () => setChat(false)],
    ];
    for (const [ms, fn] of steps) setTimeout(() => !quitting && chatOpen && fn(), ms);
  }

  // ------------------------------------------------------------------ chat panel

  function onChat(req) {
    switch (req.op) {
      case 'open':
        setChat(true);
        break;
      case 'close':
        setChat(false);
        break;
      case 'type':
        startTyping();
        break;
      case 'untype':
        stopTyping();
        break;
      case 'ask': {
        if (!chatOpen || !canSend()) return;
        // Built from what the overlay already knows; only the intent is logged.
        const text = chat.answer(req.intent, core.facts(Date.now()), settings.language);
        log.devOnly(`chat: ${req.intent}`);
        win.webContents.send('buddy:chat', { answer: text, intent: req.intent });
        break;
      }
      default:
        break;
    }
  }

  /** Open or close the panel: the side column widens first, then the page shows it. */
  function setChat(open, { hold = false } = {}) {
    if (open === chatOpen || !win || win.isDestroyed()) return;
    chatOpen = open;
    log.devOnly(`chat: ${open ? 'open' : 'closed'}`);
    if (!open) stopTyping();
    placeWindow();
    sendChat(hold);
    if (canSend()) win.webContents.send('buddy:menu-items', menuItems());
  }

  function sendChat(hold = false) {
    if (canSend()) win.webContents.send('buddy:chat', { open: chatOpen, hold, strings: chat.panelStrings(settings.language) });
  }

  /** "Type…": the window may take the keyboard until the question is done. */
  function startTyping() {
    if (!chatOpen || chatTyping || !win || win.isDestroyed()) return;
    chatTyping = true;
    log.devOnly('chat: typing on (window focusable)');
    win.setFocusable(true);
    win.focus();
    win.webContents.focus();
  }

  /**
   * Typing is over: never focusable again. When the window still has the
   * keyboard (Esc, the panel closed), hand it back to the window the user came
   * from: Windows gives it to the next window down when ours lets go, and for
   * a moment ours is not "always on top", so that is the top normal window
   * (the one in use before), not the taskbar.
   */
  function stopTyping() {
    if (!chatTyping) return;
    chatTyping = false;
    if (!win || win.isDestroyed()) return;
    log.devOnly('chat: typing off (window not focusable)');
    const lift = process.platform === 'win32';
    if (lift) win.setAlwaysOnTop(false);
    win.setFocusable(false);
    if (lift) win.setAlwaysOnTop(true, TOP_LEVEL);
  }

  function setPaused(value) {
    paused = value;
    if (value) setCapture(false);
    if (value) endAllOutings();
    if (canSend()) win.webContents.send('buddy:paused', value);
  }

  // ------------------------------------------------------------------ renderer IPC

  function bubbleText(snap) {
    const message = snap.message;
    return message ? translate(settings.language, 'bubble', message.key, message.vars) : '';
  }

  function viewPayload() {
    const snap = core.snapshot();
    return {
      state: snap.state,
      cssState: character ? character.states[snap.state] || snap.state : snap.state,
      text: bubbleText(snap),
      mono: Boolean(snap.message && snap.message.mono),
      mood: snap.mood || null,
      skill: snap.skill || null,
      // Recent files read / written and commands run (the row above the bubble).
      steps: snap.steps || [],
    };
  }

  function characterPayload() {
    if (!character) return null;
    const base = `${ORIGIN}/characters/${encodeURIComponent(character.id)}`;
    return {
      id: character.id,
      name: character.name,
      svgUrl: `${base}/${encodeURIComponent(character.svg)}`,
      cssUrl: `${base}/${encodeURIComponent(character.css)}`,
      blink: character.blink,
      confetti: character.confetti,
      bubbleAnchor: character.bubbleAnchor,
      lookAnchor: character.lookAnchor,
      pet: character.pet
        ? {
            svgUrl: `${base}/${encodeURIComponent(character.pet.svg)}`,
            cssUrl: `${base}/${encodeURIComponent(character.pet.css)}`,
          }
        : null,
      mini: character.mini
        ? {
            svgUrl: `${base}/${encodeURIComponent(character.mini.svg)}`,
            cssUrl: `${base}/${encodeURIComponent(character.mini.css)}`,
            tints: character.mini.tints,
          }
        : null,
    };
  }

  function rendererSettings() {
    return {
      quiet: settings.quiet,
      eyeTracking: settings.eyeTracking,
      ambientLife: settings.ambientLife,
      playMode: settings.playMode,
      // Switched off (app/features.js): off whatever settings.json says.
      sound: FEATURES.sound && settings.sound,
      soundVolume: settings.soundVolume,
      strings: pageStrings(),
    };
  }

  function menuItems() {
    return buildMenuItems(settings, { catHere: petOn, pet: hasPet(), chatOpen, soundAvailable: FEATURES.sound });
  }

  function canSend() {
    return win && !win.isDestroyed() && rendererReady;
  }

  function sendInit() {
    if (!canSend()) return;
    win.webContents.send('buddy:init', {
      character: characterPayload(),
      settings: rendererSettings(),
      view: viewPayload(),
      layout: pageLayout,
      menu: menuItems(),
      flight,
      crew,
      pet: petOn,
      bug: bugPayload(),
      paused,
      dev: isDev,
      perf: PERF,
      demo,
    });
    if (demo === 'trips' && !trip) setTimeout(() => nextDemoTrip(0), 1500);
    if (demo === 'chat') setTimeout(demoChat, 1500);
  }

  function nextDemoTrip(index) {
    if (index >= DEMO_TRIPS.length || quitting) return;
    demoIndex = index;
    startTrip(DEMO_TRIPS[index]);
  }

  /** Text the page shows itself (badges); placeholders are filled in there. */
  function pageStrings() {
    const quips = {};
    for (const key of QUIPS) quips[key] = translate(settings.language, 'quip', key);
    return {
      helpers: translate(settings.language, 'page', 'helpers', { count: '{count}' }),
      you: translate(settings.language, 'page', 'you'),
      quips,
    };
  }

  function sendCrew() {
    if (canSend()) win.webContents.send('buddy:crew', crew);
  }

  function sendView() {
    if (canSend()) win.webContents.send('buddy:view', viewPayload());
  }

  function sendSettings() {
    if (!canSend()) return;
    win.webContents.send('buddy:settings', rendererSettings());
    win.webContents.send('buddy:menu-items', menuItems());
    if (chatOpen) sendChat(); // the language may have changed
  }

  function sendLayout() {
    if (canSend()) win.webContents.send('buddy:layout', pageLayout);
  }

  // ------------------------------------------------------------------ hover menu, tray, settings

  function onMenu(id) {
    switch (id) {
      case 'quiet':
        actions.setQuiet(!settings.quiet);
        break;
      case 'eyes':
        actions.setEyeTracking(!settings.eyeTracking);
        break;
      case 'corner':
        actions.backToCorner();
        break;
      case 'play':
        playDuel();
        break;
      case 'cat':
        if (petOn) setPet(false);
        else callCat();
        break;
      case 'chat':
        setChat(!chatOpen);
        break;
      case 'sound':
        if (FEATURES.sound) actions.setSound(!settings.sound);
        break;
      case 'settings':
        popUpSettings();
        break;
      case 'quit':
        actions.quit();
        break;
      default:
        break;
    }
  }

  /** The full settings menu (same as the tray's), shown at the cursor. */
  function popUpSettings() {
    popUpAtCursor(Menu.buildFromTemplate(trayTemplate()));
  }

  /**
   * Show a menu at the cursor. On Windows a menu owned by our window (which
   * never takes focus) does not close when the user clicks somewhere else, so
   * it goes through the tray icon, whose menus do.
   */
  function popUpAtCursor(menu) {
    setCapture(false);
    if (tray && process.platform === 'win32') tray.popUpContextMenu(menu, screen.getCursorScreenPoint());
    else menu.popup({ window: win });
  }

  function trayTemplate() {
    return buildTrayTemplate({
      settings,
      characters,
      sessionCount: core.sessionCount,
      seenAccount: (name) => core.hasSeenAccount(name),
      soundAvailable: FEATURES.sound,
      on: actions,
    });
  }

  function createTray() {
    const icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('Agent Buddy');
    if (process.platform === 'win32') tray.on('click', () => tray && tray.popUpContextMenu());
    refreshTray();
  }

  function refreshTray() {
    if (!tray) return;
    traySessionCount = core.sessionCount;
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  }

  function refreshTrayIfNeeded() {
    if (tray && core.sessionCount !== traySessionCount) refreshTray();
  }

  function updateSettings(patch, after) {
    const next = { ...settings, ...patch };
    try {
      settings = saveSettings(next);
    } catch (err) {
      settings = next; // keep working with the in-memory value
      log.error(`could not save settings: ${err.message}`);
    }
    if (after) after();
    sendSettings();
    refreshTray();
  }

  const actions = {
    setCorner: (corner) => {
      roamAnchor = null;
      updateSettings({ corner, position: null }, placeWindow);
    },
    setSize: (size) => updateSettings({ size }, placeWindow),
    setHoverMode: (hoverMode) => updateSettings({ hoverMode }, placeWindow),
    setCharacter: (id) =>
      updateSettings({ character: id }, () => {
        reloadCharacters();
        placeWindow();
        sendInit();
      }),
    setLanguage: (language) => updateSettings({ language }, sendView),
    setQuiet: (quiet) => updateSettings({ quiet }),
    setAccount: (account) =>
      updateSettings({ account }, () => {
        core.setAccountFilter(settings.account);
        if (settings.account !== 'all' && !core.hasSeenAccount(settings.account)) core.notice('noAccountEvents');
        refreshTrayIfNeeded();
      }),
    setEyeTracking: (eyeTracking) => updateSettings({ eyeTracking }),
    // Ambient life off: no more trips; if it is away, it walks (or flies) home.
    setAmbientLife: (ambientLife) =>
      updateSettings({ ambientLife }, () => {
        if (!ambientLife && roamAnchor) startTrip('home');
      }),
    // Play mode off: the whip goes too.
    setPlayMode: (playMode) =>
      updateSettings({ playMode }, () => {
        if (!playMode && whipOn) {
          whipOn = false;
          if (canSend()) win.webContents.send('buddy:fun', { action: 'whip', on: false });
        }
      }),
    setSound: (sound) => updateSettings({ sound }),
    setSoundVolume: (soundVolume) => updateSettings({ soundVolume }),
    // Cat off: if it is here, it leaves.
    setCat: (cat) =>
      updateSettings({ cat }, () => {
        if (!cat) setPet(false);
      }),
    backToCorner: () => {
      roamAnchor = null;
      updateSettings({ position: null }, placeWindow);
    },
    openSettings: () => {
      try {
        if (!fs.existsSync(settingsPath())) saveSettings(settings);
      } catch (err) {
        log.error(`could not write settings: ${err.message}`);
      }
      shell.openPath(HOME);
    },
    quit: () => {
      muteCurrentSessions();
      quitApp();
    },
  };

  /** Hooks will not relaunch the overlay for these sessions (new sessions still do). */
  function muteCurrentSessions() {
    try {
      fs.mkdirSync(HOME, { recursive: true });
      fs.writeFileSync(
        path.join(HOME, 'muted.json'),
        JSON.stringify({ sessions: core.sessionIds(), until: Date.now() + MUTE_MS }) + '\n',
        'utf8',
      );
    } catch (err) {
      log.error(`could not write muted.json: ${err.message}`);
    }
  }

  function quitApp() {
    if (quitting) return;
    quitting = true;
    if (trip) clearInterval(trip.timer);
    endAllOutings();
    stopWatchdog();
    core.dispose();
    if (server) server.close();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
  }
}

/** Run fn; with PERF, return how long it took in ms (0 otherwise). */
function timed(fn) {
  if (!PERF) {
    fn();
    return 0;
  }
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const box = (b) => (b ? `${b.width}x${b.height}@${b.x},${b.y}` : '?');
const sameBounds = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Calls per second, call times and the gaps between calls (timer jitter), for PERF. */
function moveStats() {
  const start = process.hrtime.bigint();
  let last = start;
  let calls = 0;
  let total = 0;
  let worst = 0;
  let gap = 0;
  return {
    add(ms) {
      const now = process.hrtime.bigint();
      if (calls > 0) gap = Math.max(gap, Number(now - last) / 1e6);
      last = now;
      calls += 1;
      total += ms;
      worst = Math.max(worst, ms);
    },
    summary() {
      const secs = Number(last - start) / 1e9;
      const rate = secs > 0 ? Math.round(calls / secs) : 0;
      return `${calls} calls (${rate}/s), avg ${(total / Math.max(1, calls)).toFixed(2)} ms, worst ${worst.toFixed(1)} ms, longest gap ${Math.round(gap)} ms`;
    },
  };
}

/** The hook passes the first event as --initial-event=<base64url JSON>. */
function decodeInitialEvent(argv) {
  const prefix = '--initial-event=';
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (!arg) return null;
  try {
    return JSON.parse(Buffer.from(arg.slice(prefix.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
