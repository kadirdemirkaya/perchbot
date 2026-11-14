'use strict';

/**
 * perchbot doctor: checks that the buddy really comes up for every Claude
 * Code account, and fixes what it can.
 *
 *   1. Hooks: every account found (lib/cli.js findAccounts) has them for this
 *      copy of Perchbot; if not, setup runs (it asks first). Then Electron's
 *      binary: downloaded once if it is missing (lib/electron.js).
 *   2. Live test: for each account, its own hook command from its settings.json
 *      is run the way Claude Code runs it, with a test session ("SessionStart",
 *      as that account). The buddy starts if it is not running; the test checks
 *      that it counted the session, then ends it again ("SessionEnd"), so the
 *      buddy goes away by itself when nothing else is open.
 *   3. Old sessions: Claude Code reads the hooks when a session starts, so a
 *      session opened before they were written does not run them. Those are
 *      listed (process id and start time only) with what to do.
 *   4. The running buddy: its version, and whether it shows only one account.
 *
 * Node built-ins only. Nothing is stored; nothing leaves 127.0.0.1.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const cli = require('./cli');
const names = require('./names');
const hooks = require('./hooks-config');
const electron = require('./electron');

/** GET /health of the buddy, or null when it does not answer. */
function health(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function waitFor(check, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Perchbot's own command for `event` in a settings object, or null. */
function ourCommand(settings, event) {
  const groups = settings && settings.hooks && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  for (const group of groups) {
    for (const handler of group && Array.isArray(group.hooks) ? group.hooks : []) {
      if (hooks.isOurHandler(handler) && typeof handler.command === 'string') return handler.command;
    }
  }
  return null;
}

/** Run a hook command as Claude Code would: through a shell, the event as JSON on stdin. */
function runHook(command, input, env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    } catch {
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === null ? -1 : code);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Running Claude Code processes: [{ pid, started: Date }] (not the Chrome helper). Empty when unknown. */
function claudeProcesses() {
  return new Promise((resolve) => {
    const done = (list) => resolve(list.filter((p) => Number.isInteger(p.pid) && p.started instanceof Date && !Number.isNaN(+p.started)));
    if (process.platform === 'win32') {
      const ps =
        "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { " +
        "'{0}|{1}|{2}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), [int]($_.CommandLine -match 'chrome-native-host') }";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
        if (err) return done([]);
        done(
          String(out)
            .split(/\r?\n/)
            .map((line) => line.trim().split('|'))
            .filter((f) => f.length === 3 && f[2] === '0')
            .map(([pid, iso]) => ({ pid: Number(pid), started: new Date(iso) })),
        );
      });
      return;
    }
    execFile('ps', ['-A', '-o', 'pid=,lstart=,args='], { timeout: 8000 }, (err, out) => {
      if (err) return done([]);
      const list = [];
      for (const line of String(out).split('\n')) {
        // "  1234 Thu Nov 13 09:43:48 2026 /usr/local/bin/claude --resume"
        const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
        if (!m || /chrome-native-host/.test(m[3])) continue;
        const exe = path.basename(m[3].split(/\s+/)[0]);
        if (exe === 'claude' || /\/claude(\s|$)/.test(m[3])) list.push({ pid: Number(m[1]), started: new Date(m[2]) });
      }
      done(list);
    });
  });
}

