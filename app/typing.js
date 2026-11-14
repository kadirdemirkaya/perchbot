'use strict';

/**
 * Watching the user type ("Watch me type", opt-in, Windows): main.js asks Windows now and
 * then where the text caret of the window in front is (app/caret.js: in a terminal only,
 * its position only; never any text, never a key). When the caret keeps moving in the same
 * place, the user is typing. Now and then (not every time: the dice, once per typing spell,
 * and a gap between two visits) the buddy flies over, stays just above that line (the line
 * itself stays free) and reads along through its magnifier, moving along when the caret
 * gets away. When the typing stops (or the prompt is sent: Claude Code starts on it), a
 * light bulb goes on above its head: it got it. Then it flies back.
 *
 * Pure: the caller passes the samples and the time (and may pass the dice).
 */

const { SLOT } = require('./placement');

const TYPING = Object.freeze({
  /** How often main.js asks where the caret is while the buddy may come (ms). */
  sampleMs: 400,
  /** ...and while it is there, reading along. */
  visitSampleMs: 250,
  /** A caret move: this far (DIP) or more, in the same field. */
  moveMin: 3,
  /** A typing spell: this many moves... */
  spellMoves: 4,
  /** ...each within this long of the one before (a longer pause: a new spell). */
  spellGapMs: 4000,
  /** It comes for a spell at this chance (rolled once per spell): about every second or third time. */
  chance: 0.4,
  /** At least this long between two visits: once a minute at most. */
  gapMs: 60000,
  /** Still typing after a "no": the dice again this long after it (a long spell gets more chances). */
  rerollMs: 8000,
  /** Offered again this often while the spell goes on (the page may have been busy). */
  retryMs: 3000,
  /** A spell offered this long ago is no reason for a trip any more. */
  freshMs: 4000,
  /** Not when the caret is right next to the buddy (DIP). */
  nearBuddy: 240,
  /** Once there it reads at least this long before the light bulb... */
  lookMinMs: 2600,
  /** ...and the typing is over when the caret has not moved for this long. */
  doneMs: 1800,
  /** The caret has been gone (another window, nothing in front) for this many samples: done. */
  goneSamples: 3,
  /** The caret went this far (DIP) from the spot it reads: it moves along (a short flight)... */
  alongPx: 300,
  /** ...or to another line this far up or down... */
  alongLinePx: 90,
  /** ...at most this many times per visit. */
  alongMax: 3,
  /** Never longer than this there. */
  maxVisitMs: 30000,
  /** The light bulb, then back. */
  ahaMs: 2000,
  /** Between its feet and the line it reads (DIP at medium size). */
  standGap: 6,
  /** Its slot's left edge this far right of the caret (DIP at medium size). */
  standRight: 24,
});

/** What Claude Code may be doing meanwhile (as app/follow.js FOLLOW_STATES): not while it waits for the user. */
const TYPING_STATES = new Set(['idle', 'standby', 'greeting', 'typing', 'reading', 'running', 'working', 'thinking', 'done']);

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** A caret sample ({ x, y, w, h, field }, screen DIP) or null. */
function validCaret(caret) {
  if (!caret || !finite(caret.x) || !finite(caret.y)) return null;
  return {
    x: caret.x,
    y: caret.y,
    w: finite(caret.w) && caret.w > 0 ? caret.w : 0,
    h: finite(caret.h) && caret.h > 0 ? caret.h : 0,
    field: caret.field === undefined ? null : caret.field,
  };
}

const moved = (a, b, min) => Math.abs(a.x - b.x) >= min || Math.abs(a.y - b.y) >= min;

/** Is the user typing, and is it time to go and look? */
class TypingWatch {
  constructor({ random = Math.random, ...options } = {}) {
    this.o = { ...TYPING, ...options };
    this.random = random;
    this.lastVisit = -Infinity;
    this.hold();
  }

  /** Not watching for a while (busy, away, switched off): the spell starts over. */
  hold() {
    this.last = null;
    this.spell = null;
    this.offered = -Infinity;
  }

