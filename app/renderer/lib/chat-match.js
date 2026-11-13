/*
 * Chat: maps a typed question to one of the ready-made ones (app/chat.js
 * INTENTS), in Turkish or English. Pure logic, no DOM: the same file runs in
 * the page (window.BuddyChatMatch) and in node:test.
 *
 * The typed text never leaves the page: only the intent it matched (or
 * "unknown") is passed on. It is not stored or logged.
 *
 * How: lower case, Turkish letters folded to ASCII (ç -> c, ğ -> g, ı / İ -> i,
 * ö -> o, ş -> s, ü -> u), punctuation dropped. Each intent has rules; a rule
 * is a few word stems, and matches when every stem starts some word of the
 * text, so Turkish suffixes do not matter ("çalışıyorsun" starts with "calis").
 * Longer rules weigh more; the intent with the highest score wins.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyChatMatch = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /** Longest text that is looked at. */
  const MAX_INPUT = 120;

  const RULES = {
    doing: [
      'ne yap', 'napiyo', 'napion', 'naber', 'nabiyo', 'neyle ugras', 'ne ile ugras', 'ne is', 'mesgul', 'durum',
      'what doing', 'what up', 'doing', 'status', 'busy', 'working on', 'up to',
    ],
    duration: [
      'ne kadar', 'ne zamandir', 'ne zamandan', 'kac dakika', 'kac saat', 'kac saniye', 'suredir', 'ne sure', 'zamandir',
      'how long', 'since when', 'duration', 'minutes', 'hours',
    ],
    tools: ['kac arac', 'kadar arac', 'arac', 'how many tool', 'tool', 'tools'],
    agents: [
      'alt ajan', 'ajan', 'kac ajan', 'yardimci', 'kac kisi', 'kimse var', 'yalniz misin',
      'sub agent', 'subagent', 'agent', 'how many agent', 'helper',
    ],
    skill: ['skill', 'beceri', 'yetenek', 'kitap', 'which skill', 'book', 'slash'],
    waiting: ['bekl', 'neyi bekl', 'ne bekl', 'onay', 'izin', 'wait', 'waiting for', 'approval', 'permission'],
    done: ['bitti', 'bitir', 'bitmedi', 'tamam', 'is bitti', 'hazir mi', 'sonuc', 'done', 'finish', 'complete', 'ready'],
  };
  /** On a tie, the more specific question wins. */
  const PRIORITY = ['skill', 'agents', 'tools', 'waiting', 'done', 'duration', 'doing'];

  const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

  /** "Ne kadardır ÇALIŞIYORSUN?" -> "ne kadardir calisiyorsun" */
  function normalize(text) {
    if (typeof text !== 'string') return '';
    return text
      .slice(0, MAX_INPUT)
      .replace(/İ/g, 'i')
      .replace(/I/g, 'i')
      .toLowerCase()
      .replace(/[çğıöşüâîû]/g, (c) => FOLD[c])
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const COMPILED = Object.fromEntries(
    Object.entries(RULES).map(([intent, rules]) => [intent, rules.map((rule) => normalize(rule).split(' '))]),
  );

  /** Score per intent for a text (0 = no rule matched). */
  function scores(text) {
    const words = normalize(text).split(' ').filter(Boolean);
    const out = {};
    for (const [intent, rules] of Object.entries(COMPILED)) {
      let score = 0;
      for (const stems of rules) {
        if (stems.every((stem) => words.some((word) => word.startsWith(stem)))) score += stems.length;
      }
      out[intent] = score;
    }
    return out;
  }

  /**
   * Hands (opt-in): "aç", "sekme aç", "yeni sekme", "open a new tab" -> 'newtab';
   * "kapat", "sekmeyi kapat", "close the tab" -> 'closetab'. Whole words only and
   * short texts only, so a longer question never turns into a command.
   */
  function handIntent(text) {
    const words = normalize(text).split(' ').filter(Boolean);
    if (!words.length || words.length > 6) return null;
    const has = (w) => words.includes(w);
    const starts = (p) => words.some((w) => w.startsWith(p));
    if (has('kapat') || has('kapa') || starts('kapatir') || starts('kapatsana') || has('close')) return 'closetab';
    if (has('ac') || has('open') || (has('new') && has('tab')) || (has('yeni') && starts('sekme')) || (starts('acar') && starts('sekme'))) {
      return 'newtab';
    }
    return null;
  }

  /** The intent a typed question means, or null when it is none of them. */
  function matchIntent(text, { hands = false } = {}) {
    if (hands) {
      const command = handIntent(text);
      if (command) return command;
    }
    const s = scores(text);
    let best = null;
    for (const intent of PRIORITY) if (s[intent] > 0 && (best === null || s[intent] > s[best])) best = intent;
    return best;
  }

  /** How long an answer stays in the bubble: long enough to read it (ms). */
  function answerMs(text) {
    const length = typeof text === 'string' ? text.length : 0;
    return Math.max(3200, Math.min(8000, 2400 + length * 60));
  }

  return { normalize, matchIntent, handIntent, scores, answerMs, MAX_INPUT, RULES };
});
