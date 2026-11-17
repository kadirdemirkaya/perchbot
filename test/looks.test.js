'use strict';

/**
 * Model looks ("Look by model" switch, on by default): the robot dresses for the
 * model its sessions run. The hook sends only the model's family (tier: haiku,
 * sonnet, opus or fable) on SessionStart and PostModelSwitch; the core keeps the
 * highest family of the live sessions; main sends it to the page (and the giant),
 * which sets data-model; robot.css recolours the robot's own parts (rb-c-*) and
 * shows a few details per family (rb-tier-*). Without it: the classic look,
 * exactly as robot.svg draws it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const send = require('../hooks/send.js');
const { validateEvent, TIERS } = require('../app/validate');
const { BuddyCore } = require('../app/core');
const { normalizeSettings, DEFAULTS } = require('../app/settings');
const { buildTrayTemplate, buildFunMenuTemplate } = require('../app/tray');
const hooks = require('../lib/hooks-config');
const cli = require('../lib/cli');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SVG = read('characters', 'robot', 'robot.svg');
const CSS = read('characters', 'robot', 'robot.css');
const SEND_JS = path.join(ROOT, 'hooks', 'send.js');
const LABEL = 'Look by model (Haiku, Sonnet, Opus, Fable)';

/** Every start tag of an SVG with its attributes. */
function svgElements(svg) {
  const out = [];
  for (const m of svg.matchAll(/<([a-zA-Z]+)\s([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ tag: m[1], attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean) });
  }
  return out;
}

function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

const tierBlock = (tier) => {
  const m = CSS.match(new RegExp(`\\.buddy-character\\[data-model='${tier}'\\] \\{([^}]*)\\}`));
  return m ? m[1] : null;
};

// ------------------------------------------------------------- the hook

test('hook: a model id becomes its family, any other id nothing', () => {
  const cases = {
    'claude-haiku-5-5': 'haiku',
    'claude-sonnet-5-5': 'sonnet',
    'claude-opus-5-5': 'opus',
    'claude-opus-5-5[1m]': 'opus',
    'claude-fable-5-2': 'fable',
    'CLAUDE-OPUS-5': 'opus',
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'sonnet',
    'claude-opus-4-1@20250805': 'opus',
    'claude-3-5-haiku-20241022': 'haiku',
  };
  for (const [id, tier] of Object.entries(cases)) assert.equal(send.modelTier(id), tier, id);
  for (const id of ['gpt-5', 'opusplan', 'my-gateway-model', 'claude-next', '', `claude-opus-${'x'.repeat(300)}`, null, undefined, 42, { id: 'opus' }]) {
    assert.equal(send.modelTier(id), undefined, String(id));
  }
});

