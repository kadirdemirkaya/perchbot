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
const { buildTrayTemplate, buildFunMenuTemplate } = require('./tray');
const { buildMenuItems, MENU_IDS } = require('./menu-items');
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
/** What the page may ask for (fun mode): a trip, or the right-click menu. */
const FUN_ACTIONS = new Set(['context', 'flee', 'stroll', 'hop', 'inspect', 'home', 'whip-off']);
/** Frame interval while the window travels. */
const TRIP_FRAME_MS = 16;
/** States that do not interrupt a trip; any other one (work) stops it at once. */
const CALM_STATES = new Set(['idle', 'standby', 'greeting']);
/** The cat's exit scene, before the window shrinks back. */
const PET_EXIT_MS = 2200;

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
 * Developers only (npm run dev): AGENT_BUDDY_DEMO=duel | trips | plays | cheers
 * plays that part of fun mode by itself, for screenshots and trying things out.
 */
const DEMOS = new Set(['duel', 'trips', 'plays', 'cheers']);
const demo = isDev && DEMOS.has(process.env.AGENT_BUDDY_DEMO) ? process.env.AGENT_BUDDY_DEMO : null;
const DEMO_TRIPS = ['stroll', 'hop', 'inspect', 'home'];
/** Short lines in the speech bubble when it is hit or fights (locales: "quip"). */
const QUIPS = ['ouch', 'hey', 'enough', 'enGarde', 'gotYou', 'parried', 'hurt', 'blocked', 'robotWins', 'youWin'];

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
  /** The trip in progress: { plan, start, side, timer } (see roam.js). */
  let trip = null;
  /** Where a trip left the character (this run only); null = at home. */
  let roamAnchor = null;
  let demoIndex = -1;
  /** The whip from the right-click menu is in the user's hand (the page shows it). */
  let whipOn = false;
  /** The cat is on screen (called from the menu; needs the "Cat" setting). */
  let petOn = false;
  let petTimer = null;

  // ------------------------------------------------------------------ events

  function dispatch(raw, source) {
    const evt = validateEvent(raw);
    if (!evt) {
      log.warn(`ignored invalid event (${source})`);
      return;
    }
    log.info(`event ${evt.event}${evt.tool ? ` tool=${evt.tool}` : ''}${evt.demo ? ` ${evt.demo}` : ''} (${source})`);
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
    if (trip && !CALM_STATES.has(snap.state)) {
      log.devOnly(`trip: stopped by ${snap.state}`);
      endTrip(true);
      placeWindow();
    }
    sendView();
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
    else if (action === 'home' || settings.ambientLife) startTrip(action);
  });

  // A mini finished its exit scene: forget the agent (the window may shrink).
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
    const side = placement.sideFor(resolved.anchor, resolved.workArea);
    const capacity =
      character && character.mini ? placement.crewCapacity(resolved.anchor, side, resolved.workArea, scale()) : 0;
    const shown = Math.min(crew.length, capacity);
    const pet = petOn && character && character.pet ? placement.petSpots(shown, side) : null;
    const sideWidth = Math.max(placement.SIDE_WIDTH, placement.crewWidth(shown, side), pet ? pet.width : 0);
    const layout = placement.windowLayout(resolved.anchor, side, scale(), sideWidth);
    layout.page.crew = placement.crewGeometry(side, capacity);
    layout.page.pet = pet;
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
        webgl: false,
        devTools: isDev,
        navigateOnDragDrop: false,
      },
    });

    setCapture(false, true);
    win.webContents.on('did-finish-load', applyZoom);
    win.webContents.on('render-process-gone', (_event, details) => {
      rendererReady = false;
      setCapture(false);
      log.error(`renderer exited (${details.reason})`);
      if (!quitting && win && rendererRestarts++ < 3) {
        setTimeout(() => win && !win.isDestroyed() && win.reload(), 1000);
      }
    });
    if (isDev) {
      win.webContents.on('console-message', (event) => log.devOnly(`renderer: ${event.message}`));
    }
    win.once('ready-to-show', () => win && win.showInactive());
    win.on('closed', () => {
      win = null;
      rendererReady = false;
      stopWatchdog();
    });
    win.loadURL(`${ORIGIN}/renderer/index.html`);
  }

  function placeWindow() {
    if (!win || win.isDestroyed() || drag || trip) return;
    const next = computePlacement();
    anchor = next.anchor;
    pageLayout = next.page;
    win.setBounds(next.bounds);
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

  function applyZoom() {
    if (win && !win.isDestroyed()) win.webContents.setZoomFactor(scale());
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
      drag = { cursor, anchor: { ...anchor }, side: pageLayout.side, live: { ...anchor }, lastX: cursor.x, tilt: 0, settle: null };
      log.devOnly(`drag start: cursor ${drag.cursor.x},${drag.cursor.y} anchor ${anchor.x},${anchor.y}`);
      updateFlight(flightAt(drag.live, true));
      return;
    }
    if (!drag) return;
    if (phase === 'move') {
      const cursor = screen.getCursorScreenPoint();
      drag.live = { x: drag.anchor.x + cursor.x - drag.cursor.x, y: drag.anchor.y + cursor.y - drag.cursor.y };
      win.setBounds(placement.windowLayout(drag.live, drag.side, scale(), pageLayout.sideWidth).bounds);
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
    const dropped = drag.live;
    const end = screen.getCursorScreenPoint();
    log.devOnly(`drag ${phase}: cursor ${end.x},${end.y} anchor ${dropped.x},${dropped.y}`);
    clearTimeout(drag.settle);
    drag = null;
    if (phase === 'cancel') {
      placeWindow();
      return;
    }
    const patch = placement.dropPlacement(dropped, displays(), primaryDisplay(), scale());
    log.info(patch.position ? 'dropped at a free position' : `snapped to ${patch.corner}`);
    roamAnchor = null; // where the user puts it is its new home
    updateSettings(patch, placeWindow);
  }

  // ------------------------------------------------------------------ trips (fun mode)

  function homeAnchor() {
    return placement.resolveAnchor(settings, displays(), primaryDisplay(), scale()).anchor;
  }

  function startTrip(kind) {
    if (!win || win.isDestroyed() || drag || trip || paused || !anchor || !pageLayout) return;
    const workArea = placement.nearestDisplay(anchor, displays()).workArea;
    const b = win.getBounds();
    const plan = roam.planTrip({
      kind,
      from: anchor,
      home: homeAnchor(),
      workArea,
      cursor: screen.getCursorScreenPoint(),
      scale: scale(),
      hoverMode: settings.hoverMode,
      // The whole window (helpers, the cat) must stay on the screen, not only the slot.
      spanLeft: anchor.x - b.x,
      spanRight: b.x + b.width - anchor.x,
    });
    if (!plan) return;
    log.devOnly(`trip: ${kind} by ${plan.mode}, ${plan.ms} ms`);
    // Never hold the mouse while the window moves under a cursor that does not.
    setCapture(false);
    if (canSend()) win.webContents.send('buddy:released');
    trip = { plan, start: Date.now(), side: pageLayout.side, timer: setInterval(stepTrip, TRIP_FRAME_MS) };
    if (canSend()) win.webContents.send('buddy:move', { mode: plan.mode, face: plan.face, kind });
    if (plan.mode === 'fly') {
      flight = { airborne: true, boost: true, tilt: plan.face === 'left' ? -0.6 : 0.6 };
      if (canSend()) win.webContents.send('buddy:flight', flight);
    }
  }

  function stepTrip() {
    if (!trip || !win || win.isDestroyed()) return;
    const t = Date.now() - trip.start;
    anchor = roam.positionAt(trip.plan, t);
    // Only the position changes on the way: cheaper (and smoother) than setBounds.
    const { x, y } = placement.windowLayout(anchor, trip.side, scale(), pageLayout.sideWidth).bounds;
    win.setPosition(x, y);
    if (t >= trip.plan.ms) endTrip(false);
  }

  /** Arrived (or picked up on the way, cancelled = true). */
  function endTrip(cancelled) {
    if (!trip) return;
    clearInterval(trip.timer);
    const { plan } = trip;
    trip = null;
    const home = homeAnchor();
    roamAnchor = Math.hypot(anchor.x - home.x, anchor.y - home.y) < 3 ? null : { ...anchor };
    const cursor = screen.getCursorScreenPoint();
    // Fled after being hit: that place is its new home (saved, like a drag).
    const moved = plan.kind === 'flee' && !cancelled;
    if (moved) roamAnchor = null;
    if (canSend()) {
      win.webContents.send('buddy:move', {
        mode: null,
        kind: plan.kind,
        arrived: !cancelled,
        look: cursor.x < anchor.x ? 'left' : 'right',
        away: Boolean(roamAnchor),
      });
    }
    if (moved) {
      const patch = placement.dropPlacement(anchor, displays(), primaryDisplay(), scale());
      log.info('moved after being hit: new place saved');
      updateSettings(patch, placeWindow);
    } else if (!cancelled) {
      placeWindow();
    }
    if (demo === 'trips' && demoIndex >= 0) setTimeout(() => nextDemoTrip(demoIndex + 1), 4500);
  }

  /** The right-click menu: play (duel, whip), walk, fly, home, the cat, the three switches. */
  function popUpFunMenu() {
    const template = buildFunMenuTemplate({
      settings,
      away: Boolean(roamAnchor),
      whip: whipOn,
      catHere: petOn,
      on: {
        ...actions,
        duel: () => startDuel(),
        trip: (kind) => startTrip(kind),
        setWhip: (value) => {
          whipOn = value;
          if (canSend()) win.webContents.send('buddy:fun', { action: 'whip', on: value });
        },
        cat: (on) => setPet(on),
      },
    });
    popUpAtCursor(Menu.buildFromTemplate(template));
  }

  function startDuel() {
    if (settings.playMode && canSend()) win.webContents.send('buddy:fun', { action: 'duel' });
  }

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
    const trips = { walk: 'stroll', fly: 'hop', inspect: 'inspect', home: 'home' };
    if (trips[name]) startTrip(trips[name]);
    else if (name === 'cat') setPet(true, true); // the simulator shows it even with the setting off
    else if (name === 'cat-away') setPet(false);
    else if (canSend()) win.webContents.send('buddy:fun', { action: 'demo', name });
  }

  function setPaused(value) {
    paused = value;
    if (value) setCapture(false);
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
      strings: pageStrings(),
    };
  }

  function menuItems() {
    return buildMenuItems(settings, { catHere: petOn });
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
      paused,
      dev: isDev,
      demo,
    });
    if (demo === 'trips' && !trip) setTimeout(() => nextDemoTrip(0), 1500);
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
        startDuel();
        break;
      case 'cat':
        setPet(!petOn);
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
