#!/usr/bin/env node
'use strict';

/**
 * Removes Agent Buddy's hooks from a Claude Code settings file, and nothing
 * else. Takes the same options as setup.js (see --help).
 *
 *   npm run uninstall-hooks
 *   npm run uninstall-hooks -- --dry-run
 *
 * A backup of the file is written before it is changed.
 */

const path = require('node:path');
const os = require('node:os');
const cli = require('./lib/cli');
const hooks = require('./lib/hooks-config');

async function main() {
  let opts;
  try {
    opts = cli.parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\nUsage: npm run uninstall-hooks -- [options]\n\n${cli.USAGE_TARGETS}`);
    return 2;
  }
  if (opts.help) {
    console.log(
      `Usage: npm run uninstall-hooks -- [options]\n\nRemoves only the hooks Agent Buddy added.\n\n${cli.USAGE_TARGETS}`,
    );
    return 0;
  }

  const { file, why } = cli.resolveTarget(opts);
  console.log('Agent Buddy: remove hooks\n');
  console.log(`  Settings file : ${file}  (${why})`);

  const current = cli.readSettings(file);
  if (!current.exists) {
    console.log('\n  The file does not exist. Nothing to do.');
    return 0;
  }
  if (current.error) {
    console.error(`\n  Stopped: ${current.error}.\n  The file was NOT changed.`);
    return 1;
  }

  const { settings, removed } = hooks.removeHooks(current.data);
  if (removed === 0) {
    console.log('\n  No Agent Buddy hooks found. Nothing to do.');
    return 0;
  }

  console.log(`\n  Will remove ${removed} Agent Buddy hook(s):`);
  for (const [event, groups] of Object.entries(current.data.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const handler of (group && Array.isArray(group.hooks) ? group.hooks : []).filter(hooks.isOurHandler)) {
        console.log(`    ${event.padEnd(20)} ${handler.command}`);
      }
    }
  }
  console.log(`  Other hooks   : ${hooks.countOtherHandlers(current.data)} handler(s), kept as they are`);
  const backup = cli.backupPath(file);
  console.log(`  Backup        : ${backup}`);

  if (opts.dryRun) {
    console.log('\n  --dry-run: nothing was written.');
    return 0;
  }
  if (!(await cli.approved(opts))) {
    console.log('  Cancelled. Nothing was written.');
    return 1;
  }

  try {
    cli.makeBackup(file, backup);
    cli.writeJsonAtomic(file, settings);
  } catch (err) {
    console.error(`\n  Failed to write ${file}: ${err.message}`);
    return 1;
  }

  const home = process.env.AGENT_BUDDY_HOME || path.join(os.homedir(), '.agent-buddy');
  console.log(`\n  Done. Removed ${removed} hook(s). Backup: ${backup}`);
  console.log(
    `  Agent Buddy's own settings, logs and cache are in ${home}\n` +
      '  Delete that folder too if you want to remove everything.',
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  },
);
