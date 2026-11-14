/*
 * Sounds, made in code with the Web Audio API: no audio files, nothing is
 * downloaded, and nothing is recorded (no microphone). Off by default (the
 * "Sound" setting). The page asks for a sound for things the user does and
 * the buddy's own play; for Claude Code's work only a few short signals
 * (done, a failure, a question for the user, focus mode), and only with the
 * "Work sounds" switch on too.
 *
 * A little robot's voice: blips with a quick FM "ping", tones with a metallic
 * ring (amplitude modulation), square waves softened by a low-pass filter.
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
 *   chirp    robot babble: a few quick stepped blips (chats, "hmm?")
 *   charge / laser / launch / boom   the rampage: eyes power up, the beams,
 *            a missile leaves the hatch, a blast
 *   holo     a screen of light switches on (focus mode)
 *   yawn     sleepy, before a nap
 *   done / error / alert   work signals: finished, a tool failed, a question
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

  /**
   * A tone whose loudness wobbles `ring` times a second by `depth`: the
   * metallic edge of a robot voice (amplitude / ring modulation), through a
   * low-pass so square waves stay soft.
   */
  function ringTone(ctx, out, { type = 'square', f0, f1 = f0, ring = 55, depth = 0.6, at, dur, peak = 0.5, attack = 0.006, cutoff = 2200 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const mod = ctx.createOscillator();
    mod.frequency.setValueAtTime(ring, at);
    const modDepth = ctx.createGain();
    modDepth.gain.setValueAtTime(depth, at);
    const wobble = ctx.createGain();
    wobble.gain.setValueAtTime(1 - depth, at);
    mod.connect(modDepth);
    modDepth.connect(wobble.gain);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(cutoff, at);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(SILENT, at);
    amp.gain.linearRampToValueAtTime(peak, at + attack);
    amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
    osc.connect(wobble);
    wobble.connect(lowpass);
    lowpass.connect(amp);
    amp.connect(out);
    osc.start(at);
    mod.start(at);
    osc.stop(at + dur + 0.02);
    mod.stop(at + dur + 0.02);
    return [osc, mod];
  }

  /** A quick FM "ping": a sine whose frequency is shaken by another, the shake dying away. */
  function fmBlip(ctx, out, { f0, f1 = f0, ratio = 2, index = 1.2, at, dur, peak = 0.6, attack = 0.003 }) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const mod = ctx.createOscillator();
    mod.frequency.setValueAtTime(f0 * ratio, at);
    if (f1 !== f0) mod.frequency.exponentialRampToValueAtTime(f1 * ratio, at + dur);
    const shake = ctx.createGain();
    shake.gain.setValueAtTime(f0 * index, at);
    shake.gain.exponentialRampToValueAtTime(Math.max(1, f0 * 0.02), at + dur * 0.6);
    mod.connect(shake);
    shake.connect(osc.frequency);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(SILENT, at);
    amp.gain.linearRampToValueAtTime(peak, at + attack);
    amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
    osc.connect(amp);
    amp.connect(out);
    osc.start(at);
    mod.start(at);
    osc.stop(at + dur + 0.02);
    mod.stop(at + dur + 0.02);
    return [osc, mod];
  }

  // ---------------------------------------------------------------- the sounds

  /** Each returns { sources, duration } (seconds). `p` scales the pitch. */
  const RECIPES = {
    clang(board, ctx, out, at, p) {
      // Fewer, softer partials than a real blade and a short ring: a toy sword.
      const partials = [
        [620, 0.42, 0.42],
        [1712, 0.28, 0.2],
        [2940, 0.16, 0.08],
      ];
      const sources = partials.map(([f, dur, peak], i) =>
        tone(ctx, out, { type: i === 0 ? 'triangle' : 'sine', f0: f * p, f1: f * p * 0.985, at, dur, peak, attack: 0.002 }),
      );
      sources.push(hiss(board, ctx, out, { at, dur: 0.04, type: 'highpass', freq: 3000, q: 0.6, peak: 0.14 }));
      return { sources, duration: 0.43 };
    },

    bonk(board, ctx, out, at, p) {
      // A round robot "bip" with a little metallic ping (FM), no click.
      return {
        sources: [
          ...fmBlip(ctx, out, { f0: 520 * p, f1: 300 * p, ratio: 2, index: 0.9, at, dur: 0.14, peak: 0.7 }),
          tone(ctx, out, { f0: 260 * p, f1: 180 * p, at, dur: 0.1, peak: 0.25 }),
        ],
        duration: 0.15,
      };
    },

    grumble(board, ctx, out, at, p) {
      // "Brrm-brrmph": a cross little motor, square waves through a low-pass with a rattle.
      return {
        sources: [
          ...ringTone(ctx, out, { f0: 190 * p, f1: 150 * p, ring: 32, depth: 0.7, at, dur: 0.17, peak: 0.42, attack: 0.02, cutoff: 760 }),
          ...ringTone(ctx, out, { f0: 160 * p, f1: 98 * p, ring: 26, depth: 0.7, at: at + 0.2, dur: 0.3, peak: 0.48, attack: 0.025, cutoff: 680 }),
        ],
        duration: 0.5,
      };
    },

    bounce(board, ctx, out, at, p) {
      return {
        sources: [
          tone(ctx, out, { f0: 190 * p, f1: 95 * p, at, dur: 0.11, peak: 0.55, attack: 0.002 }),
          hiss(board, ctx, out, { at, dur: 0.025, type: 'lowpass', freq: 800, q: 0.5, peak: 0.12 }),
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
        hiss(board, ctx, out, { at: at + delay, dur: 0.07, type: 'bandpass', freq: (1700 + i * 250) * p, q: 0.8, peak: 0.28, attack: 0.012 }),
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
        sources: ringTone(ctx, out, { f0: 1320 * p, f1: 1250 * p, ring: 70, depth: 0.35, at, dur: 0.08, peak: 0.36, attack: 0.003, cutoff: 2600 }),
        duration: 0.09,
      };
    },

    powerdown(board, ctx, out, at, p) {
      // Winding down, with a wobble that slows.
      return {
        sources: ringTone(ctx, out, { type: 'triangle', f0: 700 * p, f1: 140 * p, ring: 18, depth: 0.45, at, dur: 0.42, peak: 0.45, attack: 0.01, cutoff: 1800 }),
        duration: 0.43,
      };
    },

    boot(board, ctx, out, at, p) {
      // A rising chime: C E G, then the C above rings a little longer, with a soft metallic edge.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const sources = notes.flatMap((f, i) =>
        ringTone(ctx, out, { type: 'triangle', f0: f * p, ring: 60, depth: 0.25, at: at + i * 0.09, dur: i === notes.length - 1 ? 0.42 : 0.16, peak: 0.36, attack: 0.005, cutoff: 3200 }),
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

  Object.assign(RECIPES, {
    chirp(board, ctx, out, at, p) {
      // Robot babble: five or six quick blips stepping up and down.
      const steps = 5 + Math.floor(board.random() * 2);
      const step = 0.06;
      const sources = [];
      let f = (700 + board.random() * 500) * p;
      for (let i = 0; i < steps; i += 1) {
        const next = f * (board.random() < 0.5 ? 0.82 : 1.22) * (0.95 + board.random() * 0.1);
        sources.push(...fmBlip(ctx, out, { f0: f, f1: next, ratio: 1.5, index: 0.5, at: at + i * step, dur: step * 0.9, peak: 0.34, attack: 0.004 }));
        f = Math.min(2400 * p, Math.max(380 * p, next));
      }
      return { sources, duration: steps * step };
    },

    charge(board, ctx, out, at, p) {
      // Powering up: a whine that rises, its wobble getting faster.
      const dur = 0.85;
      const whine = ringTone(ctx, out, { type: 'sine', f0: 220 * p, f1: 1500 * p, ring: 8, depth: 0.5, at, dur, peak: 0.4, attack: 0.25, cutoff: 4000 });
      whine[1].frequency.exponentialRampToValueAtTime(34, at + dur);
      const body = tone(ctx, out, { type: 'triangle', f0: 110 * p, f1: 750 * p, at, dur, peak: 0.16, attack: 0.3 });
      return { sources: [...whine, body], duration: dur };
    },

    laser(board, ctx, out, at, p) {
      // "Pew", then the buzzing beam for as long as it sweeps.
      const dur = 1.5;
      const sources = [tone(ctx, out, { f0: 2400 * p, f1: 900 * p, at, dur: 0.12, peak: 0.4, attack: 0.002 })];
      const buzz = ctx.createOscillator();
      buzz.type = 'sawtooth';
      buzz.frequency.setValueAtTime(440 * p, at);
      const vibrato = ctx.createOscillator();
      vibrato.frequency.setValueAtTime(9, at);
      const vibDepth = ctx.createGain();
      vibDepth.gain.setValueAtTime(22 * p, at);
      vibrato.connect(vibDepth);
      vibDepth.connect(buzz.frequency);
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.setValueAtTime(1600 * p, at);
      band.Q.setValueAtTime(1.6, at);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(0.32, at + 0.08);
      amp.gain.setValueAtTime(0.32, at + dur - 0.3);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + dur);
      buzz.connect(band);
      band.connect(amp);
      amp.connect(out);
      buzz.start(at);
      vibrato.start(at);
      buzz.stop(at + dur + 0.02);
      vibrato.stop(at + dur + 0.02);
      sources.push(buzz, vibrato);
      sources.push(...ringTone(ctx, out, { type: 'sine', f0: 1760 * p, ring: 60, depth: 0.8, at, dur, peak: 0.12, attack: 0.08, cutoff: 5000 }));
      return { sources, duration: dur };
    },

    launch(board, ctx, out, at, p) {
      // A thump out of the hatch and the rush of the rocket.
      return {
        sources: [
          tone(ctx, out, { f0: 170 * p, f1: 60 * p, at, dur: 0.12, peak: 0.6, attack: 0.002 }),
          hiss(board, ctx, out, { at, dur: 0.38, type: 'bandpass', freq: 900 * p, q: 0.7, peak: 0.32, attack: 0.04 }),
        ],
        duration: 0.4,
      };
    },

    boom(board, ctx, out, at, p) {
      // A deep thump and a rumble that dies down (soft: a toy blast, not a real one).
      const rumble = ctx.createBufferSource();
      rumble.buffer = board.noiseBuffer(ctx);
      rumble.loop = true;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.setValueAtTime(700 * p, at);
      lowpass.frequency.exponentialRampToValueAtTime(110 * p, at + 0.8);
      const amp = ctx.createGain();
      amp.gain.setValueAtTime(SILENT, at);
      amp.gain.linearRampToValueAtTime(0.6, at + 0.01);
      amp.gain.exponentialRampToValueAtTime(SILENT, at + 0.8);
      rumble.connect(lowpass);
      lowpass.connect(amp);
      amp.connect(out);
      rumble.start(at);
      rumble.stop(at + 0.82);
      return { sources: [tone(ctx, out, { f0: 95 * p, f1: 36 * p, at, dur: 0.6, peak: 0.8, attack: 0.004 }), rumble], duration: 0.82 };
    },

    holo(board, ctx, out, at, p) {
      // Three blips going up and a soft sweep: the screen of light switches on.
      const sources = [880, 1320, 1760].flatMap((f, i) =>
        ringTone(ctx, out, { f0: f * p, ring: 90, depth: 0.3, at: at + i * 0.07, dur: 0.07, peak: 0.24, attack: 0.003, cutoff: 3000 }),
      );
      sources.push(tone(ctx, out, { f0: 400 * p, f1: 1600 * p, at, dur: 0.38, peak: 0.16, attack: 0.05 }));
      return { sources, duration: 0.4 };
    },

    yawn(board, ctx, out, at, p) {
      // A sleepy "aaa-oh", sliding down, through a vowel that closes.
      const dur = 1;
      const voice = ringTone(ctx, out, { type: 'triangle', f0: 520 * p, f1: 230 * p, ring: 5, depth: 0.35, at, dur, peak: 0.34, attack: 0.12, cutoff: 1400 });
      return { sources: voice, duration: dur };
    },

    done(board, ctx, out, at, p) {
      // Finished: a quick robot fanfare, C E G and the C above.
      const notes = [523.25, 659.25, 783.99, 1046.5];
      const sources = notes.flatMap((f, i) =>
        ringTone(ctx, out, { f0: f * p, ring: 45, depth: 0.25, at: at + i * 0.075, dur: i === notes.length - 1 ? 0.3 : 0.1, peak: 0.3, attack: 0.004, cutoff: 2800 }),
      );
      return { sources, duration: 0.225 + 0.3 };
    },

    error(board, ctx, out, at, p) {
      // "Bwow-bwow": something went wrong (soft, not an alarm).
      return {
        sources: [
          ...ringTone(ctx, out, { f0: 330 * p, f1: 220 * p, ring: 30, depth: 0.4, at, dur: 0.16, peak: 0.34, attack: 0.008, cutoff: 1000 }),
          ...ringTone(ctx, out, { f0: 262 * p, f1: 150 * p, ring: 30, depth: 0.4, at: at + 0.19, dur: 0.22, peak: 0.36, attack: 0.008, cutoff: 900 }),
        ],
        duration: 0.42,
      };
    },

    alert(board, ctx, out, at, p) {
      // "Beep-boop?": a question for the user.
      return {
        sources: [
          ...fmBlip(ctx, out, { f0: 880 * p, at, dur: 0.09, peak: 0.36, index: 0.4 }),
          ...fmBlip(ctx, out, { f0: 1320 * p, f1: 1500 * p, at: at + 0.12, dur: 0.14, peak: 0.36, index: 0.4 }),
        ],
        duration: 0.27,
      };
    },
  });

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
      // rb-sit 4 s: down on the ground at 16 %, up again from 84 %.
      sit: sheet([cue(640, 'bounce', 0.8), cue(3360, 'boing', 1.1)]),
      // rb-page from 1.4 s, every 2.2 s: a page turns (a soft flutter).
      read: sheet([cue(1500, 'whoosh', 1.7), cue(3700, 'whoosh', 1.7), cue(5900, 'whoosh', 1.7)]),
      // rb-bubbles-blow 6.6 s: three soft blows (15 / 39 / 63 %), each rb-bubble pops at ~93 % of its run.
      bubbles: sheet([cue(1000, 'whoosh', 1.45), cue(2580, 'whoosh', 1.45), cue(3100, 'tick', 1.7), cue(3780, 'tick', 1.55), cue(4160, 'whoosh', 1.45), cue(4700, 'tick', 1.8), cue(5090, 'tick', 1.6), cue(6480, 'tick', 1.4)]),
      // rb-plane-* 5.6 s: the throw at 28 %, back in the hand at 86 % (PLANE_CATCH_MS).
      plane: sheet([cue(1550, 'whoosh', 1.25), cue(4820, 'chirp', 1.35)]),
      // rb-coffee-* 5.6 s: three sips (25 / 49 / 71 %), then "Ahh" at ~4.55 s (COFFEE_AH_MS).
      coffee: sheet([cue(1400, 'whoosh', 0.7), cue(2740, 'whoosh', 0.7), cue(3980, 'whoosh', 0.7), cue(4550, 'chirp', 1.1)]),
    }),
    /**
     * The rampage's phases (app/rampage.js: four launches 320 ms apart, the
     * missile phase starts 150 ms before the first; flights of ~1 s).
     */
    rampage: Object.freeze({
      charge: sheet([cue(0, 'charge')]),
      laser: sheet([cue(0, 'laser')]),
      missile: sheet([
        ...every(150, 320, 1400, 'launch', [1, 1.08, 0.94, 1.04]),
        ...every(1150, 320, 2400, 'boom', [1, 0.9, 1.1, 0.95]),
      ]),
      // After the cursor (app/rampage.js chaseLaunches, flights of 0.7-0.9 s): the beams, a launch and a blast each.
      chase: sheet([
        cue(0, 'laser', 0.9),
        cue(700, 'launch'),
        cue(1500, 'boom', 1.05),
        cue(1800, 'launch', 1.08),
        cue(2600, 'boom'),
        cue(2900, 'launch', 0.95),
        cue(3700, 'boom', 0.92),
        cue(3900, 'launch', 1.04),
        cue(4700, 'boom', 1.1),
      ]),
      heal: sheet([cue(0, 'sparkle'), cue(350, 'sparkle', 1.2), cue(700, 'chirp', 0.9)]),
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
      // The laser pointer: a click as it comes on, a chirpy meow, a scrabble at each pounce (rbc-dot-chase 2.4 s).
      laser: sheet([cue(150, 'beep', 1.8), cue(700, 'meow', 1.25), ...every(1500, 2400, 6000, 'scratch', [1.15, 1.3])]),
      // Petted by the robot (after a short walk up to it): it purrs and purrs.
      cuddle: sheet([cue(900, 'purr'), cue(2600, 'purr', 1.05), cue(4300, 'purr')]),
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
     * Pitch for a tap: quick taps one after the other climb (up to 1.5x), with a
     * little random wobble so no two sound quite the same.
     */
    tapPitch() {
      const now = this.now();
      this.streak.count = now - this.streak.at < this.t.streakMs ? this.streak.count + 1 : 0;
      this.streak.at = now;
      const climb = Math.min(1.5, 1 + 0.1 * this.streak.count);
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
