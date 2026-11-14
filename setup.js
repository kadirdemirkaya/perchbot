#!/usr/bin/env node
'use strict';

/**
 * Registers Perchbot's hooks in Claude Code settings files.
 *
 *   perchbot setup                  every Claude Code account on this computer
 *   npm run setup                      (the same, from a clone of the repository)
 *   ... --dry-run                      show the changes, write nothing
 *   ... --config-dir <dir>             only that account
 *   ... --project                      this project's .claude/settings.json
 *   ... --help
 *
 * What it does, in order:
 *   1. Finds the settings files (lib/cli.js resolveTargets: ~/.claude,
 *      ~/.claude-<name>, $CLAUDE_CONFIG_DIR) and reads each one. Invalid JSON
 *      anywhere: stops and changes nothing.
 *   2. Prints exactly which hooks it will add to which file, and where each
 *      backup will go.
 *   3. Asks once for confirmation (skip with --yes).
 *   4. Backs up every existing file it changes, then writes the merged result.
 * Other hooks already in the files are kept. Running it again is safe: it
 * refreshes its own entries instead of adding duplicates (and points them at
 * this copy of Perchbot, e.g. after installing it with npm).
 * Undo with: perchbot uninstall (or npm run uninstall-hooks)
 */

const path = require('node:path');
const cli = require('./lib/cli');
const hooks = require('./lib/hooks-config');
const { electronBinary } = require('./hooks/send');

const SEND_JS = path.join(__dirname, 'hooks', 'send.js');
const USAGE = 'Usage: perchbot setup [options]   (or: npm run setup -- [options])';

function describeHandler({ event, group }) {
  const handler = group.hooks[0];
  const flags = [group.matcher ? `matcher "${group.matcher}"` : 'all', handler.async ? 'async' : 'sync'];
  return `    ${event.padEnd(20)} ${flags.join(', ').padEnd(20)} ${handler.command}`;
}

/** Look at one settings file: what would change. Prints its part of the report. */
function plan({ file, why }) {
  console.log(`\n  Settings file : ${file}  (${why})`);
  const current = cli.readSettings(file);
  if (current.error) {
    console.error(`  Stopped: ${current.error}.`);
    return { file, error: true };
  }
  const shapeError = hooks.checkShape(current.data);
  if (shapeError) {
    console.error(`  Stopped: unexpected settings format, ${shapeError}.`);
    return { file, error: true };
  }
  if (current.data.disableAllHooks === true) {
    console.log('  Note: this file sets "disableAllHooks": true, so Claude Code will not run any hooks until you remove it.');
  }
  if (hooks.isInstalled(current.data, SEND_JS)) {
    console.log('  Perchbot hooks are already installed and up to date. Nothing to do.');
    return { file, none: true };
  }
  let result;
  try {
    result = hooks.addHooks(current.data, SEND_JS);
  } catch (err) {
    console.error(`  Stopped: ${err.message}`);
    return { file, error: true };
  }
  console.log(`  Existing hooks: ${hooks.countOtherHandlers(current.data)} other handler(s), kept as they are`);
  if (result.replaced > 0) console.log(`  Replacing     : ${result.replaced} older Perchbot handler(s)`);
  console.log(`  Will add ${result.added.length} hooks:`);
  for (const entry of result.added) console.log(describeHandler(entry));
  const backup = current.exists ? cli.backupPath(file) : null;
  console.log(`  Backup        : ${backup || '(none needed, the file does not exist yet and will be created)'}`);
  return { file, settings: result.settings, added: result.added.length, backup };
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
    console.log(`${USAGE}\n\nAdds Perchbot hooks to Claude Code settings files.\n\n${cli.USAGE_TARGETS}`);
    return 0;
  }

  const targets = cli.resolveTargets(opts);
  console.log('Perchbot setup\n');
  console.log(`  Hook script   : ${SEND_JS}`);
  if (targets.length > 1) console.log(`  Accounts      : ${targets.length} found`);

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) console.log(`\n  Warning: Node.js ${process.versions.node} found; Perchbot is tested with Node 20+.`);
  if (!electronBinary()) {
    console.log(
      '\n  Warning: Electron is not installed yet, so the overlay cannot start.\n' +
        '  Run "npm install" first. If that finished but this warning stays, run:\n' +
        '    node node_modules/electron/install.js',
    );
  }

  const plans = targets.map(plan);
  if (plans.some((p) => p.error)) {
    console.error('\n  Nothing was written: the files were NOT changed. Fix the file above (or move it away) and run setup again.');
    return 1;
  }
  const writes = plans.filter((p) => p.settings);
  if (!writes.length) return 0;

  if (opts.dryRun) {
    console.log('\n  --dry-run: nothing was written.');
    return 0;
  }
  const question = writes.length > 1 ? `Apply these changes to ${writes.length} files?` : 'Apply these changes?';
  if (!(await cli.approved(opts, question))) {
    console.log('  Cancelled. Nothing was written.');
    return 1;
  }

  for (const p of writes) {
    try {
      if (p.backup) cli.makeBackup(p.file, p.backup);
      cli.writeJsonAtomic(p.file, p.settings);
    } catch (err) {
      console.error(`\n  Failed to write ${p.file}: ${err.message}`);
      if (p.backup) console.error(`  Your original file is untouched or restorable from: ${p.backup}`);
      return 1;
    }
    console.log(`\n  Done. ${p.added} hooks written to ${p.file}`);
    if (p.backup) console.log(`  Backup of the previous file: ${p.backup}`);
  }
  const single = opts.configDir !== undefined || opts.project !== undefined || opts.local !== undefined;
  console.log(
    '\n  Claude Code picks up hook changes automatically; restart open sessions if the buddy does not appear.' +
      '\n  Try it without Claude Code: perchbot demo   (npm run simulate in a clone)' +
      `\n  Undo: perchbot uninstall${single ? ' <same option as above>' : ''}   (npm run uninstall-hooks in a clone)`,
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

module.exports = { main, SEND_JS };