/** Sessions started before `since` (when the hooks were written): they do not run them yet. */
function staleSessions(processes, since) {
  if (!(since instanceof Date)) return [];
  return processes.filter((p) => p.started < since).sort((a, b) => a.started - b.started);
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * @param {object} o
 * @param {string} o.sendJs  this copy's hook script
 * @param {string} o.version  this copy's version
 * @param {(argv: string[]) => Promise<number>} o.setup  setup.js main
 * @param {boolean} [o.yes]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {(line: string) => void} [o.log]
 * @param {typeof electron.ensureElectron} [o.ensureElectron]
 */
async function doctor({ sendJs, version, setup, yes = false, only = null, env = process.env, log = console.log, readConfig, ensureElectron = electron.ensureElectron }) {
  let problems = 0;
  const config = readConfig(env);
  const testEnvBase = { ...env, PERCHBOT_NO_PID: '1' };
  delete testEnvBase.CLAUDE_CONFIG_DIR;

  log(`Perchbot doctor (${version})\n`);

  // 1. Hooks everywhere (for this copy).
  let accounts = cli.findAccounts({ env: { ...env, CLAUDE_CONFIG_DIR: undefined } }).filter((a) => !only || path.basename(a.dir).slice(1) === only);
  const missing = accounts.filter((a) => {
    const s = cli.readSettings(a.file);
    return !s.error && !hooks.isInstalled(s.data || {}, sendJs);
  });
  if (!accounts.length) {
    log('  No Claude Code account found yet. Start Claude Code once, then run this again.');
    return 1;
  }
  if (missing.length) {
    log(`  Hooks missing (or for another copy) in: ${missing.map((a) => path.basename(a.dir).slice(1)).join(', ')}. Running setup:\n`);
    const code = await setup(yes ? ['--yes'] : []);
    if (code !== 0) {
      log('\n  Setup did not finish; the live test below shows what works.');
      problems += 1;
    }
    log('');
    accounts = cli.findAccounts({ env: { ...env, CLAUDE_CONFIG_DIR: undefined } }).filter((a) => !only || path.basename(a.dir).slice(1) === only);
  }
  const binary = ensureElectron({ log });
  if (!binary.ok) {
    log(`  ${electron.failureText(binary)}`);
    problems += 1;
  } else if (binary.downloaded) {
    log('');
  }

  // 2. The running buddy.
  const before = await health(config.port);
  if (before && before.version && before.version !== version) {
    log(`  The running buddy is version ${before.version}, this copy is ${version}: quit it once from its tray icon;`);
    log('  the next Claude Code prompt starts the new one.');
  }
  if (config.account !== 'all') {
    log(`  The buddy shows only the account "${config.account}" (tray menu: Account -> All accounts to see every one).`);
  }

  // 3. Live test, one test session per account.
  log(`\n  Live test (the buddy may pop up and say hello):`);
  const started = [];
  let count = before && Number.isInteger(before.sessions) ? before.sessions : 0;
  for (const a of accounts) {
    const name = path.basename(a.dir).slice(1);
    const s = cli.readSettings(a.file);
    const startCmd = s.error ? null : ourCommand(s.data, 'SessionStart');
    if (!startCmd) {
      log(`    ${name.padEnd(20)} FAIL: no Perchbot hook in ${a.file}`);
      problems += 1;
      continue;
    }
    const session = `perchbot-doctor-${name.replace(/[^A-Za-z0-9]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const testEnv = { ...testEnvBase, CLAUDE_CONFIG_DIR: a.dir };
    const input = { session_id: session, transcript_path: '', cwd: os.homedir(), hook_event_name: 'SessionStart', source: 'startup' };
    const code = await runHook(startCmd, input, testEnv);
    const shownHere = config.account === 'all' || config.account === name;
    const seen = code === 0 && shownHere && (await waitFor(async () => {
      const h = await health(config.port);
      return Boolean(h && Number.isInteger(h.sessions) && h.sessions > count);
    }, started.length ? 4000 : 15000));
    if (seen) {
      count += 1;
      log(`    ${name.padEnd(20)} OK: its hook ran and the buddy saw the session`);
    } else if (code !== 0) {
      log(`    ${name.padEnd(20)} FAIL: its hook command did not run (exit ${code}): ${startCmd}`);
      problems += 1;
    } else if (!shownHere) {
      log(`    ${name.padEnd(20)} hook OK, but the buddy only shows "${config.account}"`);
    } else {
      log(`    ${name.padEnd(20)} FAIL: the hook ran, but the buddy did not answer on 127.0.0.1:${config.port}`);
      problems += 1;
    }
    started.push({ a, session, testEnv, endCmd: ourCommand(s.data, 'SessionEnd') });
  }
  // End the test sessions again: with nothing else open, the buddy waves and goes.
  for (const t of started) {
    if (!t.endCmd) continue;
    await runHook(t.endCmd, { session_id: t.session, transcript_path: '', cwd: os.homedir(), hook_event_name: 'SessionEnd', reason: 'other' }, t.testEnv);
  }

  // 4. Sessions opened before the hooks were written.
  if (names.envValue('DOCTOR_NO_PS', env) !== '1') {
    let since = null;
    for (const a of accounts) {
      try {
        const m = fs.statSync(a.file).mtime;
        if (!since || m > since) since = m;
      } catch {
        // no file
      }
    }
    const stale = staleSessions(await claudeProcesses(), since);
    if (stale.length) {
      log(`\n  ${stale.length} Claude Code session(s) started before the hooks were last written (${hhmm(since)}):`);
      log(`    ${stale.map((p) => `pid ${p.pid} (since ${hhmm(p.started)})`).join(', ')}`);
      log('  They do not run the hooks yet. Restart them (VS Code: "Developer: Reload Window"),');
      log('  or type /hooks in them once. New sessions are fine.');
    }
  }

  log(problems ? `\n  ${problems} problem(s) found.` : '\n  All good: every account brings up the buddy.');
  return problems ? 1 : 0;
}

module.exports = { doctor, health, ourCommand, runHook, claudeProcesses, staleSessions };
