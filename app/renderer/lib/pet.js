/*
 * PetDirector: the cat's little routine. Pure logic, injectable clock, so the
 * same file runs in the renderer (window.BuddyPet) and in node:test.
 *
 * Positions are OUTWARD offsets (CSS px) from the slot edge that faces the
 * crew side, like the minis (see app/placement.js petSpots):
 *
 *   enter   walks in from beyond the edge of the window to its play spot
 *   play    plays with the main character (a ball goes back and forth)
 *   aside   walks off to its nap spot
 *   nap     curls up and sleeps until it is sent away
 *   cuddle  (cuddle(), the idle story) walks up close to the main character
 *           and stays there to be petted, then goes to nap
 *   laser   (laser(): from its nap, or now and then after the ball) the main
 *           character points a laser pointer: it chases the red dot to its
 *           play spot and pounces at it there, then goes to nap
 *   leave   walks out again; then onGone()
 *
 * interrupt() (Claude Code needs the main character): no more playing,
 * petting or chasing the dot, it goes straight to its nap spot.
 *
 * onPhase(phase) is told each time the phase changes, and null once the cat
 * is gone (walked out, or the pet was changed): the page plays its sounds.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddyPet = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };

  const PET_TIMINGS = Object.freeze({
    /** Walking speed (px per ms) and the shortest walk. */
    walkSpeed: 0.08,
    minWalkMs: 400,
    playMs: 7000,
    /** Being petted, once it is there. */
    cuddleMs: 6000,
    /** Chasing the laser dot, once it is at its play spot. */
    laserMs: 6500,
    /** The chance that the laser pointer comes out after the ball (0: never; the page sets it). */
    laserAfterPlay: 0,
    /** How far beyond the window edge it comes from and goes to. */
    outside: 70,
  });

  class PetDirector {
    constructor({ clock = realClock, random = Math.random, timings = {}, onUpdate = () => {}, onCue = () => {}, onGone = () => {}, onPhase = () => {} } = {}) {
      this.clock = clock;
      this.random = random;
      this.t = { ...PET_TIMINGS, ...timings };
      this.onUpdate = onUpdate;
      this.onCue = onCue;
      this.onGone = onGone;
      this.onPhase = onPhase;
      this.phase = null;
      this.geo = { play: 60, nap: 140, width: 190, cuddle: 10 };
      this.pet = null;
      this.timer = null;
      /** The cue that is on ('play', 'cuddle', 'laser') or null. */
      this.cue = null;
    }

    get here() {
      return this.pet !== null && this.pet.phase !== 'leave';
    }

    /** { play, nap, width, cuddle } from the layout (placement.petSpots). */
    setGeometry(geo) {
      if (!geo) return;
      this.geo = { play: geo.play, nap: geo.nap, width: geo.width, cuddle: Number.isFinite(geo.cuddle) ? geo.cuddle : this.geo.cuddle };
      const p = this.pet;
      if (!p || p.walkMs) return;
      // Re-place a resting pet (side or helpers changed).
      if (p.phase === 'play') this.place(this.geo.play);
      if (p.phase === 'nap') this.place(this.geo.nap);
      if (p.phase === 'cuddle') this.place(this.geo.cuddle);
      if (p.phase === 'laser') this.place(this.geo.play);
    }

    /** Called from the menu. */
    call() {
      if (this.here) return;
      this.clear();
      this.pet = { phase: 'enter', off: this.geo.width + this.t.outside, face: 'in', walkMs: 0 };
      this.emit();
      this.walk(this.geo.play, 'in', () => this.play());
    }

    /** Sent away from the menu (or the setting was turned off). */
    dismiss() {
      if (!this.pet || this.pet.phase === 'leave') return;
      this.endPlay();
      this.pet.phase = 'leave';
      this.walk(this.geo.width + this.t.outside, 'out', () => {
        this.clear();
        this.pet = null;
        this.setPhase(null);
        this.onGone();
      });
    }

    /** Work came in: stop playing (or being petted), go and nap. */
    interrupt() {
      const p = this.pet;
      if (!p || (p.phase !== 'enter' && p.phase !== 'play' && p.phase !== 'cuddle' && p.phase !== 'laser')) return;
      this.endPlay();
      this.aside();
    }

    /**
     * The main character wants to pet it (the idle story): from wherever it is
     * (playing, napping), it walks up close, stays to be petted (onCue
     * 'cuddle' on / off), then goes back to its nap spot. False while it is
     * not here, still walking in, or leaving.
     */
    cuddle() {
      const p = this.pet;
      if (!p || p.phase === 'enter' || p.phase === 'leave' || p.phase === 'cuddle') return false;
      this.endPlay();
      p.phase = 'cuddle';
      this.walk(this.geo.cuddle, 'in', () => {
        p.face = 'in';
        this.emit();
        this.cueOn('cuddle');
        this.after(this.t.cuddleMs, () => {
          this.endPlay();
          this.aside();
        });
      });
      return true;
    }

    play() {
      this.pet.phase = 'play';
      this.pet.face = 'in';
      this.emit();
      // Something else was asked for from a phase callback (cuddle(), dismiss()): that wins.
      if (!this.pet || this.pet.phase !== 'play') return;
      this.cueOn('play');
      this.after(this.t.playMs, () => {
        this.endPlay();
        // Now and then the laser pointer comes out after the ball.
        if (this.t.laserAfterPlay > 0 && this.random() < this.t.laserAfterPlay && this.laser()) return;
        this.aside();
      });
    }

    /**
     * The main character gets a laser pointer out: from its nap (or after
     * the ball) the cat chases the red dot to its play spot and pounces at it
     * there (onCue 'laser' on / off), then goes back to its nap spot. False
     * while it is not here, walking in, leaving, or busy with the robot.
     */
    laser() {
      const p = this.pet;
      if (!p || p.phase === 'enter' || p.phase === 'leave' || p.phase === 'cuddle' || p.phase === 'laser') return false;
      this.endPlay();
      p.phase = 'laser';
      this.walk(this.geo.play, 'in', () => {
        p.face = 'in';
        this.emit();
        this.cueOn('laser');
        this.after(this.t.laserMs, () => {
          this.endPlay();
          this.aside();
        });
      });
      return true;
    }

    /** The main character joins in ('play', 'cuddle', 'laser'): onCue(name, true), once. */
    cueOn(name) {
      this.cue = name;
      this.onCue(name, true);
    }

    /** Whatever the main character joined in on is over. */
    endPlay() {
      const name = this.cue;
      this.cue = null;
      if (name) this.onCue(name, false);
    }

    aside() {
      this.pet.phase = 'aside';
      this.walk(this.geo.nap, 'out', () => {
        this.pet.phase = 'nap';
        this.pet.face = 'in';
        this.emit();
      });
    }

    walk(off, face, then) {
      this.clear();
      const p = this.pet;
      const distance = Math.abs(off - p.off);
      p.face = face;
      p.walkMs = distance < 1 ? 0 : Math.max(this.t.minWalkMs, Math.round(distance / this.t.walkSpeed));
      p.off = off;
      this.emit();
      this.after(p.walkMs, () => {
        p.walkMs = 0;
        then();
      });
    }

    place(off) {
      this.pet.off = off;
      this.pet.walkMs = 0;
      this.emit();
    }

    after(ms, fn) {
      this.clear();
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        fn();
      }, ms);
    }

    clear() {
      if (this.timer) this.clock.clearTimeout(this.timer);
      this.timer = null;
    }

    emit() {
      if (!this.pet) return;
      this.onUpdate({ ...this.pet });
      this.setPhase(this.pet.phase);
    }

    setPhase(phase) {
      if (phase === this.phase) return;
      this.phase = phase;
      this.onPhase(phase);
    }

    dispose() {
      this.clear();
      this.cue = null;
      this.pet = null;
      this.setPhase(null);
    }
  }

  return { PetDirector, PET_TIMINGS };
});
