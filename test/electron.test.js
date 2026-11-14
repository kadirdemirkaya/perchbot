'use strict';

/**
 * Electron's binary (lib/electron.js). Electron 45 no longer downloads it during
 * `npm install`, so a fresh `npm install -g perchbot` had none and the robot never
 * started. setup / start / demo / doctor now run Electron's own installer once;
 * the hook never does. No test here touches the network: the installer is a fake.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = require('../lib/electron');
const send = require('../hooks/send.js');
const hooks = require('../lib/hooks-config');

const ROOT = path.join(__dirname, '..');
const N = hooks.HOOK_SPECS.length;

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `perchbot-${prefix}-`));

/** A fake electron package: install.js "downloads" by writing path.txt and dist/<binary>. */
function fakeElectron(root, { installExit = 0, downloads = true } = {}) {
  const pkg = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0-test' }));
  const body = downloads
    ? `const fs = require('fs'), path = require('path');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'fake-electron'), '');
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'fake-electron');
console.log('fake download done');`
    : '';
  fs.writeFileSync(path.join(pkg, 'install.js'), `${body}\nprocess.exit(${installExit});\n`);
  return pkg;
}

/** setup.js with the modules it needs, in a folder with no Electron in reach. */
function copyOfPerchbot() {
  const root = tmp('copy');
  fs.copyFileSync(path.join(ROOT, 'setup.js'), path.join(root, 'setup.js'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'hooks'), path.join(root, 'hooks'), { recursive: true });
  return root;
}

function setup(root, args) {
  const home = tmp('home');
  const cfg = path.join(home, 'cfg');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PERCHBOT_HOME: path.join(home, '.perchbot'), CLAUDE_CONFIG_DIR: cfg };
  const r = spawnSync(process.execPath, [path.join(root, 'setup.js'), '--config-dir', cfg, ...args], { env, encoding: 'utf8', input: '' });
  const file = path.join(cfg, 'settings.json');
  const ours = fs.existsSync(file) ? hooks.countOurHandlers(JSON.parse(fs.readFileSync(file, 'utf8'))) : 0;
  return { code: r.status, out: r.stdout + r.stderr, ours };
}

// ------------------------------------------------------------- finding it

test('electron: the binary is read from path.txt and dist/, null when the download never happened', () => {
  const root = tmp('find');
  const pkg = fakeElectron(root);
  assert.equal(send.electronDirs(root)[0], pkg, "Perchbot's own node_modules comes first");
  assert.equal(send.electronBinary(root), null, 'package there, binary not');
  spawnSync(process.execPath, [path.join(pkg, 'install.js')]);
  assert.equal(send.electronBinary(root), path.join(pkg, 'dist', 'fake-electron'));
});

test('electron: the installer is install.js in the first package that has one', () => {
  const dirs = [path.join('a', 'electron'), path.join('b', 'electron')];
  const has = (file) => file === path.join('b', 'electron', 'install.js');
  assert.equal(electron.installerPath({ dirs, exists: has }), path.join('b', 'electron', 'install.js'));
  assert.equal(electron.installerPath({ dirs, exists: () => false }), null);
});

// ------------------------------------------------------------- ensureElectron

test('electron: already there -> nothing is run', () => {
  let ran = 0;
  const r = electron.ensureElectron({ find: () => 'C:/e/electron.exe', installer: () => 'x', run: () => (ran += 1), log: () => {} });
  assert.deepEqual(r, { ok: true, binary: 'C:/e/electron.exe', downloaded: false });
  assert.equal(ran, 0);
});

test('electron: missing -> Electron\'s installer runs once with this Node, then the binary is used', () => {
  let binary = null;
  const calls = [];
  const lines = [];
  const r = electron.ensureElectron({
    find: () => binary,
    installer: () => path.join('pkg', 'electron', 'install.js'),
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd, stdio: opts.stdio });
      binary = 'C:/pkg/electron/dist/electron.exe';
      return { status: 0 };
    },
    log: (l) => lines.push(l),
  });
  assert.deepEqual(r, { ok: true, binary: 'C:/pkg/electron/dist/electron.exe', downloaded: true });
  assert.deepEqual(calls, [{ cmd: process.execPath, args: [path.join('pkg', 'electron', 'install.js')], cwd: path.join('pkg', 'electron'), stdio: 'inherit' }]);
  assert.match(lines[0], /Downloading Electron.*about 100 MB, only this once/);
  assert.match(lines.at(-1), /Electron is ready/);
});