test('hook: SessionStart and PostModelSwitch carry the family only, never the id or the costs', () => {
  const start = send.buildPayload({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup', model: 'claude-opus-5-5[1m]' }, null, 7);
  assert.deepEqual(start, { v: 1, event: 'SessionStart', session: 's', ts: 7, source: 'startup', tier: 'opus' });
  const switched = send.buildPayload(
    {
      hook_event_name: 'PostModelSwitch',
      session_id: 's',
      transcript_path: '/secret/t.jsonl',
      cwd: '/secret',
      from_model: 'claude-haiku-5-5',
      to_model: 'claude-fable-5-2',
      requested_model: 'fable',
      source: 'command',
      context_tokens: 182340,
      prompt_cache_warm: true,
      cache_ttl: '5m',
      estimated_cache_write_usd: 1.13,
      pricing: 'catalog',
    },
    null,
    8,
  );
  assert.deepEqual(switched, { v: 1, event: 'PostModelSwitch', session: 's', ts: 8, tier: 'fable' });
  // A model it has no look for: nothing to tell. SessionStart without a model (after /clear): no tier.
  assert.equal(send.buildPayload({ hook_event_name: 'PostModelSwitch', session_id: 's', to_model: 'gateway-x' }), null);
  assert.equal(send.buildPayload({ hook_event_name: 'PostModelSwitch', session_id: 's' }), null);
  assert.equal(send.buildPayload({ hook_event_name: 'SessionStart', session_id: 's', source: 'clear' }).tier, undefined);
  // Other events never carry it, whatever their input says.
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd', 'PreCompact']) {
    const p = send.buildPayload({ hook_event_name: event, session_id: 's', tool_name: 'Read', model: 'claude-opus-5-5', to_model: 'claude-opus-5-5' });
    assert.equal(p.tier, undefined, event);
  }
  // The overlay takes exactly what the hook sends.
  assert.deepEqual(validateEvent(start), start);
  assert.deepEqual(validateEvent(switched), switched);
});

test('hook: PostModelSwitch goes out as the family alone and never writes to stdout (Claude Code would hand it to the model)', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = {
      ...process.env,
      PERCHBOT_NO_LAUNCH: '1',
      PERCHBOT_NO_PID: '1',
      PERCHBOT_PORT: String(server.address().port),
      PERCHBOT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-looks-')),
    };
    delete env.CLAUDE_CONFIG_DIR;
    const input = JSON.stringify({ hook_event_name: 'PostModelSwitch', session_id: 's', from_model: 'claude-haiku-5-5', to_model: 'claude-opus-5-5', requested_model: 'opus' });
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SEND_JS, 'PostModelSwitch'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(input);
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(bodies.length, 1);
    const { ts, account, ...rest } = bodies[0];
    assert.equal(typeof ts, 'number');
    assert.deepEqual(rest, { v: 1, event: 'PostModelSwitch', session: 's', tier: 'opus' });
    assert.ok(account === undefined || typeof account === 'string');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ------------------------------------------------------------- the overlay

test('overlay: PostModelSwitch needs a known family; other events drop it', () => {
  const base = { v: 1, session: 's', ts: 1 };
  assert.deepEqual(validateEvent({ ...base, event: 'PostModelSwitch', tier: 'sonnet' }), { ...base, event: 'PostModelSwitch', tier: 'sonnet' });
  for (const tier of [undefined, 'gpt', 'Opus', 'opus ', 3, ['opus']]) {
    assert.equal(validateEvent({ ...base, event: 'PostModelSwitch', tier }), null, String(tier));
    assert.equal(validateEvent({ ...base, event: 'SessionStart', tier }).tier, undefined, String(tier));
  }
  assert.equal(validateEvent({ ...base, event: 'Stop', tier: 'opus' }).tier, undefined);
});

test('one list of families everywhere, lowest first', () => {
  assert.deepEqual([...TIERS], ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepEqual([...send.TIERS], [...TIERS]);
  const literal = "['haiku', 'sonnet', 'opus', 'fable']";
  for (const file of [['app', 'core.js'], ['app', 'renderer', 'renderer.js'], ['app', 'renderer', 'giant.js']]) {
    assert.ok(read(...file).includes(literal), file.join('/'));
  }
  for (const tier of TIERS) assert.ok(tierBlock(tier), `robot.css has a look for ${tier}`);
});

function setup(options = {}) {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, ...options });
  const looks = [];
  const states = [];
  core.on('look', (look) => looks.push(look));
  core.on('state', (snap) => states.push(snap.state));
  let ts = 1000;
  const send = (session, event, extra = {}) => {
    ts += 10;
    core.handle({ v: 1, event, session, ts, ...extra });
  };
  return { clock, core, looks, states, send };
}

test("core: the look follows the session's model; a switch changes nothing else", () => {
  const { core, looks, states, send } = setup();
  assert.equal(core.look, null, 'classic until a session tells its model');
  send('A', 'SessionStart', { source: 'startup', tier: 'haiku' });
  assert.equal(core.look, 'haiku');
  assert.equal(core.state, 'greeting');
  send('A', 'UserPromptSubmit');
  assert.equal(core.state, 'thinking');
  const before = states.length;
  send('A', 'PostModelSwitch', { tier: 'opus' });
  assert.equal(core.look, 'opus');
  assert.equal(core.state, 'thinking', 'no greeting, the view stays');
  assert.equal(states.length, before, 'no state event for a switch');
  send('A', 'PostModelSwitch', { tier: 'opus' });
  assert.deepEqual(looks, ['haiku', 'opus'], 'emitted only when it changes');
  assert.equal(core.sessionCount, 1);
});

test('core: two sessions show the higher family; with nothing known it keeps its look', () => {
  const { core, looks, send } = setup();
  send('A', 'SessionStart', { tier: 'sonnet' });
  send('B', 'SessionStart', { tier: 'fable' });
  assert.equal(core.look, 'fable');
  send('A', 'PostModelSwitch', { tier: 'opus' });
  assert.equal(core.look, 'fable', 'B still runs Fable');
  send('B', 'SessionEnd', { reason: 'other' });
  assert.equal(core.look, 'opus');
  // /clear: a new session without its model (Claude Code leaves it out): no flicker to classic.
  send('A', 'SessionEnd', { reason: 'clear' });
  assert.equal(core.look, 'opus');
  send('C', 'SessionStart', { source: 'clear' });
  assert.equal(core.look, 'opus');
  send('C', 'PostModelSwitch', { tier: 'haiku' });
  assert.equal(core.look, 'haiku');
  assert.deepEqual(looks, ['sonnet', 'fable', 'opus', 'haiku']);
});

test('core: a late switch of an ended session is ignored; other accounts do not count', () => {
  {
    const { core, send } = setup();
    send('A', 'SessionStart', { tier: 'sonnet' });
    send('A', 'SessionEnd', { reason: 'other' });
    send('A', 'PostModelSwitch', { tier: 'fable' });
    assert.equal(core.look, 'sonnet');
  }
  {
    const { core, send } = setup({ account: 'claude-work' });
    send('P', 'SessionStart', { tier: 'fable', account: 'claude-personal' });
    assert.equal(core.look, null);
    send('W', 'SessionStart', { tier: 'haiku', account: 'claude-work' });
    assert.equal(core.look, 'haiku');
  }
  {
    const { core, send } = setup();
    send('W', 'SessionStart', { tier: 'haiku', account: 'claude-work' });
    send('P', 'SessionStart', { tier: 'fable', account: 'claude-personal' });
    assert.equal(core.look, 'fable');
    core.setAccountFilter('claude-work');
    assert.equal(core.look, 'haiku', 'only the shown account counts');
  }
});

test('core: a session gone without SessionEnd takes its family with it', () => {
  const { core, send } = setup();
  send('A', 'SessionStart', { tier: 'haiku' });
  send('B', 'SessionStart', { tier: 'opus' });
  core.endSession('B', 'exited');
  assert.equal(core.look, 'haiku');
});

// ------------------------------------------------------------- the switch, main and the page

test('switch: on by default, in the tray and the right-click menu, with the words in both languages', () => {
  assert.equal(DEFAULTS.modelLook, true);
  assert.equal(normalizeSettings({}).modelLook, true);
  assert.equal(normalizeSettings({ modelLook: false }).modelLook, false);
  assert.equal(normalizeSettings({ modelLook: 'no' }).modelLook, true);
  const calls = [];
  const on = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const box = buildFunMenuTemplate({ settings: { ...DEFAULTS }, away: false, on }).find((i) => i.label === LABEL);
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, true);
  box.click({ checked: false });
  assert.deepEqual(calls, [['setModelLook', false]]);
  const tray = buildTrayTemplate({ settings: { ...DEFAULTS, modelLook: false }, characters: [], sessionCount: 0, on }).find((i) => i.label === LABEL);
  assert.equal(tray.checked, false);
  for (const lang of ['en', 'tr']) assert.ok(JSON.parse(read('app', 'locales', `${lang}.json`)).menu.modelLook, lang);
});

