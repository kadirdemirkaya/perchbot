/*
 * Fun mode logic for the overlay page. Pure, injectable clock and random, so
 * the same file runs in the renderer (window.BuddyFun) and in node:test.
 *
 *   TapMeter          quick taps in a row: happy or cross, by mood and by work (tapMood)
 *   Temper            anger that builds up over unwelcome taps: cross, fuming, blazing
 *   Fury              its head on fire twice in five minutes: a rampage
 *   FocusMeter        intense work: a screen of light instead of the laptop
 *   AmbientScheduler  ambient life: short plays and trips, every 15-60 s
 *   pickCheer      a different celebration for "done" now and then
 *   Duel           the sword fight started from the right-click menu
 *   BugFight       the bug hunt: the robot fights a failing check's bug
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

  // ------------------------------------------------------------------ taps

  /**
   * How likely a streak of taps is welcome. Idle it loves being tapped; at
   * work (busy) it mostly does not. Rolled once per streak, so the character
   * keeps one mood for the whole streak instead of flipping from tap to tap.
   */
  const TAP_LIKES = Object.freeze({ calm: 0.8, busy: 0.15 });

  /**
   * One tap's reaction, from the streak's mood:
   *   likes     1st tap: a boop, sometimes a giggle already; then 'happy' (giggles, hearts)
   *   dislikes  1st tap: a boop (busy: often 'annoyed' at once), 2nd: 'annoyed',
   *             3rd: 'flee' (calm: sometimes it only stays cross)
   * Pure: the caller passes the random function (seeded in tests).
   * @param {{ likes: boolean, busy?: boolean, streak: number, random?: () => number }} o
   * @returns {'happy' | 'boop' | 'annoyed' | 'flee'}
   */
  function tapMood({ likes, busy = false, streak, random = Math.random }) {
    if (likes) return streak >= 2 || random() < 0.35 ? 'happy' : 'boop';
    if (streak <= 1) return busy && random() < 0.6 ? 'annoyed' : 'boop';
    if (streak === 2) return 'annoyed';
    return busy || random() < 0.7 ? 'flee' : 'annoyed';
  }

  /** Liked taps in one streak before even a happy character has had enough. */
  const TAP_PATIENCE = 12;

  /**
   * Counts taps that come quickly one after another (each within `gapMs` of
   * the previous one) and asks tapMood what each one does. A new streak rolls
   * its mood from TAP_LIKES; after 'flee' the count starts over.
   * tap(busy, hot) returns 'happy' | 'boop' | 'annoyed' | 'flee'.
   *
   * Two things on top, both only for a lot of tapping:
   *   hot       the character is still angry (Temper.hot): it likes nothing
   *             now, and a tap is never just a boop
   *   patience  after this many liked taps in one streak it has had enough:
   *             'annoyed' (fedUp is true for that tap), and the streak goes on
   *             as an unwelcome one (annoyed, then off it goes)
   */
  class TapMeter {
    constructor({ clock = realClock, random = Math.random, gapMs = 1100, likes = TAP_LIKES, patience = TAP_PATIENCE } = {}) {
      this.clock = clock;
      this.random = random;
      this.gapMs = gapMs;
      this.chances = likes;
      this.patience = patience;
      this.count = 0;
      this.likes = false;
      this.fedUp = false;
      this.last = -Infinity;
    }

    /**
     * @param {boolean} busy  the character is at work right now
     * @param {boolean} hot   it is still angry from earlier taps
     */
    tap(busy = false, hot = false) {
      const now = this.clock.now();
      const streak = this.count > 0 && now - this.last <= this.gapMs;
      this.count = streak ? this.count + 1 : 1;
      this.last = now;
      this.fedUp = false;
      if (hot) this.likes = false;
      else if (!streak) this.likes = this.random() < (busy ? this.chances.busy : this.chances.calm);
      if (this.likes && this.count > this.patience) {
        this.likes = false;
        this.count = 1;
        this.fedUp = true;
        return 'annoyed';
      }
      let mood = tapMood({ likes: this.likes, busy, streak: this.count, random: this.random });
      if (hot && mood === 'boop') mood = 'annoyed';
      if (mood === 'flee') this.count = 0;
      return mood;
    }

    reset() {
      this.count = 0;
    }
  }

  /**
   * How long each level of anger holds before it cools one level (ms).
   *   1  cross (a vein mark): as long as the plain "annoyed" always lasted
   *   2  fuming: red-faced, steam from the ears
   *   3  blazing: its head is on fire
   */
  const TEMPER_HOLD = Object.freeze([0, 1500, 4500, 6000]);
  const TEMPER_MAX = TEMPER_HOLD.length - 1;

  /**
   * Anger that builds up over unwelcome taps and cools down by itself. Every
   * 'annoyed' or 'flee' tap (TapMeter) heats it one level; a level holds for
   * TEMPER_HOLD[level], then drops by one. It outlasts a tap streak and a
   * flight: catch the character soon after it fled and it is still fuming
   * (hot), so the next taps make it blaze, and a flight while it already
   * blazes is an eruption. Pure: the level is worked out from clock.now().
   */
  class Temper {
    constructor({ clock = realClock, hold = TEMPER_HOLD } = {}) {
      this.clock = clock;
      this.hold = hold;
      this.max = hold.length - 1;
      this.heat = 0;
      this.since = 0;
    }

    /** Let the time since the last flare cool it down. */
    cool() {
      const now = this.clock.now();
      while (this.heat > 0 && now - this.since >= this.hold[this.heat]) {
        this.since += this.hold[this.heat];
        this.heat -= 1;
      }
    }

    /** 0 (calm) .. 3 (blazing), right now. */
    get level() {
      this.cool();
      return this.heat;
    }

    /** Still angry enough that taps are not welcome at all (fuming or worse). */
    get hot() {
      return this.level >= 2;
    }

    /**
     * An unwelcome tap ('annoyed' or 'flee'): one level hotter.
     * erupt: it leaves while it was already blazing.
     * @returns {{ level: number, erupt: boolean }}
     */
    flare(verdict) {
      this.cool();
      const before = this.heat;
      this.heat = Math.min(this.max, before + 1);
      this.since = this.clock.now();
      return { level: this.heat, erupt: verdict === 'flee' && before >= this.max };
    }

    /** Time until it cools one level (0 when calm). */
    coolsInMs() {
      this.cool();
      return this.heat > 0 ? Math.max(0, this.since + this.hold[this.heat] - this.clock.now()) : 0;
    }

    reset() {
      this.heat = 0;
    }
  }

  /** Its head catches fire this many times within windowMs: it goes on a rampage. */
  const FURY = Object.freeze({ blazes: 2, windowMs: 5 * 60 * 1000 });

  /**
   * Counts how often its head catches fire (the temper reaches its top level
   * from below). The second time within five minutes is too much: blaze()
   * returns true (a rampage: laser eyes and missiles, see app/rampage.js) and
   * the count starts over. Pure: the clock is injectable.
   */
  class Fury {
    constructor({ clock = realClock, blazes = FURY.blazes, windowMs = FURY.windowMs } = {}) {
      this.clock = clock;
      this.blazes = blazes;
      this.windowMs = windowMs;
      this.times = [];
    }

    /** Its head just caught fire. True: that was once too often. */
    blaze() {
      const now = this.clock.now();
      this.times = this.times.filter((t) => now - t < this.windowMs);
      this.times.push(now);
      if (this.times.length < this.blazes) return false;
      this.times = [];
      return true;
    }

    reset() {
      this.times = [];
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
    antenna: 3200,
    flip: 1700,
    reboot: 3000,
    polish: 3600,
    sneeze: 2700,
    moonwalk: 3400,
    sit: 4200,
  });

  /** Plays that need the ground under its feet (not while it hovers or hangs). */
  const GROUND_PLAYS = Object.freeze(['sit']);

  /**
   * Trips around the screen (main.js plans them, see app/roam.js). It does not
   * go home by itself: it just keeps wandering (home is in the menu, and it
   * goes home when ambient life is switched off).
   *   cruise  a slow, long, wavy flight far across the screen (or to another one)
   *   hang    up to the top edge, to hang from it for a while
   *   perch   onto a window's title bar, to sit there (Windows; elsewhere a hop)
   */
  const TRIPS = Object.freeze({ walk: 'stroll', fly: 'hop', inspect: 'inspect', cruise: 'cruise', hang: 'hang', perch: 'perch' });

  /**
   * Relative chances. Every play counts 1, so about half of what it does by
   * itself is a trip (it likes to get around: a walk, a flight, a look at what
   * the user does, a cruise, a hang from the top; main.js turns some of them
   * into a trip to another screen).
   */
  const WEIGHTS = Object.freeze({ walk: 4, fly: 4.5, inspect: 2.5, cruise: 2, hang: 1.2, perch: 1.6 });
  /** The wait between two behaviours (ms). */
  const AMBIENT_GAP = Object.freeze({ minMs: 15000, maxMs: 60000 });

  /**
   * Ambient life: while allowed (idle, awake, nothing else going on), every
   * 15-60 s one short behaviour, never the same one twice in a row:
   *   a play on the spot   onPlay(name), then onPlay(null) when it is over
   *   a trip               onTrip(kind) asks the main process to move
   * update() with enabled = false (an event, the pointer, rest, a drag, a
   * duel...) ends a play at once and cancels the next one.
   */
  class AmbientScheduler {
    constructor({ clock = realClock, random = Math.random, minMs = AMBIENT_GAP.minMs, maxMs = AMBIENT_GAP.maxMs, onPlay = () => {}, onTrip = () => {} } = {}) {
      this.clock = clock;
      this.random = random;
      this.minMs = minMs;
      this.maxMs = maxMs;
      this.onPlay = onPlay;
      this.onTrip = onTrip;
      this.allowed = { enabled: false, trips: false };
      this.playing = null;
      this.last = null;
      this.timer = null;
    }

    /**
     * @param {{ enabled: boolean, trips?: boolean, grounded?: boolean, hanging?: boolean }} next
     *   trips: moving around is allowed (no helpers, no cat)
     *   grounded: it stands on the ground (GROUND_PLAYS need that)
     *   hanging: it hangs from the top edge: the next thing is a trip away (no plays)
     */
    update({ enabled, trips = false, grounded = true, hanging = false }) {
      const was = this.allowed.enabled;
      this.allowed = { enabled: Boolean(enabled), trips: Boolean(trips), grounded: Boolean(grounded), hanging: Boolean(hanging) };
      if (!this.allowed.enabled) {
        this.stop();
        this.cancel();
        return;
      }
      if (!was || (!this.timer && !this.playing)) this.schedule();
    }

    /** The behaviours possible right now, without the previous one. */
    choices() {
      const { trips, grounded, hanging } = this.allowed;
      const out = hanging
        ? []
        : Object.keys(PLAYS)
            .filter((name) => grounded !== false || !GROUND_PLAYS.includes(name))
            .map((name) => [name, 1]);
      if (trips) {
        for (const kind of Object.keys(TRIPS)) out.push([kind, WEIGHTS[kind]]);
      }
      return out.filter(([name]) => name !== this.last);
    }

    schedule() {
      this.cancel();
      const delay = this.minMs + this.random() * (this.maxMs - this.minMs);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        const choices = this.allowed.enabled ? this.choices() : [];
        if (choices.length) this.run(pickWeighted(choices, this.random));
        else if (this.allowed.enabled) this.schedule();
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

  // ------------------------------------------------------------------ focus mode

  /**
   * How intense the work is: steps (a new tool at work) in the last two
   * minutes, edits count double. At `on` points it goes into focus mode (a
   * screen of light instead of the laptop, a headband), below `off` it comes
   * out again (the gap keeps it from flickering); calm for `calmMs` (the page
   * keeps that timer) ends it too.
   */
  const FOCUS = Object.freeze({
    windowMs: 120000,
    on: 12,
    off: 5,
    calmMs: 25000,
    weights: Object.freeze({ typing: 2, running: 1, reading: 1, working: 1 }),
  });

  class FocusMeter {
    constructor({ clock = realClock, ...options } = {}) {
      this.clock = clock;
      this.o = { ...FOCUS, ...options };
      this.steps = [];
      this.focused = false;
    }

    /** Points in the window right now. */
    score() {
      const now = this.clock.now();
      this.steps = this.steps.filter((s) => now - s.at < this.o.windowMs);
      return this.steps.reduce((sum, s) => sum + s.weight, 0);
    }

    /** A new step of work in this state; returns whether it is focused now. */
    step(state) {
      const weight = this.o.weights[state] || 0;
      if (weight) this.steps.push({ at: this.clock.now(), weight });
      const score = this.score();
      if (!this.focused && score >= this.o.on) this.focused = true;
      else if (this.focused && score < this.o.off) this.focused = false;
      return this.focused;
    }

    reset() {
      this.steps = [];
      this.focused = false;
    }
  }

  // ------------------------------------------------------------------ thinking poses

  /** Ways to think (robot.css data-think; 'chin' is the plain look), and how often it changes. */
  const THINK_POSES = Object.freeze(['chin', 'bulb', 'pace']);
  const THINK_MS = 7000;

  /**
   * The next pose while it thinks: never the same one twice in a row; no
   * pacing in the air or while it fights a bug (it faces the bug then).
   * @param {string|null} previous
   * @param {{ airborne?: boolean, hunting?: boolean }} where
   */
  function pickThinkPose(previous, { airborne = false, hunting = false } = {}, random = Math.random) {
    const options = THINK_POSES.filter((p) => p !== previous && (p !== 'pace' || (!airborne && !hunting)));
    return options[Math.floor(random() * options.length) % options.length];
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

    /** Over: no longer active, already while the 'end' callback runs. */
    close() {
      this.clearTimers();
      this.phase = null;
      this.onPhase('end', this.info());
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

  // ------------------------------------------------------------------ bug hunt

  const BUG_FIGHT_TIMINGS = Object.freeze({
    guardMinMs: 1200,
    guardMaxMs: 2000,
    windupMs: 500,
    strikeMs: 250,
    recoverMs: 600,
    /** The finishing blow is telegraphed a little quicker. */
    finishWindupMs: 350,
    winMs: 1600,
    /** How often an ordinary strike connects; the bug hops out of the way of the others. */
    hitChance: 0.6,
  });

  /**
   * The bug hunt (app/bugs.js): while Claude Code works on a failing check,
   * the robot fights the bug beside it with the duel's sword poses. Nobody
   * clicks and nobody loses hearts: guard -> windup -> strike -> recover ->
   * guard ... until the page stops it.
   *   onPhase(phase)    guard | windup | strike | recover | win | end
   *   onStrike(final, hit)  each strike: hit = it connects (the bug flinches),
   *                     otherwise the bug hops out of the way; final = the
   *                     finishing blow, always a hit (the page squashes the bug)
   * finish(): the fix landed. A quick windup (an ongoing windup just goes on),
   * the finishing strike, 'win', then 'end'. stop() ends at once.
   */
  class BugFight {
    constructor({ clock = realClock, random = Math.random, timings = {}, onPhase = () => {}, onStrike = () => {} } = {}) {
      this.clock = clock;
      this.random = random;
      this.t = { ...BUG_FIGHT_TIMINGS, ...timings };
      this.onPhase = onPhase;
      this.onStrike = onStrike;
      this.phase = null;
      this.timer = null;
      this.final = false;
    }

    get active() {
      return this.phase !== null;
    }

    /** The finishing blow is on its way (or the victory pose is on). */
    get finishing() {
      return this.final && this.active;
    }

    /** Start the loop (nothing if it already runs). */
    start() {
      if (this.active) return;
      this.final = false;
      this.guard();
    }

    finish() {
      if (this.final && this.active) return;
      this.final = true;
      if (this.phase === 'windup') return; // the strike coming up is the last one
      this.go('windup', this.t.finishWindupMs, () => this.strike());
    }

    stop() {
      if (!this.active) return;
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.timer = null;
      this.phase = null;
      this.final = false;
      this.onPhase('end');
    }

    guard() {
      const ms = this.t.guardMinMs + this.random() * (this.t.guardMaxMs - this.t.guardMinMs);
      this.go('guard', ms, () => this.go('windup', this.t.windupMs, () => this.strike()));
    }

    strike() {
      const final = this.final;
      const hit = final || this.random() < this.t.hitChance;
      this.go('strike', this.t.strikeMs, () => {
        if (final) this.go('win', this.t.winMs, () => this.stop());
        else this.go('recover', this.t.recoverMs, () => this.guard());
      });
      this.onStrike(final, hit);
    }

    go(phase, ms, next) {
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.phase = phase;
      this.onPhase(phase);
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        next();
      }, ms);
    }
  }

  return {
    TapMeter,
    tapMood,
    TAP_LIKES,
    TAP_PATIENCE,
    Temper,
    TEMPER_HOLD,
    TEMPER_MAX,
    Fury,
    FURY,
    FocusMeter,
    FOCUS,
    AmbientScheduler,
    AMBIENT_GAP,
    WEIGHTS,
    PLAYS,
    GROUND_PLAYS,
    TRIPS,
    pickCheer,
    CHEERS,
    THINK_POSES,
    THINK_MS,
    pickThinkPose,
    Duel,
    DUEL_TIMINGS,
    BugFight,
    BUG_FIGHT_TIMINGS,
  };
});
