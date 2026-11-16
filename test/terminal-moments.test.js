'use strict';

/**
 * Shows for the terminal commands Claude Code runs (Bash / PowerShell), each from its own
 * command only (app/moments.js gitMoreMoments, installMoments): merge (and its conflict),
 * branch, stash / unstash, pull, force, rewind, install. The old commit / push (gitMoments)
 * are unchanged: test/moments.test.js stays as it was.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const send = require('../hooks/send.js');
const { DEMOS } = require('../app/validate');
const { MomentWatch, gitMoments, gitMoreMoments, installMoments, INSTALLERS } = require('../app/moments');
const { BuddyCore } = require('../app/core');
const { FakeClock } = require('./helpers/fake-clock');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const KINDS = ['merge', 'conflict', 'branch', 'stash', 'unstash', 'pull', 'force', 'rewind', 'install'];

test('gitMoreMoments: which git commands count, and which do not', () => {
  const cases = {
    'git merge main': ['merge'],
    'git rebase -i main': ['merge'],
    'git rebase --continue': ['merge'],
    'git checkout -b feat': ['branch'],
    'git checkout -B feat': ['branch'],
    'git switch -c x': ['branch'],
    'git switch --create x': ['branch'],
    'git stash': ['stash'],
    'git stash -u': ['stash'],
    'git stash push -m wip': ['stash'],
    'git stash save wip': ['stash'],
    'git stash pop': ['unstash'],
    'git stash apply stash@{1}': ['unstash'],
    'git pull --rebase': ['pull'],
    'git fetch origin': ['pull'],
    'git -C repo pull': ['pull'],
    'git push --force': ['force'],
    'git push -f origin main': ['force'],
    'git push --force-with-lease': ['force'],
    'git push --force-with-lease=main:abc origin main': ['force'],
    'git reset --hard HEAD~1': ['rewind'],
    'git revert abc123': ['rewind'],
    'git pull && git checkout -b x && git stash pop': ['pull', 'branch', 'unstash'],
  };
  for (const [command, want] of Object.entries(cases)) assert.deepEqual(gitMoreMoments(command), want, command);
  for (const none of [
    'git merge --abort',
    'git rebase --abort',
    'git checkout main',
    'git switch main',
    'git stash list',
    'git stash drop',
    'git stash show -p',
    'git push origin main',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git revert --abort',
    'git status',
    'git log --merge',
    'echo git merge x',
    'npm install',
    '',
    null,
  ]) {
    assert.deepEqual(gitMoreMoments(none), [], String(none));
  }
  // The old ones are not touched: commit and push only.
  assert.deepEqual(gitMoments('git merge main && git push --force'), ['push']);
});

test('installMoments: package installs of the usual managers, not their other commands', () => {
  const yes = [
    'npm install',
    'npm i -D vitest',
    'npm ci',
    'npm add left-pad',
    'sudo npm i -g perchbot',
    'pnpm add zod',
    'pnpm i',
    'yarn',
    'yarn add react',
    'yarn install --frozen-lockfile',
    'bun add hono',
    'pip install -r requirements.txt',
    'pip3 install requests',
    'python -m pip install requests',
    'py -m pip install x',
    'uv add httpx',
    'uv sync',
    'uv pip install x',
    'poetry add x',
    'poetry install',
    'cargo add serde',
    'cargo install ripgrep',
    'go get example.com/x',
    'gem install rails',
    'bundle',
    'bundle install',
    'composer require x/y',
    'cd app && npm install',
  ];
  for (const command of yes) assert.deepEqual(installMoments(command), ['install'], command);
  const no = ['npm run build', 'npm test', 'npm run install', 'npx vitest', 'yarn build', 'pnpm run dev', 'pip list', 'pip freeze', 'uv run app.py', 'cargo build', 'go build', 'go test ./...', 'bundle exec rspec', 'python app.py', 'echo npm install', 'install.sh', '', null];
  for (const command of no) assert.deepEqual(installMoments(command), [], String(command));
  assert.ok(Object.isFrozen(INSTALLERS));
});

test('moment watch: each one when its command worked; a failed merge is a conflict', () => {
  const run = (command, ok = true, tool = 'Bash') => {
    const w = new MomentWatch();
    w.toolStart('s', 't', tool, command);
    return w.toolEnd('s', 't', ok);
  };
  assert.deepEqual(run('git merge feature'), ['merge']);
  assert.deepEqual(run('git merge feature', false), ['conflict']);
  assert.deepEqual(run('git rebase main', false), ['conflict']);
  assert.deepEqual(run('git checkout -b x'), ['branch']);
  assert.deepEqual(run('git checkout -b x', false), [], 'failed: nothing');
  assert.deepEqual(run('git stash'), ['stash']);
  assert.deepEqual(run('git stash pop'), ['unstash']);
  assert.deepEqual(run('git pull'), ['pull']);
  assert.deepEqual(run('git pull', false), [], 'a failed pull is not a conflict');
  assert.deepEqual(run('git push --force'), ['push', 'force'], 'the old rocket, then the siren');
  assert.deepEqual(run('git reset --hard HEAD~1'), ['rewind']);
  assert.deepEqual(run('npm install', true, 'PowerShell'), ['install']);
  assert.deepEqual(run('npm install', false), []);
  assert.deepEqual(run('npm install', true, 'Edit'), [], 'only terminal commands');
  // In the order they ran, the old ones among them.
  assert.deepEqual(run('git pull && npm ci && git add -A && git commit -m x && git push -f'), ['pull', 'install', 'commit', 'push', 'force']);
  // The old streak is unchanged: a failed merge still counts as a failed tool.
  const w = new MomentWatch();
  for (let i = 0; i < 2; i += 1) {
    w.toolStart('s', `e${i}`, 'Bash', 'npm test');
    w.toolEnd('s', `e${i}`, false);
  }
  w.toolStart('s', 'm', 'Bash', 'git merge x');
  assert.deepEqual(w.toolEnd('s', 'm', false), ['conflict', 'sweat']);
});

test('core and hook: from the command Claude Code runs to the moment', () => {
  const clock = new FakeClock();
  const core = new BuddyCore({ clock, now: () => clock.now });
  const moments = [];
  core.on('moment', (m) => moments.push(m));
  let n = 0;
  const bash = (command, ok = true) => {
    const id = `toolu_${(n += 1)}`;
    // Through the hook's own payload: the shortened command is enough to tell.
    const pre = send.buildPayload({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: id, tool_input: { command } }, 'PreToolUse', clock.now);
    core.handle(pre);
    const post = send.buildPayload({ hook_event_name: ok ? 'PostToolUse' : 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_use_id: id, tool_input: { command } }, ok ? 'PostToolUse' : 'PostToolUseFailure', clock.now);
    core.handle(post);
  };
  core.handle({ v: 1, event: 'SessionStart', session: 's1', ts: clock.now, source: 'startup' });
  core.handle({ v: 1, event: 'UserPromptSubmit', session: 's1', ts: clock.now });
  bash('git merge feature', false);
  bash('git merge feature');
  bash('git checkout -b fix-login');
  bash('git stash');
  bash('git stash pop');
  bash('git pull');
  bash('git push --force');
  bash('git reset --hard HEAD~1');
  bash('npm install');
  bash('npm run build');
  assert.deepEqual(moments, ['conflict', 'merge', 'branch', 'stash', 'unstash', 'pull', 'push', 'force', 'rewind', 'install']);
  core.dispose();
});

test('page: a show for each, with its art, styles, words, poses and demo', () => {
  const page = read('app', 'renderer', 'renderer.js');
  const block = page.slice(page.indexOf('const TERMINAL_SHOWS = Object.freeze({'), page.indexOf('function terminalShow('));
  assert.ok(block.length > 100, 'TERMINAL_SHOWS');
  for (const kind of KINDS) assert.match(block, new RegExp(`\\n    ${kind}: \\{`), kind);
  assert.ok(page.includes('if (Object.hasOwn(TERMINAL_SHOWS, kind)) {'), 'onMoment hands them over');
  // Motion off: no fx and no pose, the quip still comes.
  assert.match(page, /if \(motionAllowed\(\) && character\) \{[\s\S]*?\}\s*quip\(show\.quip, 1800\);/);
  const html = read('app', 'renderer', 'index.html');
  const symbols = [...new Set([...block.matchAll(/'#(i-[a-z-]+)'/g)].map((m) => m[1]))];
  assert.ok(symbols.length >= 15, symbols.join(' '));
  for (const id of symbols) assert.ok(html.includes(`<symbol id="${id}"`), id);
  const css = read('app', 'renderer', 'overlay.css');
  for (const cls of ['merge', 'branch', 'stash', 'pull', 'force', 'rewind', 'install']) assert.ok(css.includes(`.fx-${cls} {`), cls);
  for (const cls of [...block.matchAll(/'(fx-[a-z-]+)'/g)].map((m) => m[1])) assert.ok(css.includes(`.${cls}`), cls);
  assert.ok(css.includes('.fx-terminal.fx-mirror {'), 'mirrored when it faces left');
  const robot = read('characters', 'robot', 'robot.css');
  for (const pose of ['flinch', 'puzzled']) {
    assert.ok(block.includes(`moment: '${pose}'`), pose);
    assert.ok(robot.includes(`.buddy-character[data-moment='${pose}'] .rb-head {`), `${pose} in robot.css`);
  }
  for (const lang of ['en', 'tr']) {
    const strings = JSON.parse(read('app', 'locales', `${lang}.json`));
    const quips = Object.values(strings).find((v) => v && typeof v === 'object' && 'commit' in v && 'push' in v);
    for (const kind of KINDS) assert.ok(quips[kind], `${lang}: ${kind}`);
  }
  for (const kind of KINDS) assert.ok(DEMOS.has(kind), `demo ${kind}`);
});
