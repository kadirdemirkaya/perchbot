'use strict';

/**
 * Getting Electron's binary onto the disk.
 *
 * Electron 45 no longer downloads its binary while `npm install` runs; its
 * package does that the first time `require('electron')` is called. Perchbot
 * never calls that (hooks/send.js electronBinary reads path.txt and dist/
 * itself, so the hook stays fast), so a fresh `npm install -g perchbot` has
 * no binary and the overlay cannot start.
 *
 * ensureElectron() runs Electron's own installer (electron/install.js: download,
 * checksum, unzip into the package's dist/) once, from the commands a person
 * types: setup, start, demo and doctor. Never from the hook, and never from the
 * overlay, which stays offline.
 *
 * Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { electronBinary, electronDirs } = require('../hooks/send');

const SIZE = 'about 100 MB';

/** Electron's installer script in the package Perchbot would use, or null. */
function installerPath({ dirs = electronDirs(), exists = fs.existsSync } = {}) {
  for (const dir of dirs) {
    const file = path.join(dir, 'install.js');
    if (exists(file)) return file;
  }
  return null;
}

/**
 * Make sure the binary is there; when it is not, download it once.
 *
 * @param {object} [o]
 * @param {() => string|null} [o.find]  the binary, or null (hooks/send.js electronBinary)
 * @param {() => string|null} [o.installer]  path of electron/install.js, or null
 * @param {typeof spawnSync} [o.run]
 * @param {(line: string) => void} [o.log]
 * @returns {{ ok: boolean, binary: string|null, downloaded: boolean, reason?: 'no-package'|'failed', installer?: string }}
 */
function ensureElectron({ find = electronBinary, installer = installerPath, run = spawnSync, log = console.log } = {}) {
  const found = find();
  if (found) return { ok: true, binary: found, downloaded: false };
  const script = installer();
  if (!script) return { ok: false, binary: null, downloaded: false, reason: 'no-package' };
  log(`  Downloading Electron, the window the robot lives in (${SIZE}, only this once)...`);
  const result = run(process.execPath, [script], { cwd: path.dirname(script), stdio: 'inherit', windowsHide: true });
  const binary = result && result.status === 0 ? find() : null;
  if (!binary) return { ok: false, binary: null, downloaded: false, reason: 'failed', installer: script };
  log('  Electron is ready.');
  return { ok: true, binary, downloaded: true };
}

/** What to tell the person when ensureElectron() did not work out. */
function failureText(result) {
  if (result.reason === 'no-package') {
    return "Electron's package is missing from this copy of Perchbot. Reinstall it: npm install -g perchbot (npm install in a clone).";
  }
  return (
    'Electron could not be downloaded (offline, or blocked by a proxy?). Try again with "perchbot setup",\n' +
    `  or run its installer yourself: node "${result.installer}"`
  );
}

module.exports = { ensureElectron, installerPath, failureText, SIZE };