test('main and page: the look reaches the page and the giant; the switch off means classic', () => {
  const main = read('app', 'main.js');
  assert.ok(main.includes("core.on('look', (look) => {"));
  assert.ok(main.includes('return settings.modelLook !== false ? core.look : null;'));
  assert.ok(main.includes("if (canSend()) win.webContents.send('buddy:look', lookNow());"));
  assert.ok(main.includes('      look: lookNow(),\n'), 'in the init message (a reloaded page gets it back)');
  assert.ok(main.includes('cssUrl: payload.cssUrl }, look: lookNow() });'), "in the giant's init");
  assert.ok(main.includes('setModelLook: (modelLook) => updateSettings({ modelLook }, sendLook),'));
  assert.ok(read('app', 'preload.js').includes("onLook: on('buddy:look'),"));
  const page = read('app', 'renderer', 'renderer.js');
  assert.ok(page.includes('window.buddy.onLook((look) => applyLook(look));'));
  assert.ok(page.includes('    applyLook(data.look);\n'));
  assert.ok(page.includes("flag('model', next);"));
  // Its own channel: a look never goes through applyView (no state side effects).
  assert.ok(!/function viewPayload\(\)[\s\S]{0,900}look/.test(main), 'not in the view');
  assert.ok(read('app', 'renderer', 'giant.js').includes("set('model', LOOKS.has(msg.look) ? msg.look : null);"));
  assert.ok(read('scripts', 'simulate.js').includes("else if (scenario === 'looks') await looksScenario();"));
});

