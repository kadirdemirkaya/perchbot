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
 *   leave   walks out again; then onGone()
 *
 * interrupt() (Claude Code needs the main character): no more playing, it
 * goes straight to its nap spot.
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
    /** How far beyond the window edge it comes from and goes to. */
    outside: 70,
  });

  class PetDirector {
    constructor({ clock = realClock, timings = {}, onUpdate = () => {}, onCue = () => {}, onGone = () => {}, onPhase = () => {} } = {}) {
      this.clock = clock;
      this.t = { ...PET_TIMINGS, ...timings };
      this.onUpdate = onUpdate;
      this.onCue = onCue;
      this.onGone = onGone;
      this.onPhase = onPhase;
      this.phase = null;
      this.geo = { play: 60, nap: 140, width: 190 };
      this.pet = null;
      this.timer = null;
    }

    get here() {
      return this.pet !== null && this.pet.phase !== 'leave';
    }

    /** { play, nap, width } from the layout (placement.petSpots). */
    setGeometry(geo) {
      if (!geo) return;
      this.geo = { play: geo.play, nap: geo.nap, width: geo.width };
      const p = this.pet;
      if (!p || p.walkMs) return;
      // Re-place a resting pet (side or helpers changed).
      if (p.phase === 'play') this.place(this.geo.play);
      if (p.phase === 'nap') this.place(this.geo.nap);
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

    /** Work came in: stop playing, go and nap. */
    interrupt() {
      const p = this.pet;
      if (!p || (p.phase !== 'enter' && p.phase !== 'play')) return;
      this.endPlay();
      this.aside();
    }

    play() {
      this.pet.phase = 'play';
      this.pet.face = 'in';
      this.emit();
      this.onCue('play', true);
      this.after(this.t.playMs, () => {
        this.endPlay();
        this.aside();
      });
    }

    endPlay() {
      if (this.pet && this.pet.phase === 'play') this.onCue('play', false);
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
      this.pet = null;
      this.setPhase(null);
    }
  }

  return { PetDirector, PET_TIMINGS };
});
