'use strict';

/**
 * Character discovery. A character is a folder containing character.json plus
 * the SVG and CSS files it names. Folders are searched in order; the first
 * character with a given id (folder name) wins:
 *
 *   1. <repo>/characters/<id>/            bundled characters
 *   2. ~/.perchbot/characters/<id>/    your own, no repo changes needed
 *
 * See characters/README.md for the format.
 */

const fs = require('node:fs');
const path = require('node:path');

const STATES = [
  'idle',
  'greeting',
  'thinking',
  'typing',
  'reading',
  'running',
  'working',
  'waiting',
  'asking',
  'standby',
  'done',
  'goodbye',
];

/**
 * Newer states fall back to an older one when a character does not declare
 * them, so characters written for an earlier version keep working.
 */
const STATE_FALLBACKS = Object.freeze({ asking: 'waiting', standby: 'idle' });

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const CSS_STATE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_ASSET_BYTES = 512 * 1024;

function text(value, max, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function fraction(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Load and validate one character folder.
 * @returns {{ character?: object, error?: string }}
 */
function loadCharacter(dir, id) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8'));
  } catch (err) {
    return { error: `${id}: cannot read character.json (${err.message})` };
  }
  if (!manifest || typeof manifest !== 'object') return { error: `${id}: character.json must be an object` };

  for (const field of ['svg', 'css']) {
    const problem = assetProblem(dir, manifest[field], field);
    if (problem) return { error: `${id}: ${problem}` };
  }

  const states = {};
  const declared = manifest.states && typeof manifest.states === 'object' ? manifest.states : {};
  const declaredValue = (state) => {
    const value = declared[state];
    return typeof value === 'string' && CSS_STATE_RE.test(value) ? value : null;
  };
  for (const state of STATES) {
    const fallback = STATE_FALLBACKS[state];
    states[state] = declaredValue(state) || (fallback && (declaredValue(fallback) || fallback)) || state;
  }

  const anchor = manifest.bubbleAnchor && typeof manifest.bubbleAnchor === 'object' ? manifest.bubbleAnchor : {};
  const eyes = manifest.lookAnchor && typeof manifest.lookAnchor === 'object' ? manifest.lookAnchor : {};

  return {
    character: {
      id,
      dir,
      name: text(manifest.name, 40, id),
      author: text(manifest.author, 60, 'unknown'),
      license: text(manifest.license, 40, 'unknown'),
      description: text(manifest.description, 200, ''),
      svg: manifest.svg,
      css: manifest.css,
      states,
      blink: manifest.blink !== false,
      confetti: manifest.confetti !== false,
      bubbleAnchor: { x: fraction(anchor.x, 0.5), y: fraction(anchor.y, 0.1) },
      lookAnchor: { x: fraction(eyes.x, 0.5), y: fraction(eyes.y, 0.35) },
      mini: loadMini(dir, manifest.mini),
      pet: loadPet(dir, manifest.pet),
    },
  };
}

/** Why a manifest file entry is unusable, or null when it is fine. */
function assetProblem(dir, file, field) {
  if (typeof file !== 'string' || !FILE_RE.test(file) || file.includes('..')) {
    return `"${field}" must be a plain file name inside the character folder`;
  }
  let stat;
  try {
    stat = fs.statSync(path.join(dir, file));
  } catch {
    return `${field} file "${file}" not found`;
  }
  if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) {
    return `${field} file "${file}" must be a file under ${MAX_ASSET_BYTES / 1024} KB`;
  }
  return null;
}

/** Optional "pet": { "svg", "css" }: the cat (or any pet) that can be called from the menu. */
function loadPet(dir, pet) {
  if (!pet || typeof pet !== 'object') return null;
  if (assetProblem(dir, pet.svg, 'pet.svg') || assetProblem(dir, pet.css, 'pet.css')) return null;
  return { svg: pet.svg, css: pet.css };
}

/**
 * Optional "mini": { "svg", "css", "tints" } drawn once per sub-agent. A
 * character without a (valid) mini shows a small "N helpers" badge instead.
 * tints: how many colour variants the CSS defines for data-tint (0..tints-1).
 */
function loadMini(dir, mini) {
  if (!mini || typeof mini !== 'object') return null;
  if (assetProblem(dir, mini.svg, 'mini.svg') || assetProblem(dir, mini.css, 'mini.css')) return null;
  const tints = Number.isInteger(mini.tints) && mini.tints >= 1 && mini.tints <= 12 ? mini.tints : 1;
  return { svg: mini.svg, css: mini.css, tints };
}

/**
 * @param {string[]} roots  folders that contain character folders
 * @returns {{ characters: Map<string, object>, errors: string[] }}
 */
function discoverCharacters(roots) {
  const characters = new Map();
  const errors = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // folder does not exist
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      if (!fs.existsSync(path.join(dir, 'character.json'))) continue;
      if (characters.has(entry.name)) {
        errors.push(`${entry.name}: duplicate id in ${root}, keeping the first one`);
        continue;
      }
      const result = loadCharacter(dir, entry.name);
      if (result.character) characters.set(entry.name, result.character);
      else errors.push(result.error);
    }
  }
  return { characters, errors };
}

module.exports = { discoverCharacters, loadCharacter, STATES, STATE_FALLBACKS };