test('electron: a failed download says how to retry; no package says reinstall', () => {
  const script = path.join('pkg', 'electron', 'install.js');
  for (const run of [() => ({ status: 1 }), () => ({ status: 0 }), () => ({ status: null, error: new Error('spawn') })]) {
    const r = electron.ensureElectron({ find: () => null, installer: () => script, run, log: () => {} });
    assert.deepEqual(r, { ok: false, binary: null, downloaded: false, reason: 'failed', installer: script });
    const text = electron.failureText(r);
    assert.match(text, /could not be downloaded/);
    assert.ok(text.includes('perchbot setup') && text.includes(`node "${script}"`), text);
  }
  let ran = 0;
  const none = electron.ensureElectron({ find: () => null, installer: () => null, run: () => (ran += 1), log: () => {} });
  assert.deepEqual(none, { ok: false, binary: null, downloaded: false, reason: 'no-package' });
  assert.equal(ran, 0);
  assert.match(electron.failureText(none), /npm install -g perchbot/);
});

test('electron: the hook never downloads (no require of electron or lib/electron in hooks/send.js)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'send.js'), 'utf8');
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]\s*\)/);
  assert.doesNotMatch(src, /require\(\s*['"][./]*lib\/electron/);
});

// ------------------------------------------------------------- setup, end to end

test('setup: --dry-run only says Electron will be downloaded, and downloads nothing', () => {
  const root = copyOfPerchbot();
  const pkg = fakeElectron(root);
  const r = setup(root, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Electron\s+: not downloaded yet; setup downloads it once \(about 100 MB\)/);
  assert.match(r.out, /nothing was written/);
  assert.doesNotMatch(r.out, /Downloading Electron/);
  assert.equal(fs.existsSync(path.join(pkg, 'path.txt')), false);
  assert.equal(r.ours, 0);
});

test('setup: writes the hooks, then downloads Electron once', () => {
  const root = copyOfPerchbot();
  const pkg = fakeElectron(root);
  const first = setup(root, ['--yes']);
  assert.equal(first.code, 0, first.out);
  assert.equal(first.ours, N);
  assert.match(first.out, /Downloading Electron[\s\S]*fake download done[\s\S]*Electron is ready/);
  assert.ok(first.out.indexOf('hooks written') < first.out.indexOf('Downloading Electron'), 'hooks first, then the download');
  assert.ok(fs.existsSync(path.join(pkg, 'dist', 'fake-electron')));
  assert.equal(send.electronBinary(root), path.join(pkg, 'dist', 'fake-electron'));
});

test('setup: hooks already in place but Electron missing -> setup still downloads it', () => {
  const root = copyOfPerchbot();
  const home = tmp('home');
  const cfg = path.join(home, 'cfg');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PERCHBOT_HOME: path.join(home, '.perchbot'), CLAUDE_CONFIG_DIR: cfg };
  const run = () => spawnSync(process.execPath, [path.join(root, 'setup.js'), '--config-dir', cfg, '--yes'], { env, encoding: 'utf8', input: '' });
  const first = run(); // no electron package yet: hooks written, download impossible
  assert.equal(first.status, 1, first.stdout + first.stderr);
  const pkg = fakeElectron(root);
  const second = run();
  const out = second.stdout + second.stderr;
  assert.equal(second.status, 0, out);
  assert.match(out, /already installed/);
  assert.match(out, /Electron is ready/);
  assert.ok(fs.existsSync(path.join(pkg, 'path.txt')));
});

test('setup: no Electron package or a failed download -> hooks stay, exit 1, says what to do', () => {
  const bare = copyOfPerchbot();
  const none = setup(bare, ['--yes']);
  assert.equal(none.code, 1, none.out);
  assert.equal(none.ours, N, 'the hooks are written anyway');
  assert.match(none.out, /Electron's package is missing/);
  assert.match(none.out, /The hooks are in place/);

  const broken = copyOfPerchbot();
  fakeElectron(broken, { installExit: 1, downloads: false });
  const failed = setup(broken, ['--yes']);
  assert.equal(failed.code, 1, failed.out);
  assert.equal(failed.ours, N);
  assert.match(failed.out, /could not be downloaded/);
  assert.match(failed.out, /node ".*install\.js"/);
});

test('setup: with Electron in place nothing about it is printed (the repo itself)', () => {
  if (!send.electronBinary()) return; // a clone without the binary yet
  const home = tmp('home');
  const cfg = path.join(home, 'cfg');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PERCHBOT_HOME: path.join(home, '.perchbot'), CLAUDE_CONFIG_DIR: cfg };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'setup.js'), '--config-dir', cfg, '--dry-run'], { env, encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /Electron/);
});
