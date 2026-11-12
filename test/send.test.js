'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const send = require('../hooks/send.js');
const { validateEvent } = require('../app/validate');

const SEND_JS = path.join(__dirname, '..', 'hooks', 'send.js');
const ALLOWED_KEYS = new Set(Object.keys(send.PAYLOAD_FIELDS));

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-buddy-test-'));
}

/** A port nothing listens on. */
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Run send.js like Claude Code does: JSON on stdin. */
function runHook(stdin, env = {}, args = []) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SEND_JS, ...args], {
      env: { ...process.env, AGENT_BUDDY_NO_LAUNCH: '1', AGENT_BUDDY_NO_PID: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

// ------------------------------------------------------------- buildPayload

test('file tools forward only the file name, never contents', () => {
  const p = send.buildPayload(
    {
      session_id: 'abc-123',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 'toolu_01',
      tool_input: {
        file_path: 'C:\\Users\\me\\project\\src\\index.ts',
        old_string: 'TOP SECRET OLD',
        new_string: 'TOP SECRET NEW',
      },
      transcript_path: '/home/me/.claude/x.jsonl',
      cwd: '/home/me/project',
      prompt: 'private prompt',
    },
    undefined,
    42,
  );
  assert.deepEqual(p, {
    v: 1,
    event: 'PreToolUse',
    session: 'abc-123',
    ts: 42,
    tool: 'Edit',
    id: 'toolu_01',
    detail: 'index.ts',
  });
  const json = JSON.stringify(p);
  assert.ok(!json.includes('SECRET'));
  assert.ok(!json.includes('project'));
  assert.ok(!json.includes('private'));
});

test('POSIX paths and long file names', () => {
  assert.equal(send.fileLabel('/home/me/a/b/component.test.tsx'), 'component.test.tsx');
  const long = send.fileLabel('/x/a-really-long-generated-file-name-for-testing.spec.ts');
  assert.ok(long.length <= 36, long);
  assert.ok(long.endsWith('ng.spec.ts'), long);
  assert.ok(long.includes('\u2026'));
  assert.equal(send.fileLabel(''), undefined);
  assert.equal(send.fileLabel(42), undefined);
});

test('commands are cut to 40 characters, first line only', () => {
  const long = 'npm run build -- --mode production --verbose --watch=false';
  const s = send.summarizeCommand(long);
  assert.ok(s.length <= 40, s);
  assert.ok(s.startsWith('npm run build'));
  assert.equal(send.summarizeCommand('git status\ngit diff --stat'), 'git status \u2026');
  assert.equal(send.summarizeCommand('  ls   -la  '), 'ls -la');
  assert.equal(send.summarizeCommand(''), undefined);
  assert.equal(send.summarizeCommand(null), undefined);
});

test('secrets in commands are masked before shortening', () => {
  const cases = [
    ['curl -H "Authorization: Bearer abc.def.ghi" x', 'abc.def'],
    ['mysql --password=hunter2 db', 'hunter2'],
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234 gh pr list', 'ghp_'],
    ['$env:OPENAI_API_KEY = "sk-live-123"', 'sk-live'],
    ['git clone https://user:s3cret@example.com/r.git', 's3cret'],
    ['curl -u admin:letmein https://x', 'letmein'],
    ['deploy --api-key AKIAIOSFODNN7EXAMPLE1234', 'AKIA'],
    ['echo eyJhbGciOiJIUzI1NiJ9abcdefgh12345678', 'eyJhbGci'],
  ];
  for (const [command, secret] of cases) {
    const masked = send.maskSecrets(command);
    assert.ok(!masked.includes(secret), `${command} -> ${masked}`);
    assert.ok(masked.includes('***'), masked);
  }
  // Ordinary commands stay readable.
  assert.equal(send.maskSecrets('npm test -- src/components/Header2.test.tsx'), 'npm test -- src/components/Header2.test.tsx');
});

test('search patterns, web hosts and notification / session fields', () => {
  const grep = send.buildPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Grep', tool_input: { pattern: 'TODO\\(\\w+\\)', path: '/secret/dir' } });
  assert.equal(grep.detail, 'TODO\\(\\w+\\)');

  const web = send.buildPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'WebFetch', tool_input: { url: 'https://www.example.com/private?token=1', prompt: 'x' } });
  assert.equal(web.detail, 'example.com');

  const note = send.buildPayload({ hook_event_name: 'Notification', session_id: 's', message: 'Claude needs permission to run rm -rf', notification_type: 'permission_prompt' });
  assert.deepEqual(Object.keys(note).sort(), ['event', 'kind', 'session', 'ts', 'v']);

  const start = send.buildPayload({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume', model: 'x' });
  assert.equal(start.source, 'resume');
  assert.equal(start.model, undefined);

  const end = send.buildPayload({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'prompt_input_exit' });
  assert.equal(end.reason, 'prompt_input_exit');

  const post = send.buildPayload({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat .env' }, tool_response: { stdout: 'API_KEY=1' } });
  assert.equal(post.detail, undefined, 'PostToolUse never carries details');
  assert.ok(!JSON.stringify(post).includes('API_KEY'));
});

test('unknown events are dropped, bad ids fall back, argv names the event', () => {
  assert.equal(send.buildPayload({ hook_event_name: 'PreCompact', session_id: 's' }), null);
  assert.equal(send.buildPayload(null), null);
  assert.equal(send.buildPayload({ session_id: 's' }, 'Stop').event, 'Stop');
  assert.equal(send.buildPayload('garbage', 'Stop').session, 'unknown');
  assert.equal(send.buildPayload({ hook_event_name: 'Stop', session_id: '../../etc' }).session, 'unknown');
  assert.equal(send.buildPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: '<script>' }).tool, 'unknown');
});

test('every payload passes the overlay validator unchanged', () => {
  const inputs = [
    { hook_event_name: 'SessionStart', session_id: 'a1', source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', session_id: 'a1', prompt: 'hi' },
    { hook_event_name: 'PreToolUse', session_id: 'a1', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } },
    { hook_event_name: 'PostToolUse', session_id: 'a1', tool_name: 'Bash', tool_use_id: 't1' },
    { hook_event_name: 'PostToolUseFailure', session_id: 'a1', tool_name: 'Bash', tool_use_id: 't1' },
    { hook_event_name: 'Notification', session_id: 'a1', notification_type: 'idle_prompt' },
    { hook_event_name: 'Stop', session_id: 'a1' },
    { hook_event_name: 'SessionEnd', session_id: 'a1', reason: 'other' },
    { hook_event_name: 'SubagentStart', session_id: 'a1', agent_id: 'agent-123', agent_type: 'Explore' },
    { hook_event_name: 'SubagentStop', session_id: 'a1', agent_id: 'agent-123', agent_type: 'Explore' },
    { hook_event_name: 'PreToolUse', session_id: 'a1', agent_id: 'agent-123', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: '/p/x.js' } },
    { hook_event_name: 'PreToolUse', session_id: 'a1', tool_name: 'Skill', tool_use_id: 't3', tool_input: { skill: 'pdf' } },
    { hook_event_name: 'UserPromptExpansion', session_id: 'a1', expansion_type: 'slash_command', command_name: '/buddy-ping' },
  ];
  for (const input of inputs) {
    const payload = send.buildPayload(input);
    for (const key of Object.keys(payload)) assert.ok(ALLOWED_KEYS.has(key), key);
    assert.deepEqual(validateEvent(payload), payload, input.hook_event_name);
  }
});

test('sub-agents: a short agent hash and the type, never the raw id', () => {
  const tool = send.buildPayload({
    hook_event_name: 'PreToolUse', session_id: 's', agent_id: 'a5f3c9e1-raw-id', agent_type: 'Explore',
    tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/p/main.js' },
  });
  assert.match(tool.agent, /^[a-f0-9]{10}$/);
  assert.equal(tool.agentType, 'Explore');
  assert.ok(!JSON.stringify(tool).includes('a5f3c9e1'), 'raw agent id is not forwarded');
  const main = send.buildPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/p/a.js' } });
  assert.equal(main.agent, undefined, 'main-session tools have no agent');

  const start = send.buildPayload({
    hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a5f3c9e1-raw-id', agent_type: 'plugin:reviewer <b>',
    transcript_path: '/home/u/.claude/x.jsonl', prompt_id: 'p', scratchpad_dir: '/tmp/x',
  });
  assert.deepEqual(Object.keys(start).sort(), ['agent', 'agentType', 'event', 'session', 'ts', 'v']);
  assert.equal(start.agent, tool.agent, 'the same agent gets the same hash');
  assert.equal(start.agentType, 'plugin:reviewer b');
  const stop = send.buildPayload({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'x', agent_transcript_path: '/p', last_assistant_message: 'LEAK' });
  assert.ok(!JSON.stringify(stop).includes('LEAK'));
  assert.equal(send.buildPayload({ hook_event_name: 'SubagentStart', session_id: 's' }), null, 'no agent id, nothing to show');
  assert.equal(send.agentTypeLabel('x'.repeat(80)).length, 40);
});

test('skills: only the name, cut to 24 safe characters', () => {
  const skill = send.buildPayload({
    hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Skill', tool_use_id: 't1',
    tool_input: { skill: 'pdf', args: 'secret arguments LEAK' },
  });
  assert.equal(skill.skill, 'pdf');
  assert.ok(!JSON.stringify(skill).includes('LEAK'));
  assert.equal(send.skillLabel('anthropic-skills:very-long-skill-name-here'), 'anthropic-skills:very-lo');
  assert.equal(send.skillLabel('/re view<script>'), 'reviewscript');
  assert.equal(send.skillLabel('  '), undefined);
  const other = send.buildPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: { skill: 'x' } });
  assert.equal(other.skill, undefined, 'only the Skill tool names a skill');
});

