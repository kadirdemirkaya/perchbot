#!/usr/bin/env node
'use strict';

/**
 * Removes Agent Buddy's hooks from Claude Code settings files, and nothing
 * else. By default from every Claude Code account on this computer; takes the
 * same options as setup.js (see --help).
 *
 *   agent-buddy uninstall              (or: npm run uninstall-hooks)
 *   agent-buddy uninstall --dry-run
 *
 * A backup of every file is written before it is changed.
 */

const path = require('node:path');
const os = require('node:os');
const cli = require('./lib/cli');
const hooks = require('./lib/hooks-config');

const USAGE = 'Usage: agent-buddy uninstall [options]   (or: npm run uninstall-hooks -- [options])';

/** Look at one settings file: what would be removed. Prints its part of the report. */
function plan({ file, why }) {
  console.log(`\n  Settings file : ${file}  (${why})`);
  const current = cli.readSettings(file);
  if (!current.exists) {
    console.log('  The file does not exist. Nothing to do.');
    return { file, none: true };
  }
  if (current.error) {
    console.error(`  Stopped: ${current.error}.`);
    return { file, error: true };
  }
  const { settings, removed } = hooks.removeHooks(current.data);
  if (removed === 0) {
    console.log('  No Agent Buddy hooks found. Nothing to do.');
    return { file, none: true };
  }
  console.log(`  Will remove ${removed} Agent Buddy hook(s):`);
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
  return { file, settings, removed, backup };
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = cli.parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}\n\n${cli.USAGE_TARGETS}`);
    return 2;
  }
  if (opts.help) {
    console.log(`${USAGE}\n\nRemoves only the hooks Agent Buddy added.\n\n${cli.USAGE_TARGETS}`);
    return 0;
  }

  console.log('Agent Buddy: remove hooks');
  const plans = cli.resolveTargets(opts).map(plan);
  if (plans.some((p) => p.error)) {
    console.error('\n  Nothing was written: the files were NOT changed.');
    return 1;
  }
  const writes = plans.filter((p) => p.settings);
  if (!writes.length) return 0;

  if (opts.dryRun) {
    console.log('\n  --dry-run: nothing was written.');
    return 0;
  }
  const question = writes.length > 1 ? `Remove the hooks from ${writes.length} files?` : 'Apply these changes?';
  if (!(await cli.approved(opts, question))) {
    console.log('  Cancelled. Nothing was written.');
    return 1;
  }

  for (const p of writes) {
    try {
      cli.makeBackup(p.file, p.backup);
      cli.writeJsonAtomic(p.file, p.settings);
    } catch (err) {
      console.error(`\n  Failed to write ${p.file}: ${err.message}`);
      return 1;
    }
    console.log(`\n  Done. Removed ${p.removed} hook(s) from ${p.file}. Backup: ${p.backup}`);
  }

  const home = process.env.AGENT_BUDDY_HOME || path.join(os.homedir(), '.agent-buddy');
  console.log(
    `\n  Agent Buddy's own settings, logs and cache are in ${home}\n` +
      '  Delete that folder too if you want to remove everything.',
  );
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
    },
  );
}

module.exports = { main };
