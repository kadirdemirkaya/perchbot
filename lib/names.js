'use strict';

/**
 * The project's names in one place. Perchbot was called "Agent Buddy" before
 * its first public release; the old names keep working so that an existing
 * install goes on as it was:
 *
 *   - the settings folder: ~/.perchbot, but an existing ~/.agent-buddy is
 *     used for as long as there is no ~/.perchbot (nothing is moved);
 *   - environment variables: PERCHBOT_<KEY>, else the old AGENT_BUDDY_<KEY>;
 *   - hook commands: tagged --perchbot; ones tagged --agent-buddy are still
 *     recognised (setup replaces them, uninstall removes them).
 *
 * Node built-ins only: the hook (hooks/send.js) loads it too.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'Perchbot';
const ID = 'perchbot';
/** The tag at the end of our hook commands, and the tags older versions used. */
const MARKER = '--perchbot';
const OLD_MARKERS = Object.freeze(['--agent-buddy']);
const HOME_DIR = '.perchbot';
const OLD_HOME_DIR = '.agent-buddy';
const ENV_PREFIX = 'PERCHBOT_';
const OLD_ENV_PREFIX = 'AGENT_BUDDY_';

/** PERCHBOT_<key>, else the old AGENT_BUDDY_<key> (undefined when neither is set). */
function envValue(key, env = process.env) {
  const now = env[`${ENV_PREFIX}${key}`];
  if (now !== undefined && now !== '') return now;
  const old = env[`${OLD_ENV_PREFIX}${key}`];
  return old !== undefined && old !== '' ? old : undefined;
}

/**
 * The settings folder: PERCHBOT_HOME (or AGENT_BUDDY_HOME) when set, else
 * ~/.perchbot, or ~/.agent-buddy when only that one exists (an install from
 * before the rename).
 */
function homeDir(env = process.env, { homedir = os.homedir(), exists = fs.existsSync } = {}) {
  const override = envValue('HOME', env);
  if (override) return path.resolve(override);
  const current = path.join(homedir, HOME_DIR);
  const old = path.join(homedir, OLD_HOME_DIR);
  return !exists(current) && exists(old) ? old : current;
}

module.exports = { NAME, ID, MARKER, OLD_MARKERS, HOME_DIR, OLD_HOME_DIR, envValue, homeDir };