test('UserPromptExpansion: only slash commands, only the command name', () => {
  const cmd = send.buildPayload({
    hook_event_name: 'UserPromptExpansion', session_id: 's', expansion_type: 'slash_command',
    command_name: '/buddy-ping', command_args: 'LEAK-args', prompt: 'LEAK-prompt',
  });
  assert.deepEqual(Object.keys(cmd).sort(), ['event', 'session', 'skill', 'ts', 'v']);
  assert.equal(cmd.skill, 'buddy-ping');
  assert.ok(!JSON.stringify(cmd).includes('LEAK'));
  assert.equal(send.buildPayload({ hook_event_name: 'UserPromptExpansion', session_id: 's', expansion_type: 'mcp_prompt', command_name: 'x' }), null);
  assert.equal(send.buildPayload({ hook_event_name: 'UserPromptExpansion', session_id: 's', expansion_type: 'slash_command' }), null);
});

// ------------------------------------------------------------- accounts

test('account: only the config folder name, without leading dots, never a path', () => {
  assert.equal(send.accountName({}), 'claude', 'no CLAUDE_CONFIG_DIR: the default account');
  assert.equal(send.accountName({ CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'Some User', '.claude-work') }), 'claude-work');
  assert.equal(send.accountName({ CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), '.claude-personal') + path.sep }), 'claude-personal');
  assert.equal(send.accountName({ CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'ünïcode <x>') }), 'ncodex');
  assert.equal(send.accountName({ CLAUDE_CONFIG_DIR: '   ' }), 'claude');
  const p = send.buildPayload({ hook_event_name: 'Stop', session_id: 's' }, undefined, 1, { account: 'claude-work' });
  assert.equal(p.account, 'claude-work');
  assert.equal(validateEvent(p).account, 'claude-work');
  const bad = send.buildPayload({ hook_event_name: 'Stop', session_id: 's' }, undefined, 1, { account: '../x y' });
  assert.equal(bad.account, undefined);
});

