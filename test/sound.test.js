'use strict';

/** Sounds made in code (app/renderer/lib/sound.js), against a fake AudioContext. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SoundBoard, VOLUMES, NAMES } = require('../app/renderer/lib/sound');

/** Records what a sound builds; enough of the Web Audio API for the recipes. */
function fakeAudio() {
  const log = { contexts: 0, started: 0, stopped: 0, suspended: 0, resumed: 0, closed: 0, frequencies: [] };
  const param = (record) => ({
    value: 0,
    setValueAtTime(v) {
      if (record) log.frequencies.push(v);
      this.value = v;
    },
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  const node = (extra = {}) => ({ connect() {}, ...extra });
  const source = (extra = {}) =>
    node({
      start() {
        log.started += 1;
      },
      stop() {
        log.stopped += 1;
      },
      ...extra,
    });
  const create = () => {
    log.contexts += 1;
    const ctx = {
      state: 'running',
      currentTime: 0,
      sampleRate: 8000,
      destination: node(),
      createGain: () => node({ gain: param(false) }),
      createOscillator: () => source({ type: 'sine', frequency: param(true) }),
      createBiquadFilter: () => node({ type: 'lowpass', frequency: param(false), Q: param(false) }),
      createBufferSource: () => source({ buffer: null, loop: false }),
      createBuffer: (_channels, length) => {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
      },
      suspend() {
        log.suspended += 1;
        ctx.state = 'suspended';
        return Promise.resolve();
      },
      resume() {
        log.resumed += 1;
        ctx.state = 'running';
        return Promise.resolve();
      },
      close() {
        log.closed += 1;
        ctx.state = 'closed';
        return Promise.resolve();
      },
    };
    return ctx;
  };
  return { log, create };
}

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, at: now + ms });
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at).find(([, t]) => t.at <= end);
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function board(extra = {}) {
  const audio = fakeAudio();
  const clock = fakeClock();
  const b = new SoundBoard({ createContext: audio.create, clock, now: clock.now, random: () => 0.5, ...extra });
  return { b, audio, clock };
}

test('sound: off by default, and no AudioContext until the first sound', () => {
  const { b, audio } = board();
  assert.equal(b.play('bonk'), false, 'off by default');
  assert.equal(audio.log.contexts, 0);
  b.setEnabled(true);
  assert.equal(audio.log.contexts, 0, 'turning it on creates nothing yet');
  assert.equal(b.play('bonk'), true);
  assert.equal(audio.log.contexts, 1);
  assert.equal(b.play('no-such-sound'), false);
});

test('sound: every sound builds and plays with the fake context', () => {
  const { b, clock } = board();
  b.setEnabled(true);
  for (const name of NAMES) {
    assert.equal(b.play(name), true, name);
    clock.advance(2000);
  }
  assert.deepEqual([...NAMES].sort(), ['bonk', 'bounce', 'clang', 'crack', 'grumble', 'purr', 'scratch']);
});

test('sound: at most five at once, the same one at most every 45 ms', () => {
  const { b, clock } = board();
  b.setEnabled(true);
  assert.equal(b.play('purr'), true);
  assert.equal(b.play('purr'), false, 'too soon');
  clock.advance(50);
  for (const name of ['clang', 'grumble', 'scratch', 'bounce']) assert.equal(b.play(name), true, name);
  assert.equal(b.active, 5);
  assert.equal(b.play('crack'), false, 'a sixth is dropped');
  clock.advance(200);
  assert.ok(b.active < 5, 'short ones have ended');
  assert.equal(b.play('crack'), true);
});

test('sound: quick taps climb in pitch, a pause starts over', () => {
  const { b, clock, audio } = board();
  b.setEnabled(true);
  const pitches = [];
  for (let i = 0; i < 4; i += 1) {
    pitches.push(b.tapPitch());
    clock.advance(300);
  }
  assert.ok(pitches[0] < pitches[1] && pitches[1] < pitches[2] && pitches[2] < pitches[3], pitches.join());
  clock.advance(2000);
  assert.equal(b.tapPitch(), pitches[0], 'after a pause it starts low again');
  for (let i = 0; i < 30; i += 1) {
    clock.advance(100);
    b.tapPitch();
  }
  assert.ok(b.tapPitch() <= 1.8 * 1.04, 'it does not climb forever');
  // The pitch reaches the oscillators.
  audio.log.frequencies.length = 0;
  b.play('bonk', { pitch: 1.5 });
  assert.equal(audio.log.frequencies[0], 430 * 1.5);
});

test('sound: stops at once, then suspends and finally closes the context', () => {
  const { b, audio, clock } = board();
  b.setEnabled(true);
  b.play('purr');
  b.stopAll();
  assert.equal(b.active, 0);
  assert.ok(audio.log.stopped >= 2, 'its sources were stopped');
  clock.advance(1999);
  assert.equal(audio.log.suspended, 0);
  clock.advance(2);
  assert.equal(audio.log.suspended, 1, 'suspended 2 s after the last sound');
  b.play('bonk');
  assert.equal(audio.log.resumed, 1, 'a new sound resumes it');
  clock.advance(200 + 2000 + 60000);
  assert.equal(audio.log.closed, 1, 'closed after a minute of silence');
  b.play('bonk');
  assert.equal(audio.log.contexts, 2, 'the next sound makes a new one');
});

test('sound: turning it off closes everything; volume levels', () => {
  const { b, audio } = board();
  b.setEnabled(true);
  b.play('clang');
  b.setEnabled(false);
  assert.equal(audio.log.closed, 1);
  assert.equal(b.play('clang'), false);
  b.setVolume('high');
  assert.equal(b.volume, VOLUMES.high);
  b.setVolume('deafening');
  assert.equal(b.volume, VOLUMES.low);
  assert.ok(VOLUMES.low < VOLUMES.medium && VOLUMES.medium < VOLUMES.high && VOLUMES.high <= 0.6);
});

test('sound: no audio available is not an error', () => {
  const b = new SoundBoard({
    createContext: () => {
      throw new Error('no audio device');
    },
  });
  b.setEnabled(true);
  assert.equal(b.play('bonk'), false);
});
