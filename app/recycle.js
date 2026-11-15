'use strict';

/**
 * "Follow Windows" (opt-in, Windows only, off by default): when the user deletes a file or
 * a folder in Windows (it goes to the Recycle Bin), the buddy comes and cuts a ghost of it
 * with its sword. It deletes nothing itself and restores nothing; it only reacts.
 *
 * Windows keeps every deleted item as a pair in `<drive>:\$Recycle.Bin\<user SID>\`:
 * `$R<id>.<ext>` (the item itself; a folder stays a folder) and `$I<id>.<ext>` (a small
 * record with the original path). A new `$I` name there means a new delete. Of that record
 * only the extension is used (and whether the `$R` is a folder): the name and the path are
 * never kept, logged or sent anywhere.
 *
 * Honest limits: it sees a delete after Windows has made it; Shift+Delete and deletes from
 * a command line (rm, del) skip the Recycle Bin, so they are not seen.
 *
 * Pure parts (extFromRecord, kindOf, DeleteBatch) take their input and an injectable
 * clock; createRecycleWatcher wires them to node:fs (no other dependency).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RECYCLE = Object.freeze({
  /** Deletes this close together (ms) are one show: the burst ends after this long without a new one... */
  burstMs: 400,
  /** ...or this long after its first delete, whatever comes after. */
  burstMaxMs: 1500,
  /** The $I record (and its $R) can be written a moment after the event: read again this often... */
  retryMs: 60,
  /** ...this many times. */
  retries: 10,
  /** A record bigger than this is not one (bytes): v2 is 28 bytes + the path, v1 is 544. */
  maxRecordBytes: 70000,
});

/** File types the show tells apart by colour (pdf red, word blue, image green, folder yellow, other teal). */
const KINDS = Object.freeze(['pdf', 'word', 'image', 'folder', 'other']);

const WORD_EXTS = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif']);

/** A record's file name: `$I` and its id (`$IAB12CD.pdf`). */
const RECORD_RE = /^\$I[^\\/]+$/i;

function isRecordName(name) {
  return typeof name === 'string' && RECORD_RE.test(name);
}

/**
 * The extension of the deleted item, from its $I record: lower case, without the dot,
 * '' when it has none; null when this is not a record we know. Only the extension leaves
 * this function, never the name or the path.
 *
 * v2 (Windows 10 and later): 8 bytes version, 8 size, 8 deletion time, 4 path length in
 * characters, then the path in UTF-16. v1 (older): the path in a fixed 520-byte field at 24.
 * @param {Buffer} buf
 * @returns {string|null}
 */
function extFromRecord(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28 || buf.length > RECYCLE.maxRecordBytes) return null;
  let version;
  try {
    version = Number(buf.readBigUInt64LE(0));
  } catch {
    return null;
  }
  let original;
  if (version === 2) {
    const chars = buf.readUInt32LE(24);
    if (chars < 1 || 28 + chars * 2 > buf.length) return null;
    original = buf.toString('utf16le', 28, 28 + chars * 2);
  } else if (version === 1) {
    if (buf.length < 24 + 2) return null;
    original = buf.toString('utf16le', 24, Math.min(buf.length, 24 + 520));
  } else {
    return null;
  }
  original = original.replace(/\0[\s\S]*$/, '');
  if (!original) return null;
  const ext = path.win32.extname(path.win32.basename(original)).slice(1).toLowerCase();
  // Something odd (a very long or strange "extension"): no extension as far as the show cares.
  return /^[a-z0-9_-]{1,12}$/.test(ext) ? ext : '';
}

/**
 * What the show draws for it.
 * @param {string|null} ext  from extFromRecord
 * @param {boolean} [isDir]  its $R is a folder
 * @returns {'pdf'|'word'|'image'|'folder'|'other'}
 */
function kindOf(ext, isDir = false) {
  if (isDir) return 'folder';
  if (ext === 'pdf') return 'pdf';
  if (WORD_EXTS.has(ext)) return 'word';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'other';
}

/**
 * Deletes that come together (several files selected at once) become one show:
 * onBatch({ kind, count, kinds }) once the burst is over. kind = the first one's,
 * kinds = how many of each.
 */
class DeleteBatch {
  /**
   * @param {object} o
   * @param {(batch: { kind: string, count: number, kinds: object }) => void} o.onBatch
   * @param {{ setTimeout: Function, clearTimeout: Function }} [o.clock]
   * @param {() => number} [o.now]
   * @param {Partial<typeof RECYCLE>} [o.timings]
   */
  constructor({ onBatch, clock = { setTimeout, clearTimeout }, now = Date.now, timings = {} }) {
    this.onBatch = onBatch;
    this.clock = clock;
    this.now = now;
    this.t = { ...RECYCLE, ...timings };
    this.batch = null;
    this.timer = null;
  }