  /**
   * One sample of the caret.
   * @param {object|null} caret  { x, y, w, h, field } screen DIP; null: no caret (not a terminal in front)
   * @param {number} now  ms
   * @param {{x:number,y:number}|null} [buddy]  the buddy's anchor (feet), screen DIP
   * @returns {{x:number,y:number,w:number,h:number}|null}  where to go and look (offered again every retryMs during the spell)
   */
  sample(caret, now, buddy = null) {
    const c = validCaret(caret);
    const prev = this.last;
    this.last = c;
    if (!c || !prev || prev.field !== c.field) {
      this.spell = null;
      return null;
    }
    if (this.spell && now - this.spell.last > this.o.spellGapMs) this.spell = null;
    if (!moved(c, prev, this.o.moveMin)) return null;
    if (!this.spell) this.spell = { moves: 0, last: now, go: null, reroll: null };
    this.spell.moves += 1;
    this.spell.last = now;
    if (this.spell.moves < this.o.spellMoves) return null;
    if (now - this.lastVisit < this.o.gapMs) return null;
    // Not every time: the dice once per spell, and again now and then while a long spell goes on.
    if (this.spell.go === null || (!this.spell.go && this.spell.reroll !== null && now >= this.spell.reroll)) {
      this.spell.go = this.random() < this.o.chance;
      this.spell.reroll = this.spell.go ? null : now + this.o.rerollMs;
    }
    if (!this.spell.go) return null;
    if (buddy && Math.hypot(c.x - buddy.x, c.y - buddy.y) < this.o.nearBuddy) return null;
    if (now - this.offered < this.o.retryMs) return null;
    this.offered = now;
    return { x: c.x, y: c.y, w: c.w, h: c.h };
  }

  /** It went to look: nothing more for this spell, and the gap starts. */
  visited(now) {
    this.lastVisit = now;
    if (this.spell) {
      this.spell.go = false;
      this.spell.reroll = now + this.o.gapMs;
    }
    this.offered = -Infinity;
  }
}

/** One visit: it reads along until the typing is over. */
class TypingVisit {
  /** @param {{ start: number, caret: object }} p  when it arrived, and the caret it came for */
  constructor({ start, caret, ...options }) {
    this.o = { ...TYPING, ...options };
    this.start = start;
    this.lastMove = start;
    this.spot = validCaret(caret);
    this.prev = this.spot;
    this.gone = 0;
  }

  /**
   * One sample while it is there.
   * @returns {null|'along'|'aha'}  keep reading; move along to the caret; the typing is over
   */
  sample(caret, now) {
    if (now - this.start >= this.o.maxVisitMs) return 'aha';
    const looked = now - this.start >= this.o.lookMinMs;
    const c = validCaret(caret);
    if (!c) {
      this.gone += 1;
      return looked && this.gone >= this.o.goneSamples ? 'aha' : null;
    }
    this.gone = 0;
    // Typing somewhere else now (another field, another tab): done here.
    if (this.prev && this.prev.field !== c.field) return looked ? 'aha' : null;
    if (this.prev && moved(c, this.prev, this.o.moveMin)) this.lastMove = now;
    this.prev = c;
    if (this.spot && (Math.abs(c.x - this.spot.x) > this.o.alongPx || Math.abs(c.y - this.spot.y) > this.o.alongLinePx)) return 'along';
    return looked && now - this.lastMove >= this.o.doneMs ? 'aha' : null;
  }

  /** It moved along: this caret is the spot it reads now. */
  movedTo(caret) {
    const c = validCaret(caret);
    if (c) this.spot = c;
  }
}

/**
 * Where it stands to read along (its anchor: the bottom middle of its slot, screen DIP):
 * just above the line, a little to the right of the caret, so the line itself stays
 * free; with no room above (a line near the top of the screen), just below it.
 */
function standBy(caret, workArea, scale = 1) {
  const c = validCaret(caret);
  if (!c || !workArea) return null;
  const s = Number(scale) || 1;
  const height = SLOT.height * s;
  const x = c.x + c.w + TYPING.standRight * s + (SLOT.width / 2) * s;
  const above = c.y - TYPING.standGap * s;
  const y = above - height >= workArea.y ? above : c.y + c.h + TYPING.standGap * s + height;
  return { x: Math.round(x), y: Math.round(y) };
}

module.exports = { TYPING, TYPING_STATES, TypingWatch, TypingVisit, standBy, validCaret };
