#!/usr/bin/env node
'use strict';

/**
 * Registers Agent Buddy's hooks in a Claude Code settings file.
 *
 *   npm run setup                      user settings (CLAUDE_CONFIG_DIR aware)
 *   npm run setup -- --dry-run         show the changes, write nothing
 *   npm run setup -- --project         this project's .claude/settings.json
 *   npm run setup -- --help
 *
 * What it does, in order:
 *   1. Reads the settings file. Invalid JSON: stops and changes nothing.
 *   2. Prints exactly which hooks it will add and where the backup will go.
 *   3. Asks for confirmation (skip with --yes).
 *   4. Backs up the existing file, then writes the merged result.
 * Other hooks already in the file are kept. Running it again is safe: it
 * refreshes its own entries instead of adding duplicates.
 * Undo with: npm run uninstall-hooks
 */

const fs = require('node:fs');
const path = require('node:path');
const cli = require('./lib/cli');
const hooks = require('./lib/hooks-config');

const SEND_JS = path.join(__dirname, 'hooks', 'send.js');

function electronInstalled() {
  try {
    const pkg = path.join(__dirname, 'node_modules', 'electron');
    const relative = fs.readFileSync(path.join(pkg, 'path.txt'), 'utf8').trim();
    return fs.existsSync(path.join(pkg, 'dist', relative));
  } catch {
    return false;
  }
}

function describeHandler({ event, group }) {
  const handler = group.hooks[0];
  const flags = [group.matcher ? `matcher "${group.matcher}"` : 'all', handler.async ? 'async' : 'sync'];
  return `    ${event.padEnd(20)} ${flags.join(', ').padEnd(20)} ${handler.command}`;
}

async function main() {
  let opts;
  try {
    opts = cli.parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\nUsage: npm run setup -- [options]\n\n${cli.USAGE_TARGETS}`);
    return 2;
  }
  if (opts.help) {
    console.log(`Usage: npm run setup -- [options]\n\nAdds Agent Buddy hooks to a Claude Code settings file.\n\n${cli.USAGE_TARGETS}`);
    return 0;
  }

  const { file, why } = cli.resolveTarget(opts);
  console.log('Agent Buddy setup\n');
  console.log(`  Settings file : ${file}  (${why})`);
  console.log(`  Hook script   : ${SEND_JS}`);

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) console.log(`\n  Warning: Node.js ${process.versions.node} found; Agent Buddy is tested with Node 20+.`);
  if (!electronInstalled()) {
    console.log(
      '\n  Warning: Electron is not installed yet, so the overlay cannot start.\n' +
        '  Run "npm install" first. If that finished but this warning stays, run:\n' +
        '    node node_modules/electron/install.js',
    );
  }

  const current = cli.readSettings(file);
  if (current.error) {
    console.error(`\n  Stopped: ${current.error}.\n  The file was NOT changed. Fix it (or move it away) and run setup again.`);
    return 1;
  }
  const shapeError = hooks.checkShape(current.data);
  if (shapeError) {
    console.error(`\n  Stopped: unexpected settings format, ${shapeError}.\n  The file was NOT changed.`);
    return 1;
  }

  if (current.data.disableAllHooks === true) {
    console.log('\n  Note: this file sets "disableAllHooks": true, so Claude Code will not run any hooks until you remove it.');
  }

  if (hooks.isInstalled(current.data, SEND_JS)) {
    console.log('\n  Agent Buddy hooks are already installed and up to date. Nothing to do.');
    return 0;
  }

  let result;
  try {
    result = hooks.addHooks(current.data, SEND_JS);
  } catch (err) {
    console.error(`\n  Stopped: ${err.message}\n  The file was NOT changed.`);
    return 1;
  }

  const others = hooks.countOtherHandlers(current.data);
  console.log(`  Existing hooks: ${others} other handler(s), kept as they are`);
  if (result.replaced > 0) console.log(`  Replacing     : ${result.replaced} older Agent Buddy handler(s)`);
  console.log(`\n  Will add ${result.added.length} hooks:`);
  for (const entry of result.added) console.log(describeHandler(entry));
  const backup = current.exists ? cli.backupPath(file) : null;
  console.log(`\n  Backup        : ${backup || '(none needed, the file does not exist yet and will be created)'}`);

  if (opts.dryRun) {
    console.log('\n  --dry-run: nothing was written.');
    return 0;
  }
  if (!(await cli.approved(opts))) {
    console.log('  Cancelled. Nothing was written.');
    return 1;
  }

  try {
    if (backup) cli.makeBackup(file, backup);
    cli.writeJsonAtomic(file, result.settings);
  } catch (err) {
    console.error(`\n  Failed to write ${file}: ${err.message}`);
    if (backup) console.error(`  Your original file is untouched or restorable from: ${backup}`);
    return 1;
  }

  console.log(`\n  Done. ${result.added.length} hooks written to ${file}`);
  if (backup) console.log(`  Backup of the previous file: ${backup}`);
  console.log(
    '\n  Claude Code picks up hook changes automatically; restart open sessions if the buddy does not appear.' +
      '\n  Try it without Claude Code: npm run simulate' +
      `\n  Undo: npm run uninstall-hooks${opts.configDir || opts.project !== undefined || opts.local !== undefined ? ' -- <same option as above>' : ''}`,
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