  add(kind) {
    const k = KINDS.includes(kind) ? kind : 'other';
    const now = this.now();
    if (!this.batch) this.batch = { kind: k, count: 0, kinds: {}, first: now };
    this.batch.count += 1;
    this.batch.kinds[k] = (this.batch.kinds[k] || 0) + 1;
    if (this.timer) this.clock.clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.t.burstMs, this.batch.first + this.t.burstMaxMs - now));
    this.timer = this.clock.setTimeout(() => this.flush(), wait);
  }

  flush() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const b = this.batch;
    this.batch = null;
    if (b) this.onBatch({ kind: b.kind, count: b.count, kinds: { ...b.kinds } });
  }

  dispose() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.batch = null;
  }
}

/** The current user's SID ("S-1-5-21-..."), from `whoami /user` (Windows' own tool), or null. */
function userSid({ run = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      run('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        const m = !err && /S-1-\d+(?:-\d+)+/.exec(String(stdout || ''));
        resolve(m ? m[0] : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** The user's Recycle Bin folders on drives C: to Z: that have one (the folder exists). */
async function recycleDirs(sid, { fsp = fs.promises } = {}) {
  if (typeof sid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(sid)) return [];
  const found = [];
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const dir = `${String.fromCharCode(c)}:\\$Recycle.Bin\\${sid}`;
    try {
      if ((await fsp.stat(dir)).isDirectory()) found.push(dir);
    } catch {
      // no such drive, or no Recycle Bin there
    }
  }
  return found;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watches Recycle Bin folders and reports new deletes (batched) as { kind, count, kinds }.
 * Records that are there at the start are old: only names it has not seen count (an old
 * record can fire 'change' when Windows touches it). A record that disappears (the bin
 * emptied, an item restored) is forgotten, so its name may count again later.
 *
 * @param {object} o
 * @param {string[]} o.dirs
 * @param {(batch: { kind: string, count: number, kinds: object }) => void} o.onDelete
 * @param {{ devOnly?: Function, warn?: Function }} [o.log]
 * @param {typeof fs} [o.fsImpl]
 * @param {Partial<typeof RECYCLE>} [o.timings]
 * @returns {Promise<{ stop: () => void, dirs: string[] }>}
 */
async function createRecycleWatcher({ dirs, onDelete, log = {}, fsImpl = fs, timings = {} }) {
  const t = { ...RECYCLE, ...timings };
  const warn = (m) => log.warn && log.warn(m);
  const batch = new DeleteBatch({ onBatch: onDelete, timings: t });
  const watchers = [];
  let stopped = false;

  async function readKind(dir, name) {
    const file = path.join(dir, name);
    for (let i = 0; i < t.retries && !stopped; i++) {
      let buf = null;
      try {
        buf = await fsImpl.promises.readFile(file);
      } catch (err) {
        if (err && err.code === 'ENOENT' && i > 0) return { gone: true };
      }
      const ext = buf ? extFromRecord(buf) : null;
      if (ext !== null) {
        // A folder: its $R is a directory (it may land a moment after the record).
        const item = path.join(dir, '$R' + name.slice(2));
        for (let j = 0; j < t.retries && !stopped; j++) {
          try {
            return { kind: kindOf(ext, (await fsImpl.promises.stat(item)).isDirectory()) };
          } catch {
            await wait(t.retryMs);
          }
        }
        return { kind: kindOf(ext, false) };
      }
      await wait(t.retryMs);
    }
    return { gone: true };
  }

  for (const dir of dirs) {
    let known;
    try {
      known = new Set((await fsImpl.promises.readdir(dir)).filter(isRecordName).map((n) => n.toUpperCase()));
    } catch (err) {
      warn(`follow windows: cannot read a Recycle Bin folder (${err && err.code})`);
      continue;
    }
    if (stopped) break;
    let watcher;
    try {
      watcher = fsImpl.watch(dir, { persistent: false }, (_type, raw) => {
        const name = raw ? String(raw) : '';
        if (stopped || !isRecordName(name)) return;
        const key = name.toUpperCase();
        if (known.has(key)) {
          // Gone (emptied, restored): forget it. Still there: an old record, touched.
          fsImpl.promises.access(path.join(dir, name)).catch(() => known.delete(key));
          return;
        }
        known.add(key);
        readKind(dir, name).then((r) => {
          if (stopped) return;
          if (r.gone) {
            known.delete(key);
            return;
          }
          batch.add(r.kind);
        });
      });
    } catch (err) {
      warn(`follow windows: cannot watch a Recycle Bin folder (${err && err.code})`);
      continue;
    }
    watcher.on('error', (err) => {
      warn(`follow windows: watching stopped (${err && err.code})`);
      try {
        watcher.close();
      } catch {
        // closed already
      }
    });
    watchers.push(watcher);
  }

  return {
    dirs: dirs.slice(),
    stop() {
      stopped = true;
      batch.dispose();
      for (const w of watchers.splice(0)) {
        try {
          w.close();
        } catch {
          // closed already
        }
      }
    },
  };
}

/** Where it works: Windows only (the Recycle Bin layout above). */
function supported(platform = process.platform) {
  return platform === 'win32';
}

module.exports = {
  RECYCLE,
  KINDS,
  isRecordName,
  extFromRecord,
  kindOf,
  DeleteBatch,
  userSid,
  recycleDirs,
  createRecycleWatcher,
  supported,
};