test('account: the hook sends it, and never starts the overlay for a filtered-out account', async () => {
  const home = tmpHome();
  const ev = (account) => ({ event: 'UserPromptSubmit', session: 's', account });
  assert.equal(send.shouldLaunch(ev('claude-work'), { home, account: 'all' }), true);
  assert.equal(send.shouldLaunch(ev('claude-work'), { home, account: 'claude-work' }), true);
  assert.equal(send.shouldLaunch(ev('claude'), { home, account: 'claude-work' }), false);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ account: 'claude-work' }));
  assert.equal(send.readConfig({ AGENT_BUDDY_HOME: home }).account, 'claude-work');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ account: '../../etc' }));
  assert.equal(send.readConfig({ AGENT_BUDDY_HOME: home }).account, 'all');

  // End to end: the real script reads CLAUDE_CONFIG_DIR and sends only the folder name.
  const port = await freePort();
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const dir = path.join(os.tmpdir(), 'private-name', '.claude-test');
  await runHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), {
    AGENT_BUDDY_HOME: tmpHome(),
    AGENT_BUDDY_PORT: String(port),
    CLAUDE_CONFIG_DIR: dir,
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(received.length, 1);
  assert.equal(received[0].account, 'claude-test');
  assert.ok(!JSON.stringify(received[0]).includes('private-name'));
});

