'use strict';

/** The chat: answers from what the overlay knows (app/chat.js), typed questions (lib/chat-match.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../app/chat');
const { normalize, matchIntent, answerMs, MAX_INPUT } = require('../app/renderer/lib/chat-match');
const { LOCALES } = require('../app/i18n');

const NOW = 1_000_000;
const facts = (extra = {}) => ({
  now: NOW,
  state: 'idle',
  message: null,
  turnActive: false,
  turn: null,
  agents: [],
  skill: null,
  waiting: null,
  lastDoneAt: null,
  sessions: 1,
  ...extra,
});
const turn = (extra = {}) => ({ startedAt: NOW - 125000, tools: 7, last: null, endedAt: null, ...extra });
const tr = (intent, f) => chat.answer(intent, f, 'tr');
const en = (intent, f) => chat.answer(intent, f, 'en');

test('chat: every question and answer exists in English and Turkish', () => {
  for (const lang of ['en', 'tr']) {
    const strings = chat.panelStrings(lang);
    assert.deepEqual(strings.questions.map((q) => q.id), [...chat.INTENTS]);
    for (const q of strings.questions) assert.ok(q.label && !q.label.startsWith('q_'), `${lang} ${q.id}`);
  }
  assert.deepEqual(Object.keys(LOCALES.tr.chat).sort(), Object.keys(LOCALES.en.chat).sort(), 'same keys in both');
  assert.equal(chat.panelStrings('tr').questions[0].label, 'Ne yapıyorsun?');
  // Buttons only: no "Type…" field any more.
  assert.equal(chat.panelStrings('tr').type, undefined);
  assert.equal(LOCALES.en.chat.placeholder, undefined);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'renderer', 'index.html'), 'utf8');
  assert.ok(!/<input\b/.test(html), 'no text field in the page');
});

test('chat: durations read naturally', () => {
  const t = (key, vars) => require('../app/i18n').translate('tr', 'chat', key, vars);
  assert.equal(chat.formatDuration(45000, t), '45 sn');
  assert.equal(chat.formatDuration(125000, t), '2 dk 5 sn');
  assert.equal(chat.formatDuration(120000, t), '2 dk');
  assert.equal(chat.formatDuration(3 * 3600000 + 20 * 60000, t), '3 sa 20 dk');
  assert.equal(chat.formatDuration(-5, t), '0 sn');
});

test('chat: "what are you doing" follows the state and the current tool', () => {
  assert.equal(tr('doing', facts({ state: 'typing', turnActive: true, turn: turn({ last: { tool: 'Edit', detail: 'main.js' } }) })), 'main.js dosyasını düzenliyorum.');
  assert.equal(en('doing', facts({ state: 'reading', turnActive: true, turn: turn({ last: { tool: 'Read', detail: 'core.js' } }) })), "I'm reading core.js.");
  assert.equal(en('doing', facts({ state: 'reading', turnActive: true, turn: turn({ last: { tool: 'Grep', detail: 'TODO' } }) })), "I'm searching through the files.");
  assert.equal(tr('doing', facts({ state: 'running', turnActive: true, turn: turn({ last: { tool: 'Bash', detail: 'npm test' } }) })), 'Bir komut çalıştırıyorum: npm test');
  assert.equal(en('doing', facts({ state: 'working', turnActive: true, turn: turn({ last: { tool: 'mcp__github__list', detail: null } }) })), "I'm using github.");
  assert.equal(en('doing', facts({ state: 'thinking', turnActive: true })), 'Thinking, planning the next step.');
  assert.equal(tr('doing', facts({ state: 'waiting' })), 'Onayını bekliyorum.');
  assert.equal(tr('doing', facts()), 'Şu an boştayım, yeni bir iş bekliyorum.');
  assert.equal(en('doing', facts({ agents: ['Explore', 'Plan'] })), 'Nothing myself, 2 helpers are working.');
});

test('chat: how long, how many tools: the current turn, else the last one, else none yet', () => {
  assert.equal(tr('duration', facts({ turnActive: true, turn: turn() })), '2 dk 5 sn süredir bu iş üzerindeyim.');
  assert.equal(
    en('duration', facts({ turn: turn({ endedAt: NOW - 30000 }) })),
    "I'm not working right now. The last task took 1 min 35 s and finished 30 s ago.",
  );
  assert.equal(tr('duration', facts()), 'Bu oturumda henüz bir iş yapmadım.');
  assert.equal(tr('tools', facts({ turnActive: true, turn: turn() })), 'Bu turda 7 araç kullandım.');
  assert.equal(en('tools', facts({ turnActive: true, turn: turn({ tools: 1 }) })), '1 tool so far in this turn.');
  assert.equal(en('tools', facts({ turnActive: true, turn: turn({ tools: 0 }) })), 'No tools yet in this turn.');
  assert.equal(tr('tools', facts({ turn: turn({ endedAt: NOW }) })), 'Son turda 7 araç kullandım.');
  assert.equal(en('tools', facts()), 'No tools used yet.');
});

test('chat: helpers, skill, waiting, done: polite answers also when there is nothing to tell', () => {
  assert.equal(tr('agents', facts()), 'Şu an alt ajan yok.');
  assert.equal(tr('agents', facts({ agents: ['Explore'] })), 'Bir alt ajan çalışıyor: Explore.');
  assert.equal(en('agents', facts({ agents: ['Explore', 'Explore', 'Plan'] })), '3 sub-agents are working: Explore, Plan.');
  assert.equal(tr('skill', facts()), 'Şu an bir skill kullanmıyorum.');
  assert.equal(en('skill', facts({ skill: 'pdf' })), "I'm using the pdf skill.");
  assert.equal(tr('waiting', facts({ state: 'waiting', waiting: 'permission_prompt' })), 'Bir izin için onayını bekliyorum.');
  assert.equal(en('waiting', facts({ state: 'standby', waiting: 'idle_prompt' })), 'Your next message.');
  assert.equal(en('waiting', facts({ state: 'standby', waiting: 'something_new' })), 'You to look at a notification.');
  assert.equal(tr('waiting', facts({ turnActive: true })), 'Hiçbir şey beklemiyorum, çalışıyorum.');
  assert.equal(tr('waiting', facts()), 'Senden yeni bir iş bekliyorum.');
  assert.equal(tr('done', facts({ turnActive: true })), 'Henüz değil, hâlâ çalışıyorum.');
  assert.equal(tr('done', facts({ agents: ['Explore'] })), 'Ana iş bitti, ama bir alt ajan hâlâ çalışıyor.');
  assert.equal(en('done', facts({ lastDoneAt: NOW - 90000 })), 'Yes, it finished 1 min 30 s ago.');
  assert.equal(en('done', facts()), 'No work yet in this session.');
  assert.equal(tr('nonsense', facts()), 'Bunu bilmiyorum, ama şunları sorabilirsin.');
  // Answers stay short enough for the bubble (four lines at most).
  for (const lang of ['en', 'tr']) for (const text of Object.values(LOCALES[lang].chat)) assert.ok(text.length <= 90, text);
});

test('chat: helpers without a known type are still counted', () => {
  assert.equal(tr('agents', facts({ agents: [null] })), 'Bir alt ajan çalışıyor.');
  assert.equal(en('agents', facts({ agents: [null, null] })), '2 sub-agents are working.');
});

test('chat: requests from the page are checked; a question carries only its intent', () => {
  assert.deepEqual(chat.parseChatRequest({ op: 'open' }), { op: 'open' });
  assert.deepEqual(chat.parseChatRequest({ op: 'close', extra: 'x' }), { op: 'close' });
  assert.equal(chat.parseChatRequest({ op: 'type' }), null, 'no typing any more');
  assert.equal(chat.parseChatRequest({ op: 'untype' }), null);
  assert.deepEqual(chat.parseChatRequest({ op: 'ask', intent: 'tools' }), { op: 'ask', intent: 'tools' });
  assert.deepEqual(chat.parseChatRequest({ op: 'ask', intent: 'unknown', text: 'secret' }), { op: 'ask', intent: 'unknown' });
  for (const bad of [null, 'open', {}, { op: 'shout' }, { op: 'ask' }, { op: 'ask', intent: 'what are you doing' }, { op: 'ask', intent: 7 }]) {
    assert.equal(chat.parseChatRequest(bad), null, JSON.stringify(bad));
  }
});

test('chat: the bridge sends an op and an intent, never typed text', () => {
  const Module = require('node:module');
  const sent = [];
  let api = null;
  const fake = {
    contextBridge: { exposeInMainWorld: (_name, value) => (api = value) },
    ipcRenderer: { send: (channel, data) => sent.push([channel, data]), on: () => {} },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? fake : load.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve('../app/preload')];
    require('../app/preload');
  } finally {
    Module._load = load;
  }
  api.chat('open', 'ignored');
  api.chat('ask', 'doing');
  api.chat('ask', 'ne yapıyorsun?');
  api.chat('ask', 'x'.repeat(40));
  api.chat('ask', { text: 'hi' });
  api.chat('say', 'hello');
  assert.deepEqual(sent, [
    ['buddy:chat', { op: 'open' }],
    ['buddy:chat', { op: 'ask', intent: 'doing' }],
  ]);
});

test('chat: an answer stays long enough to read', () => {
  assert.equal(answerMs('Hi'), 3200);
  assert.ok(answerMs('x'.repeat(60)) > answerMs('x'.repeat(30)));
  assert.equal(answerMs('x'.repeat(500)), 8000);
  assert.equal(answerMs(null), 3200);
});

test('typed questions: normalised (Turkish letters, case, punctuation)', () => {
  assert.equal(normalize('Ne kadardır ÇALIŞIYORSUN?'), 'ne kadardir calisiyorsun');
  assert.equal(normalize('İŞ BİTTİ Mİ?!'), 'is bitti mi');
  assert.equal(normalize('  Şu   ağaç  '), 'su agac');
  assert.equal(normalize(null), '');
  assert.equal(normalize('x'.repeat(500)).length, MAX_INPUT);
});

test('typed questions: Turkish sentences map to the ready-made questions', () => {
  const cases = {
    'Ne yapıyorsun?': 'doing',
    'napıyon': 'doing',
    'şu an neyle uğraşıyorsun': 'doing',
    'ne kadardır çalışıyorsun': 'duration',
    'kaç dakikadır bu işte': 'duration',
    'kaç araç kullandın?': 'tools',
    'ne kadar araç kullandın': 'tools',
    'alt ajan var mı': 'agents',
    'yardımcıların nerede': 'agents',
    'hangi skill': 'skill',
    'hangi skilli kullanıyorsun': 'skill',
    'neyi bekliyorsun': 'waiting',
    'onay mı bekliyorsun?': 'waiting',
    'iş bitti mi': 'done',
    'bitirdin mi artık': 'done',
  };
  for (const [text, intent] of Object.entries(cases)) assert.equal(matchIntent(text), intent, text);
});

test('typed questions: English sentences too; anything else is unknown', () => {
  const cases = {
    'What are you doing?': 'doing',
    "what're you up to": 'doing',
    'How long have you been working on this?': 'duration',
    'how many tools did you use': 'tools',
    'Any sub-agents?': 'agents',
    'how many agents are there': 'agents',
    'Which skill?': 'skill',
    'what are you waiting for': 'waiting',
    'Is it done?': 'done',
    'are you finished': 'done',
  };
  for (const [text, intent] of Object.entries(cases)) assert.equal(matchIntent(text), intent, text);
  for (const text of ['merhaba', 'hava nasıl', "what's the weather", 'tell me a joke', '', '???']) {
    assert.equal(matchIntent(text), null, text);
  }
});
