/*
 * Fun mode logic for the overlay page. Pure, injectable clock and random, so
 * the same file runs in the renderer (window.BuddyFun) and in node:test.
 *
 *   ClickMeter        quick hits in a row: "annoyed", then "flee"
 *   AmbientScheduler  ambient life: short plays and trips, every 20-90 s
 *   pickCheer      a different celebration for "done" now and then
 *   Duel           the sword fight started from the right-click menu
 *
 * None of this runs by itself: the page feeds it clicks, states and time, and
 * turns its callbacks into data-* attributes for the character's CSS.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyFun = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    now: () => Date.now(),
  };

  // ------------------------------------------------------------------ clicks

  /**
   * Counts hits that come quickly one after another (each within `gapMs` of
   * the previous one): the second one annoys the character, the third one is
   * too much and it leaves; then the count starts over.
   * click() returns 'boop' | 'annoyed' | 'flee'.
   */
  class ClickMeter {
    constructor({ clock = realClock, gapMs = 1100, annoyAt = 2, fleeAt = 3 } = {}) {
      this.clock = clock;
      this.gapMs = gapMs;
      this.annoyAt = annoyAt;
      this.fleeAt = fleeAt;
      this.count = 0;
      this.last = -Infinity;
    }

    click() {
      const now = this.clock.now();
      this.count = now - this.last <= this.gapMs ? this.count + 1 : 1;
      this.last = now;
      if (this.count >= this.fleeAt) {
        this.count = 0;
        return 'flee';
      }
      return this.count >= this.annoyAt ? 'annoyed' : 'boop';
    }

    reset() {
      this.count = 0;
    }
  }

  // ------------------------------------------------------------------ ambient life

  /** Short plays (ms): what the character does by itself, on the spot. */
  const PLAYS = Object.freeze({
    stretch: 2600,
    look: 2400,
    peek: 2800,
    hum: 3200,
    jump: 1400,
    ball: 4200,
    antenna: 2600,
  });

  /** Trips around the screen (main.js plans them, see app/roam.js). */
  const TRIPS = Object.freeze({ walk: 'stroll', fly: 'hop', inspect: 'inspect', home: 'home' });

  /** Relative chances. Every play counts 1. */
  const WEIGHTS = Object.freeze({ walk: 1.6, fly: 1.1, inspect: 0.8, home: 1.4 });

  /**
   * Ambient life: while allowed (idle, awake, nothing else going on), every
   * 20-90 s one short behaviour, never the same one twice in a row:
   *   a play on the spot   onPlay(name), then onPlay(null) when it is over
   *   a trip               onTrip(kind) asks the main process to move
   * update() with enabled = false (an event, the pointer, rest, a drag, a
   * duel...) ends a play at once and cancels the next one.
   */
  class AmbientScheduler {
    constructor({ clock = realClock, random = Math.random, minMs = 20000, maxMs = 90000, onPlay = () => {}, onTrip = () => {} } = {}) {
      this.clock = clock;
      this.random = random;
      this.minMs = minMs;
      this.maxMs = maxMs;
      this.onPlay = onPlay;
      this.onTrip = onTrip;
      this.allowed = { enabled: false, trips: false, away: false };
      this.playing = null;
      this.last = null;
      this.timer = null;
    }

    /**
     * @param {{ enabled: boolean, trips?: boolean, away?: boolean }} next
     *   trips: moving around is allowed (no helpers, no cat); away: not at home
     */
    update({ enabled, trips = false, away = false }) {
      const was = this.allowed.enabled;
      this.allowed = { enabled: Boolean(enabled), trips: Boolean(trips), away: Boolean(away) };
      if (!this.allowed.enabled) {
        this.stop();
        this.cancel();
        return;
      }
      if (!was || (!this.timer && !this.playing)) this.schedule();
    }

    /** The behaviours possible right now, without the previous one. */
    choices() {
      const out = Object.keys(PLAYS).map((name) => [name, 1]);
      if (this.allowed.trips) {
        for (const kind of Object.keys(TRIPS)) {
          if (kind === 'home' && !this.allowed.away) continue;
          out.push([kind, WEIGHTS[kind]]);
        }
      }
      return out.filter(([name]) => name !== this.last);
    }

    schedule() {
      this.cancel();
      const delay = this.minMs + this.random() * (this.maxMs - this.minMs);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        if (this.allowed.enabled) this.run(pickWeighted(this.choices(), this.random));
      }, delay);
    }

    /** Start one behaviour now (also used by the simulator). */
    run(name) {
      this.cancel();
      this.last = name;
      if (TRIPS[name]) {
        this.onTrip(TRIPS[name]);
        if (this.allowed.enabled) this.schedule();
        return;
      }
      if (!PLAYS[name]) return;
      this.playing = name;
      this.onPlay(name);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.playing = null;
        this.onPlay(null);
        if (this.allowed.enabled) this.schedule();
      }, PLAYS[name]);
    }

    /** End the current play at once. */
    stop() {
      if (!this.playing) return;
      this.cancel();
      this.playing = null;
      this.onPlay(null);
    }

    cancel() {
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  function pickWeighted(entries, random) {
    let pick = random() * entries.reduce((sum, [, w]) => sum + w, 0);
    for (const [name, w] of entries) if ((pick -= w) < 0) return name;
    return entries[entries.length - 1][0];
  }

  // ------------------------------------------------------------------ cheers

  const CHEERS = ['jump', 'spin', 'dance', 'fist'];

  /** "done": the classic jump half of the time, otherwise one of the others. */
  function pickCheer(random = Math.random) {
    if (random() < 0.5) return 'jump';
    return CHEERS[1 + Math.floor(random() * (CHEERS.length - 1))];
  }

  // ------------------------------------------------------------------ duel

  const DUEL_TIMINGS = Object.freeze({
    drawMs: 900,
    guardMinMs: 900,
    guardMaxMs: 1800,
    windupMs: 650,
    strikeMs: 240,
    recoverMs: 800,
    /** After a parry the robot is off balance for longer. */
    stunMs: 1200,
    blockMs: 380,
    hurtMs: 520,
    hitMs: 520,
    endMs: 2600,
    /** The whole duel never lasts longer than this. */
    maxMs: 75000,
    hearts: 3,
  });

  /**
   * A tiny sword fight. The robot loops: guard -> windup -> strike -> recover.
   *   Click while it recovers (or is stunned)  -> you hit it (it loses a heart)
   *   Click during the windup                  -> parry: it is stunned, an opening
   *   Click while it guards                    -> blocked; it strikes back at once
   *   No click before its strike lands         -> you lose a heart
   * Three hearts each. onPhase(phase, info) for every change:
   *   draw | guard | windup | strike | recover | stun | block | hurt | hit | win | lose | end
   * 'win' = the robot won, 'lose' = the robot lost. stop(reason) ends at once.
   */
  class Duel {
    constructor({ clock = realClock, random = Math.random, timings = {}, onPhase = () => {} } = {}) {
      this.clock = clock;
      this.random = random;
      this.t = { ...DUEL_TIMINGS, ...timings };
      this.onPhase = onPhase;
      this.phase = null;
      this.timer = null;
      this.limit = null;
      this.robot = 0;
      this.player = 0;
    }

    get active() {
      return this.phase !== null;
    }

    start() {
      this.stop();
      this.robot = this.t.hearts;
      this.player = this.t.hearts;
      this.limit = this.clock.setTimeout(() => this.finish('end'), this.t.maxMs);
      this.go('draw', this.t.drawMs, () => this.guard());
    }

    /** The user clicked the robot. */
    click() {
      switch (this.phase) {
        case 'recover':
        case 'stun':
          this.robot -= 1;
          if (this.robot <= 0) this.finish('lose');
          else this.go('hurt', this.t.hurtMs, () => this.guard());
          return 'hit';
        case 'windup':
          this.go('stun', this.t.stunMs, () => this.guard());
          return 'parry';
        case 'guard':
          this.go('block', this.t.blockMs, () => this.windup());
          return 'blocked';
        default:
          return 'none';
      }
    }

    guard() {
      const ms = this.t.guardMinMs + this.random() * (this.t.guardMaxMs - this.t.guardMinMs);
      this.go('guard', ms, () => this.windup());
    }

    windup() {
      this.go('windup', this.t.windupMs, () =>
        this.go('strike', this.t.strikeMs, () => {
          // The strike landed: the player loses a heart.
          this.player -= 1;
          if (this.player <= 0) this.finish('win');
          else this.go('hit', this.t.hitMs, () => this.go('recover', this.t.recoverMs, () => this.guard()));
        }),
      );
    }

    /** win | lose | end: a closing pose, then 'end' and the duel is over. */
    finish(result) {
      this.clearTimers();
      if (result === 'end') {
        this.close();
        return;
      }
      this.go(result, this.t.endMs, () => this.close());
    }

    close() {
      this.clearTimers();
      this.phase = 'end';
      this.onPhase('end', this.info());
      this.phase = null;
    }

    /** Stop at once (Esc, a right-click, or Claude Code needs the character). */
    stop() {
      if (!this.active) return;
      this.close();
    }

    go(phase, ms, next) {
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.phase = phase;
      this.onPhase(phase, this.info());
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        next();
      }, ms);
    }

    info() {
      return { robot: this.robot, player: this.player, hearts: this.t.hearts };
    }

    clearTimers() {
      if (this.timer) this.clock.clearTimeout(this.timer);
      if (this.limit) this.clock.clearTimeout(this.limit);
      this.timer = null;
      this.limit = null;
    }
  }

  return { ClickMeter, AmbientScheduler, PLAYS, TRIPS, pickCheer, CHEERS, Duel, DUEL_TIMINGS };
});