// ------------------------------------------------------------- launch rules

test('only SessionStart / UserPromptSubmit may launch, and muted sessions do not', () => {
  const home = tmpHome();
  const config = { home, noLaunch: false };
  const ev = (event, session = 's1') => ({ event, session });
  assert.equal(send.shouldLaunch(ev('SessionStart'), config), true);
  assert.equal(send.shouldLaunch(ev('UserPromptSubmit'), config), true);
  for (const event of ['SessionEnd', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']) {
    assert.equal(send.shouldLaunch(ev(event), config), false, event);
  }
  assert.equal(send.shouldLaunch(ev('SessionStart'), { home, noLaunch: true }), false);

  fs.writeFileSync(path.join(home, 'muted.json'), JSON.stringify({ sessions: ['s1'], until: Date.now() + 60000 }));
  assert.equal(send.shouldLaunch(ev('UserPromptSubmit', 's1'), config), false, 'muted');
  assert.equal(send.shouldLaunch(ev('UserPromptSubmit', 's2'), config), true, 'other session');
  assert.equal(send.shouldLaunch(ev('SessionStart', 's1'), config), true, 'a fresh start un-mutes');

  fs.writeFileSync(path.join(home, 'muted.json'), JSON.stringify({ sessions: ['s1'], until: Date.now() - 1 }));
  assert.equal(send.shouldLaunch(ev('UserPromptSubmit', 's1'), config), true, 'expired');
});

test('config: env port beats settings file, invalid values fall back', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ port: 8123, debug: true }));
  assert.deepEqual(send.readConfig({ AGENT_BUDDY_HOME: home }), { home, port: 8123, debug: true, noLaunch: false, noPid: false, account: 'all' });
  assert.equal(send.readConfig({ AGENT_BUDDY_HOME: home, AGENT_BUDDY_NO_PID: '1' }).noPid, true);
  assert.equal(send.readConfig({ AGENT_BUDDY_HOME: home, AGENT_BUDDY_PORT: '9001' }).port, 9001);
  assert.equal(send.readConfig({ AGENT_BUDDY_HOME: home, AGENT_BUDDY_PORT: '80' }).port, 8123);
  fs.writeFileSync(path.join(home, 'settings.json'), '{broken');
  assert.equal(send.readConfig({ AGENT_BUDDY_HOME: home }).port, 7777);
});

// ------------------------------------------------------------- process behaviour

test('the hook process is silent, exits 0 and is quick, whatever the input', async () => {
  const port = await freePort();
  const env = { AGENT_BUDDY_HOME: tmpHome(), AGENT_BUDDY_PORT: String(port) };
  const inputs = [
    '',
    'not json at all',
    '{"half": ',
    '\uFEFF{"hook_event_name":"Stop","session_id":"bom"}',
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'Edit', tool_input: { file_path: '/a/b.js' } }),
    JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'x', reason: 'other' }),
    JSON.stringify([1, 2, 3]),
  ];
  for (const input of inputs) {
    const r = await runHook(input, env, ['Stop']);
    assert.equal(r.code, 0, `exit code for ${JSON.stringify(input)}`);
    assert.equal(r.stdout, '', `stdout for ${JSON.stringify(input)}`);
    assert.ok(r.ms < 1500, `took ${r.ms} ms`);
  }
});

