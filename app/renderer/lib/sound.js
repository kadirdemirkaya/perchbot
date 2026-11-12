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
  };

  const NAMES = Object.freeze(Object.keys(RECIPES));

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

  return { SoundBoard, VOLUMES, TIMINGS, NAMES };
});
