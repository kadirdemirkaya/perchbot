/*
 * Sounds, made in code with the Web Audio API: no audio files, nothing is
 * downloaded, and nothing is recorded (no microphone). Off by default (the
 * "Sound" setting); the page asks for a sound only for things the user does
 * or the buddy's own play, never for Claude Code's work.
 *
 * Pure logic around an injected AudioContext factory, so node:test can run it
 * with a fake one (window.BuddySound in the page).
 *
 * Cheap on purpose: at most 5 sounds at once, the same sound at most every
 * 45 ms, the AudioContext is only created for the first sound, suspended 2 s
 * after the last one has ended (no audio thread running in between) and
 * closed after a minute of silence.
 *
 * The sounds:
 *   clang    two swords meet (a few inharmonic partials and a short hiss)
 *   bonk     a tap on the head; each quick tap after another a little higher
 *   grumble  "hm-hmph": tapped one time too many
 *   bounce   a rubber ball hits the ground
 *   purr     the cat purrs (soft noise, pulsing)
 *   scratch  the cat scratches (three short scrapes)
 *   crack    the whip
 *   meow     the cat says hello (a vowel-ish "mi-aow")
 *   tick     the cat's little ball is batted
 *   boing    a spring: jumps, take-offs, the antenna flicked
 *   whoosh   air: a somersault, the breath before a sneeze
 *   achoo    the sneeze itself
 *   hum      a four-note hum
 *   beep     a small robot blip
 *   powerdown / boot   switching off and on again (reboot)
 *   squeak   a squeaky-clean wipe (polish)
 *   sparkle  the shine afterwards
 *
 * CUES says which sound plays when, in the buddy's own plays and in the cat's
 * routine (times match characters/robot/*.css). scheduleCues() sets the
 * timers, and sets none at all while the sound is off.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuddySound = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const VOLUMES = Object.freeze({ low: 0.16, medium: 0.32, high: 0.55 });
  const TIMINGS = Object.freeze({
    maxVoices: 5,
    minGapMs: 45,
    suspendMs: 2000,
    closeMs: 60000,
    /** Taps closer together than this make a streak (rising pitch). */
    streakMs: 900,
  });
  const realClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const SILENT = 0.0001;

  // ---------------------------------------------------------------- building blocks

  /** One oscillator with a pitch glide and a quick attack / exponential decay. */
  function tone(ctx, out, { type = 'sine', f0, f1 = f0, at, dur, peak = 0.8, attack = 0.004 }) {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, at + dur);
    amp.gain.setValueAtTime(SILENT, at);
    amp.gain.linearRampToValueAtTime(peak, at + attack);
    amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
    osc.connect(amp);
    amp.connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    return osc;
  }

  /** A burst of filtered white noise. */
  function hiss(board, ctx, out, { at, dur, type = 'bandpass', freq = 2000, q = 1, peak = 0.5, attack = 0.003 }) {
    const src = ctx.createBufferSource();
    src.buffer = board.noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, at);
    filter.Q.setValueAtTime(q, at);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(SILENT, at);
    amp.gain.linearRampToValueAtTime(peak, at + attack);
    amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(out);
    src.start(at, board.random() * 0.5);
    src.stop(at + dur + 0.02);
    return src;
  }

  // ---------------------------------------------------------------- the sounds

  /** Each returns { sources, duration } (seconds). `p` scales the pitch. */
  const RECIPES = {
    clang(board, ctx, out, at, p) {
      const partials = [
        [620, 0.55, 0.45],
        [1712, 0.4, 0.3],
        [2940, 0.28, 0.2],
        [4210, 0.2, 0.12],
      ];
      const sources = partials.map(([f, dur, peak], i) =>
        tone(ctx, out, { type: i === 0 ? 'triangle' : 'sine', f0: f * p, f1: f * p * 0.985, at, dur, peak, attack: 0.002 }),
      );
      sources.push(hiss(board, ctx, out, { at, dur: 0.07, type: 'highpass', freq: 3200, q: 0.7, peak: 0.3 }));
      return { sources, duration: 0.56 };
    },

    bonk(board, ctx, out, at, p) {
      return {
        sources: [
          tone(ctx, out, { f0: 430 * p, f1: 190 * p, at, dur: 0.15, peak: 0.85 }),
          tone(ctx, out, { type: 'triangle', f0: 860 * p, f1: 420 * p, at, dur: 0.07, peak: 0.18 }),
          hiss(board, ctx, out, { at, dur: 0.025, type: 'lowpass', freq: 1800, q: 0.5, peak: 0.25 }),
        ],
        duration: 0.16,
      };
    },

    grumble(board, ctx, out, at, p) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(950, at);
      lowpass.connect(out);
      return {
        sources: [
          tone(ctx, lowpass, { type: 'sawtooth', f0: 195 * p, f1: 155 * p, at, dur: 0.16, peak: 0.42, attack: 0.02 }),
          tone(ctx, lowpass, { type: 'sawtooth', f0: 165 * p, f1: 104 * p, at: at + 0.19, dur: 0.3, peak: 0.48, attack: 0.025 }),
        ],
        duration: 0.5,
      };
    },

    bounce(board, ctx, out, at, p) {
      return {
        sources: [
          tone(ctx, out, { f0: 190 * p, f1: 95 * p, at, dur: 0.11, peak: 0.75, attack: 0.002 }),
          hiss(board, ctx, out, { at, dur: 0.03, type: 'lowpass', freq: 900, q: 0.6, peak: 0.2 }),
        ],
        duration: 0.12,
      };
    },

    purr(board, ctx, out, at, p) {
      const dur = 1.4;
      // Low noise whose loudness pulses ~26 times a second.
      const src = ctx.createBufferSource();
      src.buffer = board.noiseBuffer(ctx);
      src.loop = true;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(320 * p, at);
      const pulse = ctx.createGain();
      pulse.gain.setValueAtTime(0.5, at);
      const lfo = ctx.createOscillator();
      lfo.frequency.setValueAtTime(26 * p, at);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0.5, at);
      lfo.connect(depth);
      depth.connect(pulse.gain);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(0.9, at + 0.25);
      amp.gain.setValueAtTime(0.9, at + dur - 0.4);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
      src.connect(lowpass);
      lowpass.connect(pulse);
      pulse.connect(amp);
      amp.connect(out);
      src.start(at);
      lfo.start(at);
      src.stop(at + dur + 0.02);
      lfo.stop(at + dur + 0.02);
      return { sources: [src, lfo], duration: dur };
    },

    scratch(board, ctx, out, at, p) {
      const sources = [0, 0.1, 0.2].map((delay, i) =>
        hiss(board, ctx, out, { at: at + delay, dur: 0.075, type: 'bandpass', freq: (2300 + i * 350) * p, q: 1.3, peak: 0.45, attack: 0.012 }),
      );
      return { sources, duration: 0.3 };
    },

    crack(board, ctx, out, at, p) {
      return {
        sources: [
          hiss(board, ctx, out, { at, dur: 0.06, type: 'highpass', freq: 1800 * p, q: 0.8, peak: 0.9, attack: 0.001 }),
          tone(ctx, out, { type: 'triangle', f0: 1500 * p, f1: 320 * p, at, dur: 0.045, peak: 0.3, attack: 0.001 }),
        ],
        duration: 0.07,
      };
    },

    meow(board, ctx, out, at, p) {
      const dur = 0.46;
      // A buzzy voice through a moving "vowel" filter: i -> a -> o.
      const voice = ctx.createOscillator();
      voice.type = 'sawtooth';
      voice.frequency.setValueAtTime(560 * p, at);
      voice.frequency.exponentialRampToValueAtTime(820 * p, at + 0.13);
      voice.frequency.exponentialRampToValueAtTime(470 * p, at + dur);
      const vowel = ctx.createBiquadFilter();
      vowel.type = 'bandpass';
      vowel.Q.setValueAtTime(3, at);
      vowel.frequency.setValueAtTime(1500 * p, at);
      vowel.frequency.exponentialRampToValueAtTime(2100 * p, at + 0.14);
      vowel.frequency.exponentialRampToValueAtTime(900 * p, at + dur);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(0.9, at + 0.04);
      amp.gain.setValueAtTime(0.9, at + 0.22);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
      voice.connect(vowel);
      vowel.connect(amp);
      amp.connect(out);
      voice.start(at);
      voice.stop(at + dur + 0.02);
      // A soft body underneath, so it is round rather than nasal.
      const body = tone(ctx, out, { f0: 560 * p, f1: 470 * p, at, dur, peak: 0.16, attack: 0.04 });
      return { sources: [voice, body], duration: dur };
    },

    tick(board, ctx, out, at, p) {
      return {
        sources: [
          tone(ctx, out, { f0: 1100 * p, f1: 700 * p, at, dur: 0.05, peak: 0.5, attack: 0.002 }),
          tone(ctx, out, { type: 'triangle', f0: 2200 * p, f1: 1500 * p, at, dur: 0.025, peak: 0.1, attack: 0.001 }),
        ],
        duration: 0.06,
      };
    },

    boing(board, ctx, out, at, p) {
      const dur = 0.3;
      const spring = ctx.createOscillator();
      spring.frequency.setValueAtTime(180 * p, at);
      spring.frequency.exponentialRampToValueAtTime(520 * p, at + 0.16);
      // The wobble of the spring.
      const wobble = ctx.createOscillator();
      wobble.frequency.setValueAtTime(16, at);
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(28 * p, at);
      wobble.connect(depth);
      depth.connect(spring.frequency);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(0.55, at + 0.01);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
      spring.connect(amp);
      amp.connect(out);
      spring.start(at);
      wobble.start(at);
      spring.stop(at + dur + 0.02);
      wobble.stop(at + dur + 0.02);
      return { sources: [spring, wobble], duration: dur };
    },

    whoosh(board, ctx, out, at, p) {
      const dur = 0.4;
      const src = ctx.createBufferSource();
      src.buffer = board.noiseBuffer(ctx);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.setValueAtTime(0.8, at);
      band.frequency.setValueAtTime(500 * p, at);
      band.frequency.exponentialRampToValueAtTime(2400 * p, at + 0.2);
      band.frequency.exponentialRampToValueAtTime(800 * p, at + dur);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(0.35, at + 0.16);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
      src.connect(band);
      band.connect(amp);
      amp.connect(out);
      src.start(at, board.random() * 0.5);
      src.stop(at + dur + 0.02);
      return { sources: [src], duration: dur };
    },

    achoo(board, ctx, out, at, p) {
      return {
        sources: [
          // "ch": a short breathy burst ...
          hiss(board, ctx, out, { at, dur: 0.07, type: 'highpass', freq: 2600 * p, q: 0.7, peak: 0.45, attack: 0.004 }),
          // ... then the round "oo".
          tone(ctx, out, { type: 'triangle', f0: 520 * p, f1: 300 * p, at: at + 0.04, dur: 0.28, peak: 0.5, attack: 0.012 }),
          hiss(board, ctx, out, { at: at + 0.04, dur: 0.22, type: 'bandpass', freq: 1100 * p, q: 0.8, peak: 0.25, attack: 0.01 }),
        ],
        duration: 0.32,
      };
    },

    hum(board, ctx, out, at, p) {
      // One soft voice that steps through four notes: mm-mm-mm-mmm.
      const notes = [0, 4, 2, 7];
      const step = 0.26;
      const dur = notes.length * step;
      const voice = ctx.createOscillator();
      voice.type = 'triangle';
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(1100, at);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      notes.forEach((semitones, i) => {
        const t = at + i * step;
        voice.frequency.setValueAtTime(330 * p * 2 ** (semitones / 12), t);
        amp.gain.linearRampToValueAtTime(0.5, t + 0.04);
        amp.gain.linearRampToValueAtTime(0.28, t + step - 0.02);
      });
      amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
      voice.connect(lowpass);
      lowpass.connect(amp);
      amp.connect(out);
      voice.start(at);
      voice.stop(at + dur + 0.02);
      return { sources: [voice], duration: dur };
    },

    beep(board, ctx, out, at, p) {
      return {
        sources: [tone(ctx, out, { f0: 1320 * p, f1: 1250 * p, at, dur: 0.08, peak: 0.4, attack: 0.003 })],
        duration: 0.09,
      };
    },

    powerdown(board, ctx, out, at, p) {
      return {
        sources: [tone(ctx, out, { type: 'triangle', f0: 700 * p, f1: 140 * p, at, dur: 0.42, peak: 0.45, attack: 0.01 })],
        duration: 0.43,
      };
    },

    boot(board, ctx, out, at, p) {
      // A rising chime: C E G, then the C above rings a little longer.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const sources = notes.map((f, i) =>
        tone(ctx, out, { f0: f * p, at: at + i * 0.09, dur: i === notes.length - 1 ? 0.42 : 0.16, peak: 0.36, attack: 0.005 }),
      );
      return { sources, duration: 0.27 + 0.42 };
    },

    squeak(board, ctx, out, at, p) {
      return {
        sources: [tone(ctx, out, { f0: 1500 * p, f1: 2100 * p, at, dur: 0.08, peak: 0.22, attack: 0.012 })],
        duration: 0.09,
      };
    },

    sparkle(board, ctx, out, at, p) {
      return {
        sources: [
          tone(ctx, out, { f0: 2637 * p, at, dur: 0.32, peak: 0.26, attack: 0.002 }),
          tone(ctx, out, { f0: 3520 * p, at: at + 0.06, dur: 0.3, peak: 0.2, attack: 0.002 }),
        ],
        duration: 0.36,
      };
    },
  };

  const NAMES = Object.freeze(Object.keys(RECIPES));

  // ---------------------------------------------------------------- when they play

  /** [at ms, sound, pitch] -> a frozen cue. */
  const cue = (at, sound, pitch = 1) => Object.freeze({ at, sound, pitch });
  /** The same sound every `step` ms from `from` until before `until`, pitches taking turns. */
  function every(from, step, until, sound, pitches = [1]) {
    const out = [];
    for (let at = from, i = 0; at < until; at += step, i += 1) out.push(cue(at, sound, pitches[i % pitches.length]));
    return out;
  }
  const sheet = (cues) => Object.freeze(cues.slice().sort((a, b) => a.at - b.at));

  /**
   * Which sound plays when (ms after the start). `play`: the buddy's ambient
   * plays (PLAYS in lib/fun.js; keyframes in characters/robot/robot.css).
   * `cat`: the cat's phases (lib/pet.js; characters/robot/cat.css). A play
   * that is not listed stays silent (stretch, look, peek, moonwalk).
   */
  const CUES = Object.freeze({
    play: Object.freeze({
      // rb-hello 0.7 s, twice: off the ground at ~25 %.
      jump: sheet([cue(200, 'boing'), cue(900, 'boing', 1.12)]),
      // rb-dribble 0.6 s: the ball hits the floor at 48 %.
      ball: sheet(every(288, 600, 4200, 'bounce', [1, 0.97, 1.03])),
      // rb-sway-a starts at 0.9 s; rb-glow turns pink at 45 %.
      antenna: sheet([cue(900, 'boing', 1.8), cue(1250, 'beep', 1.25), cue(1500, 'beep', 1.5)]),
      // rb-flip 1.6 s: take-off 15 %, the turn, landing 80 %.
      flip: sheet([cue(240, 'boing', 0.9), cue(520, 'whoosh'), cue(1280, 'bounce', 0.85)]),
      // rb-reboot-* 2.8 s: screen off 8 %, power blinks 13 / 30 / 47 %, back on 60 %.
      reboot: sheet([cue(200, 'powerdown'), cue(364, 'beep', 0.9), cue(840, 'beep', 0.9), cue(1316, 'beep', 0.9), cue(1700, 'boot')]),
      // rb-polish-arm 3.4 s: six strokes from 27 %, the shine at 88 %.
      polish: sheet([...every(918, 306, 2500, 'squeak', [1, 1.12]), cue(2990, 'sparkle')]),
      // rb-sneeze-head 2.6 s: the breath in, then "choo" at 50 % (SNEEZE_AT_MS).
      sneeze: sheet([cue(420, 'whoosh', 0.6), cue(1300, 'achoo')]),
      // Two little phrases while the notes float up.
      hum: sheet([cue(300, 'hum'), cue(1800, 'hum', 1.12)]),
    }),
    cat: Object.freeze({
      // Hello while it walks in (the shortest walk is 400 ms).
      enter: sheet([cue(250, 'meow')]),
      // rbc-roll 1.4 s: the robot bats the ball back at ~50 %, the cat at 0 %.
      play: sheet([
        cue(0, 'scratch'),
        cue(1200, 'purr'),
        ...every(700, 1400, 7000, 'tick', [0.85]),
        ...every(1400, 1400, 7000, 'tick', [1.15]),
      ]),
      // Curled up: one sleepy purr, then quiet.
      nap: sheet([cue(600, 'purr', 0.85)]),
    }),
  });

  /**
   * Set the timers for a cue sheet. With the sound off nothing is scheduled at
   * all (no timers, no work). `still()` is asked when each one fires, so a play
   * cut short goes quiet. Returns how many timers were set.
   * @param {ReadonlyArray<{ at: number, sound: string, pitch: number }>} cues
   * @param {{ on: boolean, key: string, later: (key: string, ms: number, fn: Function) => void,
   *   still: () => boolean, play: (sound: string, pitch: number) => void }} o
   */
  function scheduleCues(cues, { on, key, later, still, play }) {
    if (!on || !Array.isArray(cues) || cues.length === 0) return 0;
    cues.forEach((c, i) =>
      later(`${key}-${i}`, c.at, () => {
        if (still()) play(c.sound, c.pitch);
      }),
    );
    return cues.length;
  }

  // ---------------------------------------------------------------- the board

  class SoundBoard {
    /**
     * @param {object} o
     * @param {() => AudioContext} o.createContext  called for the first sound only
     * @param {{ setTimeout: Function, clearTimeout: Function }} [o.clock]
     * @param {() => number} [o.now]  ms
     * @param {() => number} [o.random]
     * @param {Partial<typeof TIMINGS>} [o.timings]
     */
    constructor({ createContext, clock = realClock, now = () => Date.now(), random = Math.random, timings = {} } = {}) {
      this.createContext = createContext;
      this.clock = clock;
      this.now = now;
      this.random = random;
      this.t = { ...TIMINGS, ...timings };
      this.enabled = false;
      this.volume = VOLUMES.low;
      this.ctx = null;
      this.master = null;
      this.noise = null;
      /** Sounds still ringing: { sources, end } (end in ms, this.now()). */
      this.voices = [];
      this.lastPlayed = new Map();
      this.streak = { count: 0, at: -Infinity };
      this.suspendTimer = null;
      this.closeTimer = null;
    }

    setEnabled(on) {
      this.enabled = Boolean(on);
      if (!this.enabled) this.shutdown();
    }

    /** 'low' | 'medium' | 'high' (anything else: low). */
    setVolume(level) {
      this.volume = Object.prototype.hasOwnProperty.call(VOLUMES, level) ? VOLUMES[level] : VOLUMES.low;
      if (this.master) this.master.gain.value = this.volume;
    }

    /** Sounds playing right now. */
    get active() {
      this.prune();
      return this.voices.length;
    }

    /**
     * Play a sound. Returns false when it did not (off, unknown, too soon after
     * the same one, five already ringing, or no audio available).
     * @param {string} name
     * @param {{ pitch?: number }} [o]
     */
    play(name, { pitch = 1 } = {}) {
      if (!this.enabled || !Object.prototype.hasOwnProperty.call(RECIPES, name)) return false;
      const now = this.now();
      if (now - (this.lastPlayed.has(name) ? this.lastPlayed.get(name) : -Infinity) < this.t.minGapMs) return false;
      this.prune(now);
      if (this.voices.length >= this.t.maxVoices) return false;
      const ctx = this.context();
      if (!ctx) return false;
      this.lastPlayed.set(name, now);
      const p = Math.max(0.25, Math.min(4, Number(pitch) || 1));
      let voice;
      try {
        voice = RECIPES[name](this, ctx, this.master, ctx.currentTime + 0.01, p);
      } catch {
        return false;
      }
      this.voices.push({ sources: voice.sources, end: now + voice.duration * 1000 + 30 });
      this.idleAfter(voice.duration * 1000);
      return true;
    }

    /**
     * Pitch for a tap: quick taps one after the other climb (up to 1.8x), with a
     * little random wobble so no two sound quite the same.
     */
    tapPitch() {
      const now = this.now();
      this.streak.count = now - this.streak.at < this.t.streakMs ? this.streak.count + 1 : 0;
      this.streak.at = now;
      const climb = Math.min(1.8, 1 + 0.12 * this.streak.count);
      return climb * (1 + (this.random() - 0.5) * 0.08);
    }

    /** Silence at once (work came in, the screen locked). */
    stopAll() {
      for (const voice of this.voices) {
        for (const source of voice.sources) {
          try {
            source.stop();
          } catch {
            // already stopped
          }
        }
      }
      this.voices = [];
      if (this.ctx) this.idleAfter(0);
    }

    /** Off: everything stops and the AudioContext is closed. */
    shutdown() {
      this.stopAll();
      this.clearTimers();
      if (this.ctx) {
        try {
          const closing = this.ctx.close();
          if (closing && typeof closing.catch === 'function') closing.catch(() => {});
        } catch {
          // already closed
        }
      }
      this.ctx = null;
      this.master = null;
      this.noise = null;
    }

    // ------------------------------------------------------------ internals

    context() {
      this.clearTimers();
      if (!this.ctx) {
        try {
          this.ctx = this.createContext();
        } catch {
          this.ctx = null;
        }
        if (!this.ctx) return null;
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') {
        const resuming = this.ctx.resume();
        if (resuming && typeof resuming.catch === 'function') resuming.catch(() => {});
      }
      return this.ctx;
    }

    /** One second of white noise, made once per AudioContext. */
    noiseBuffer(ctx) {
      if (this.noise) return this.noise;
      const length = Math.round(ctx.sampleRate);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = this.random() * 2 - 1;
      this.noise = buffer;
      return buffer;
    }

    prune(now = this.now()) {
      this.voices = this.voices.filter((v) => v.end > now);
    }

    /** After the last sound: suspend (no audio thread), later close. */
    idleAfter(ms) {
      this.clearTimers();
      const wait = Math.max(ms, ...this.voices.map((v) => v.end - this.now()), 0) + this.t.suspendMs;
      this.suspendTimer = this.clock.setTimeout(() => {
        this.suspendTimer = null;
        if (this.ctx && this.ctx.state === 'running') {
          const suspending = this.ctx.suspend();
          if (suspending && typeof suspending.catch === 'function') suspending.catch(() => {});
        }
        this.closeTimer = this.clock.setTimeout(() => {
          this.closeTimer = null;
          this.shutdown();
        }, this.t.closeMs);
      }, wait);
    }

    clearTimers() {
      if (this.suspendTimer) this.clock.clearTimeout(this.suspendTimer);
      if (this.closeTimer) this.clock.clearTimeout(this.closeTimer);
      this.suspendTimer = null;
      this.closeTimer = null;
    }
  }

  return { SoundBoard, VOLUMES, TIMINGS, NAMES, CUES, scheduleCues };
});