test('large stdin (e.g. a big Write) is handled and not forwarded', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      received.push(body);
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write', tool_input: { file_path: '/p/big.txt', content: big } });
    const r = await runHook(input, { AGENT_BUDDY_HOME: tmpHome(), AGENT_BUDDY_PORT: String(server.address().port) });
    assert.equal(r.code, 0);
    assert.equal(received.length, 1);
    assert.ok(received[0].length < 300, `forwarded ${received[0].length} bytes`);
    assert.equal(JSON.parse(received[0]).detail, 'big.txt');
  } finally {
    server.close();
  }
});

test('delivers a whitelisted JSON body to the overlay endpoint', async () => {
  let captured = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) };
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const r = await runHook(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_use_id: 'toolu_9',
        tool_input: { command: 'AWS_SECRET_ACCESS_KEY=abc123abc123 aws s3 ls s3://bucket --recursive --human-readable' },
      }),
      { AGENT_BUDDY_HOME: tmpHome(), AGENT_BUDDY_PORT: String(server.address().port) },
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url, '/event');
    assert.equal(captured.headers['content-type'], 'application/json');
    assert.equal(captured.headers.origin, undefined);
    for (const key of Object.keys(captured.body)) assert.ok(ALLOWED_KEYS.has(key), key);
    assert.equal(captured.body.tool, 'Bash');
    assert.ok(captured.body.detail.length <= 40);
    assert.ok(!captured.body.detail.includes('abc123'), captured.body.detail);
  } finally {
    server.close();
  }
});

test('debug log (opt-in) records metadata only', async () => {
  const home = tmpHome();
  const port = await freePort();
  await runHook(
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-log', tool_name: 'Bash', tool_input: { command: 'echo supersecretvalue' } }),
    { AGENT_BUDDY_HOME: home, AGENT_BUDDY_PORT: String(port), AGENT_BUDDY_DEBUG: '1' },
  );
  const log = fs.readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8');
  assert.match(log, /event=PreToolUse/);
  assert.match(log, /result=refused/);
  assert.ok(!log.includes('supersecretvalue'));
  assert.ok(!log.includes('echo'));

  const quiet = tmpHome();
  await runHook(JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), { AGENT_BUDDY_HOME: quiet, AGENT_BUDDY_PORT: String(port) });
  assert.equal(fs.existsSync(path.join(quiet, 'logs')), false, 'no log unless enabled');
});

// ------------------------------------------------------------- schema probe (dev aid, off by default)

test('schema probe records field names and salted id hashes, never values', () => {
  const input = {
    session_id: 'session-secret-1',
    agent_id: 'agent-secret-2',
    agent_type: 'SecretType',
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: 'secret-skill-name', args: 'secret args' },
    tool_response: 'secret output',
    prompt: 'secret prompt',
  };
  const rec = send.schemaRecord(input, 'salt-a');
  assert.deepEqual(rec.keys, ['agent_id', 'agent_type', 'hook_event_name', 'prompt', 'session_id', 'tool_input', 'tool_name', 'tool_response']);
  assert.deepEqual(rec.tool_input, ['args', 'skill']);
  assert.equal(rec.tool_response, undefined);
  assert.equal(rec.tool_response_type, 'string');
  assert.equal(rec.event, 'PreToolUse');
  assert.equal(rec.tool, 'Skill');
  assert.match(rec.session, /^[0-9a-f]{8}$/);
  assert.match(rec.agent, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(rec).includes('secret'), JSON.stringify(rec));
  assert.equal(send.schemaRecord(input, 'salt-a').agent, rec.agent, 'same salt, same hash');
  assert.notEqual(send.schemaRecord(input, 'salt-b').agent, rec.agent, 'different salt, different hash');
});

