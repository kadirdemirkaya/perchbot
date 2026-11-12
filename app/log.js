'use strict';

/**
 * Logging.
 *  - Console output only when the app runs with --dev.
 *  - File output (~/.agent-buddy/logs/overlay.log) only when "debug": true
 *    in settings. It is off by default.
 *
 * Privacy rule for callers: never pass file contents, full commands,
 * environment variables or bubble text to `info/warn/error`. Those go to the
 * file. `devOnly` is for richer details and only ever reaches the console.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 1024 * 1024;

function createLogger({ dev = false, debug = false, dir } = {}) {
  const file = debug && dir ? path.join(dir, 'overlay.log') : null;

  function writeFile(line) {
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        // no file yet
      }
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      // logging must never break the app
    }
  }

  function emit(level, args) {
    const line = `${new Date().toISOString()} [${level}] ${args.map(String).join(' ')}`;
    if (dev) (level === 'error' ? console.error : console.log)(line);
    writeFile(line);
  }

  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    devOnly: (...args) => {
      if (dev) console.log(`${new Date().toISOString()} [dev] ${args.map(String).join(' ')}`);
    },
  };
}

module.exports = { createLogger };