// ------------------------------------------------------------- the art

test('classic look: every recoloured part falls back to the very colour robot.svg draws it in', () => {
  const rules = {};
  for (const m of CSS.matchAll(/:where\(\.rb-c-([a-z-]+)\) \{\n {2}(fill|stroke): var\(--rb-([a-z-]+), (#[0-9A-Fa-f]{6})\);\n\}/g)) {
    rules[m[1]] = { prop: m[2], variable: m[3], color: m[4].toUpperCase() };
  }
  assert.deepEqual(Object.keys(rules).sort(), ['accent', 'body', 'boot', 'boot-hi', 'hi', 'leg', 'shade']);
  const counts = {};
  for (const el of svgElements(SVG)) {
    for (const cls of el.classes.filter((c) => c.startsWith('rb-c-'))) {
      const name = cls.slice(5);
      const rule = rules[name];
      assert.ok(rule, cls);
      assert.equal(rule.variable, name, `--rb-${name}`);
      assert.equal((el.attrs[rule.prop] || '').toUpperCase(), rule.color, `${el.tag}.${cls}: ${rule.prop}`);
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  // Head and body; their shade (and the arms, the pocket); highlights; ear dials, cuffs, shoulders,
  // leg bands, soles; legs and the neck; boots and their highlight. Props keep their own colours.
  assert.deepEqual(counts, { leg: 3, accent: 10, boot: 2, 'boot-hi': 2, body: 2, shade: 9, hi: 3 });
  // Nothing else in robot.css paints these parts: the variables decide.
  assert.equal((CSS.match(/\.rb-c-/g) || []).length, 7);
});

test('looks: each family sets only colours of the robot itself, clear of orange and blue (DESIGN.md)', () => {
  const VARS = new Set(['--rb-body', '--rb-shade', '--rb-hi', '--rb-accent', '--rb-leg', '--rb-boot', '--rb-boot-hi']);
  for (const tier of TIERS) {
    const block = tierBlock(tier);
    const decls = [...block.matchAll(/(--[a-z-]+):\s*(#[0-9A-Fa-f]{6});/g)];
    assert.ok(decls.length > 0, tier);
    assert.equal(decls.length, block.split(';').filter((d) => d.trim()).length, `${tier}: colours only`);
    for (const [, name, color] of decls) {
      assert.ok(VARS.has(name), `${tier}: ${name}`);
      const { h, s } = hsl(color);
      assert.ok(!(h >= 8 && h <= 36 && s > 0.35), `${tier} ${name} ${color}: orange / terracotta`);
      assert.ok(!(h >= 185 && h <= 235 && s > 0.35), `${tier} ${name} ${color}: blue`);
    }
  }
  // Gold from Opus up; Haiku and Sonnet keep the mint accents. Opus keeps the classic body.
  assert.ok(!tierBlock('haiku').includes('--rb-accent'));
  assert.ok(!tierBlock('sonnet').includes('--rb-accent'));
  assert.ok(tierBlock('opus').includes('--rb-accent') && !tierBlock('opus').includes('--rb-body'));
  assert.ok(tierBlock('fable').includes('--rb-accent'));
});

test('looks: the details are props, hidden by default, never hit, shown from their family up', () => {
  const els = svgElements(SVG);
  for (const cls of ['rb-tier-gleam', 'rb-tier-star', 'rb-tier-glow', 'rb-tier-dust']) {
    const found = els.filter((e) => e.classes.includes(cls));
    assert.ok(found.length > 0, cls);
    for (const e of found) assert.ok('data-nohit' in e.attrs, `${cls} is data-nohit`);
  }
  assert.ok(CSS.includes('.rb-tier-gleam,\n.rb-tier-star,\n.rb-tier-glow,\n.rb-tier-dust {\n  display: none;\n}'));
  assert.ok(CSS.includes(".buddy-character:is([data-model='sonnet'], [data-model='opus'], [data-model='fable']) .rb-tier-gleam {"));
  assert.ok(CSS.includes(".buddy-character:is([data-model='opus'], [data-model='fable']) .rb-tier-star {"));
  assert.ok(CSS.includes(".buddy-character[data-model='fable'] :is(.rb-tier-glow, .rb-tier-dust) {"));
  // Nothing loops under data-rest; out of the way of the fire, the rampage, the duck, the waves, focus mode.
  assert.ok(
    CSS.includes(
      ".buddy-character[data-model='fable']:is([data-rest], [data-annoyed='2'], [data-annoyed='3'], [data-rampage], [data-duck], [data-task='web'], [data-holo]) :is(.rb-tier-glow, .rb-tier-dust) {\n  display: none;\n  animation: none;\n}",
    ),
  );
  // Cheap: stepped animations, a few changes per second.
  for (const name of ['rb-tier-glow', 'rb-tier-twinkle']) assert.match(CSS, new RegExp(`animation: ${name} [\\d.]+s steps\\(\\d\\) infinite;`));
});

test('looks: the star and the fairy dust are four-point sparkles (never a many-rayed starburst)', () => {
  const els = svgElements(SVG).filter((e) => e.classes.includes('rb-tier-star') || e.classes.includes('rb-dust'));
  assert.equal(els.length, 4);
  for (const e of els) {
    const points = e.attrs.d.match(/-?\d+(\.\d+)?\s+-?\d+(\.\d+)?/g);
    assert.equal(points.length, 8, `${e.attrs.class}: four tips, four inner corners`);
  }
});

// ------------------------------------------------------------- setup

test('setup: PostModelSwitch only for a Claude Code that knows it', () => {
  assert.equal(hooks.versionAtLeast('2.1.251', '2.1.251'), true);
  assert.equal(hooks.versionAtLeast('2.1.326', '2.1.251'), true);
  assert.equal(hooks.versionAtLeast('2.2.0', '2.1.251'), true);
  assert.equal(hooks.versionAtLeast('3.0.0', '2.1.251'), true);
  assert.equal(hooks.versionAtLeast('2.1.250', '2.1.251'), false);
  assert.equal(hooks.versionAtLeast('2.0.999', '2.1.251'), false);
  for (const bad of [null, undefined, '', 'latest', '2.1', 2]) assert.equal(hooks.versionAtLeast(bad, '2.1.251'), false, String(bad));
  const events = (v) => hooks.buildGroups(SEND_JS, v).map((g) => g.event);
  assert.deepEqual(events(null), hooks.HOOK_SPECS.map((s) => s.event), 'unknown version: everything as before');
  assert.ok(!events('2.1.250').includes('PostModelSwitch'));
  assert.equal(events('2.1.326').at(-1), 'PostModelSwitch');
  const group = hooks.buildGroups(SEND_JS, '2.1.326').find((g) => g.event === 'PostModelSwitch').group;
  assert.equal(group.hooks[0].async, true, 'Claude Code never waits for it');
  assert.equal(group.matcher, undefined, 'every model');
  // Up to date for that version; for an unknown one setup refreshes it (and leaves it out).
  const { settings } = hooks.addHooks({}, SEND_JS, '2.1.326');
  assert.ok(hooks.isInstalled(settings, SEND_JS, '2.1.326'));
  assert.equal(hooks.isInstalled(settings, SEND_JS, null), false);
  assert.deepEqual(hooks.missingEvents(hooks.addHooks({}, SEND_JS).settings, SEND_JS, '2.1.326'), ['PostModelSwitch']);
  assert.equal(hooks.removeHooks(settings).settings.hooks, undefined, 'uninstall takes it away too');
  assert.match(hooks.checkShape({ hooks: { PostModelSwitch: {} } }) || '', /PostModelSwitch/);
});

test('setup: the Claude Code version, from `claude --version` or PERCHBOT_CLAUDE_VERSION', () => {
  assert.equal(cli.parseClaudeVersion('2.1.326 (Claude Code)\n'), '2.1.326');
  assert.equal(cli.parseClaudeVersion('claude 10.20.30-beta'), '10.20.30');
  for (const bad of [null, '', 'command not found', '2.1']) assert.equal(cli.parseClaudeVersion(bad), null, String(bad));
  assert.equal(cli.claudeVersion({ env: { PERCHBOT_CLAUDE_VERSION: '2.1.300' } }), '2.1.300');
  assert.equal(cli.claudeVersion({ env: { PERCHBOT_CLAUDE_VERSION: 'none' } }), null);
  assert.equal(cli.claudeVersion({ env: {}, run: () => '2.1.251 (Claude Code)' }), '2.1.251');
  assert.equal(cli.claudeVersion({ env: {}, run: () => null }), null);
});

test('setup: a new Claude Code gets PostModelSwitch, an older one is told what was skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perchbot-looks-setup-'));
  const cfg = path.join(dir, 'cfg');
  const run = (version) => {
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, PERCHBOT_HOME: path.join(dir, '.perchbot'), CLAUDE_CONFIG_DIR: cfg, INIT_CWD: dir, PERCHBOT_CLAUDE_VERSION: version };
    const r = spawnSync(process.execPath, [path.join(ROOT, 'setup.js'), '--config-dir', cfg, '--dry-run'], { env, encoding: 'utf8', input: '' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const N = hooks.HOOK_SPECS.length;
  const fresh = run('2.1.326');
  assert.equal(fresh.code, 0, fresh.out);
  assert.match(fresh.out, /Claude Code {3}: 2\.1\.326/);
  assert.match(fresh.out, new RegExp(`Will add ${N + 1} hooks`));
  assert.match(fresh.out, /PostModelSwitch\s+all, async/);
  const old = run('2.1.200');
  assert.equal(old.code, 0, old.out);
  assert.match(old.out, /Skipped {7}: PostModelSwitch \(needs Claude Code 2\.1\.251\+/);
  assert.match(old.out, new RegExp(`Will add ${N} hooks`));
  assert.doesNotMatch(old.out, /PostModelSwitch\s+all/);
});