test('schema probe writes only while the flag file exists', async () => {
  const home = tmpHome();
  const port = await freePort();
  const env = { AGENT_BUDDY_HOME: home, AGENT_BUDDY_PORT: String(port) };
  const input = JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'abc', agent_id: 'xyz', agent_type: 'Explore' });
  await runHook(input, env);
  assert.equal(fs.existsSync(path.join(home, 'logs', 'schema.log')), false, 'off by default');

  fs.writeFileSync(path.join(home, 'schema-log.on'), 'random-salt');
  const r = await runHook(input, env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  const lines = fs.readFileSync(path.join(home, 'logs', 'schema.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.event, 'SubagentStart');
  assert.deepEqual(rec.keys, ['agent_id', 'agent_type', 'hook_event_name', 'session_id']);
  assert.ok(!lines[0].includes('Explore') && !lines[0].includes('xyz') && !lines[0].includes('abc"'), lines[0]);
});

test('schema probe: the expansion type of a slash command, and no other value', () => {
  const rec = send.schemaRecord(
    {
      hook_event_name: 'UserPromptExpansion',
      session_id: 'sess-1',
      expansion_type: 'slash_command',
      command_name: '/secret-cmd',
      command_args: 'LEAK-ARGS',
      prompt: 'LEAK-PROMPT',
    },
    'salt',
    {},
  );
  assert.equal(rec.event, 'UserPromptExpansion');
  assert.equal(rec.expansion_type, 'slash_command');
  assert.deepEqual(rec.keys, ['command_args', 'command_name', 'expansion_type', 'hook_event_name', 'prompt', 'session_id']);
  const text = JSON.stringify(rec);
  for (const leak of ['LEAK-ARGS', 'LEAK-PROMPT', 'secret-cmd', 'sess-1']) assert.ok(!text.includes(leak), leak);
  // Odd values and other events: nothing.
  assert.equal(send.schemaRecord({ hook_event_name: 'UserPromptExpansion', expansion_type: 'Rm -rf /' }, 's', {}).expansion_type, undefined);
  assert.equal(send.schemaRecord({ hook_event_name: 'Stop', expansion_type: 'slash_command' }, 's', {}).expansion_type, undefined);
});

test('schema probe reports CLAUDE_CONFIG_DIR visibility as booleans only', () => {
  const dir = path.join(os.tmpdir(), '.claude-someone');
  const input = { hook_event_name: 'Stop', transcript_path: path.join(dir, 'projects', 'p', 't.jsonl') };
  const rec = send.schemaRecord(input, 's', { CLAUDE_CONFIG_DIR: dir });
  assert.equal(rec.env_config_dir, true);
  assert.equal(rec.transcript_in_config_dir, true);
  assert.ok(!JSON.stringify(rec).includes('someone'));
  const none = send.schemaRecord(input, 's', {});
  assert.equal(none.env_config_dir, false);
  assert.equal(none.transcript_in_config_dir, undefined);
});

// ------------------------------------------------------------- allowlist

test('allowlist: unknown fields from a future Claude Code never reach the output', () => {
  const future = {
    session_id: 's1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_use_id: 't1',
    tool_input: { file_path: '/p/a.js', future_flag: 'LEAK-1', content: 'LEAK-2' },
    future_top_level: 'LEAK-3',
    account_email: 'LEAK-4@example.com',
    api_key: 'LEAK-5',
    prompt: 'LEAK-6',
    nested: { deep: 'LEAK-7' },
  };
  for (const event of ['PreToolUse', 'PostToolUse', 'Notification', 'SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop']) {
    const payload = send.buildPayload({ ...future, agent_id: 'agent-1', agent_type: 'Explore', hook_event_name: event });
    for (const key of Object.keys(payload)) assert.ok(key in send.PAYLOAD_FIELDS, `${event}: unexpected key ${key}`);
    assert.ok(!JSON.stringify(payload).includes('LEAK'), `${event}: ${JSON.stringify(payload)}`);
    for (const value of Object.values(payload)) assert.ok(['string', 'number'].includes(typeof value), `${event}: ${typeof value}`);
  }
});

test('allowlist: the final filter drops anything not listed, objects and non-finite numbers', () => {
  const out = send.allowlisted({
    v: 1,
    event: 'Stop',
    session: 's',
    ts: 5,
    detail: 'ok',
    injected: 'x',
    tool: { name: 'Edit' },
    id: ['a'],
    kind: null,
    reason: NaN,
  });
  assert.deepEqual(out, { v: 1, event: 'Stop', session: 's', ts: 5, detail: 'ok' });
  assert.deepEqual(
    Object.keys(send.PAYLOAD_FIELDS),
    ['v', 'event', 'session', 'ts', 'tool', 'id', 'detail', 'kind', 'source', 'reason', 'agent', 'agentType', 'skill', 'account', 'pid'],
  );
});

// ------------------------------------------------------------- Claude Code's pid

test('pid: only on SessionStart, only a positive integer', () => {
  const start = send.buildPayload({ hook_event_name: 'SessionStart', session_id: 's', source: 'startup' }, null, 1, { pid: 10552 });
  assert.equal(start.pid, 10552);
  assert.equal(typeof start.pid, 'number');
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd', 'Notification']) {
    const p = send.buildPayload({ hook_event_name: event, session_id: 's', tool_name: 'Read' }, null, 1, { pid: 10552 });
    assert.equal(p.pid, undefined, event);
  }
  for (const bad of [0, -1, 1.5, '10552', NaN, 2 ** 40, null, { pid: 1 }]) {
    const p = send.buildPayload({ hook_event_name: 'SessionStart', session_id: 's' }, null, 1, { pid: bad });
    assert.equal(p.pid, undefined, String(bad));
  }
  // A pid in the hook input itself is ignored: only the one the hook found counts.
  const input = send.buildPayload({ hook_event_name: 'SessionStart', session_id: 's', pid: 7, process_id: 8 });
  assert.equal(input.pid, undefined);
});

test('pid: walk up through shells to Claude Code, or give up', () => {
  const chain = (...rows) => new Map(rows.map(([pid, ppid, name]) => [pid, { ppid, name }]));
  // Windows, hooks through Git Bash (its launcher and bash itself), native claude.exe.
  const gitBash = chain([30, 20, 'bash.exe'], [20, 10, 'bash.exe'], [10, 5, 'claude.exe'], [5, 1, 'powershell.exe'], [1, 0, 'WindowsTerminal.exe']);
  assert.equal(send.claudePidFrom(30, gitBash), 10, 'stops at claude.exe, not at the shell above it');
  // PowerShell instead of Git Bash; cmd in between.
  assert.equal(send.claudePidFrom(31, chain([31, 21, 'powershell.exe'], [21, 11, 'cmd.exe'], [11, 2, 'Claude.EXE'])), 11);
  // Installed with npm: node runs the CLI.
  assert.equal(send.claudePidFrom(32, chain([32, 12, 'bash'], [12, 3, 'node'])), 12);
  // VS Code: the extension host starts claude.exe.
  assert.equal(send.claudePidFrom(33, chain([33, 13, 'bash.exe'], [13, 4, 'claude.exe'], [4, 1, 'Code.exe'])), 13);
  // Run by hand from a terminal: the first non-shell is the terminal, not Claude Code.
  assert.equal(send.claudePidFrom(34, chain([34, 14, 'bash.exe'], [14, 1, 'WindowsTerminal.exe'])), null);
  assert.equal(send.claudePidFrom(35, chain([35, 15, 'pwsh.exe'], [15, 1, 'Code.exe'])), null);
  // A gap in the chain, a loop of shells, a bad pid.
  assert.equal(send.claudePidFrom(36, chain([36, 99, 'bash.exe'])), null);
  assert.equal(send.claudePidFrom(37, chain([37, 37, 'sh'])), null);
  assert.equal(send.claudePidFrom(0, chain([0, 1, 'claude'])), null);
  // The PowerShell output format.
  const parsed = send.parseChain('30|20|bash.exe\r\n20|10|bash.exe\n10|5|claude.exe\n\njunk\n');
  assert.deepEqual([...parsed.keys()], [30, 20, 10]);
  assert.equal(send.claudePidFrom(30, parsed), 10);
});

test('pid: the real lookup never throws and answers in time', async () => {
  const started = Date.now();
  const pid = await send.findClaudePid();
  assert.ok(pid === null || (Number.isInteger(pid) && pid > 0));
  assert.ok(Date.now() - started < 2500);
  assert.equal(await send.findClaudePid(0), null);
});
