'use strict';

/**
 * Maps tool names to character states and speech-bubble messages.
 *
 * The hook (hooks/send.js) decides *what* detail to forward for each tool
 * (a file name, a search pattern, a trimmed command). This module only decides
 * how the overlay presents it.
 */

const STATE_BY_TOOL = {
  // Writing code
  Edit: 'typing',
  Write: 'typing',
  MultiEdit: 'typing',
  NotebookEdit: 'typing',
  // Reading / searching
  Read: 'reading',
  Grep: 'reading',
  Glob: 'reading',
  LS: 'reading',
  NotebookRead: 'reading',
  // Running commands. On Windows without Git Bash, Claude Code exposes a
  // PowerShell tool instead of Bash.
  Bash: 'running',
  PowerShell: 'running',
  Monitor: 'running',
};

/** Tools whose detail is a file name (the hook forwards only the base name). */
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'NotebookRead']);

function isFileTool(tool) {
  return FILE_TOOLS.has(tool);
}

/** States that represent "a tool is in progress". */
const TOOL_STATES = new Set(['typing', 'reading', 'running', 'working']);

function stateForTool(tool) {
  return STATE_BY_TOOL[tool] || 'working';
}

/**
 * Returns the bubble message for a tool as a translation key plus variables.
 * @param {string} tool
 * @param {string | undefined} detail
 * @returns {{ key: string, vars?: Record<string, string>, mono?: boolean }}
 */
function bubbleForTool(tool, detail) {
  const state = stateForTool(tool);
  if (state === 'typing') {
    return detail ? { key: 'typing', vars: { file: detail } } : { key: 'typingNoFile' };
  }
  if (tool === 'Grep') {
    return detail ? { key: 'searching', vars: { pattern: detail } } : { key: 'searchingNoPattern' };
  }
  if (tool === 'Glob') {
    return detail ? { key: 'findingFiles', vars: { pattern: detail } } : { key: 'searchingNoPattern' };
  }
  if (state === 'reading') {
    return detail ? { key: 'reading', vars: { file: detail } } : { key: 'readingNoFile' };
  }
  if (state === 'running') {
    return detail ? { key: 'running', vars: { command: detail }, mono: true } : { key: 'runningNoCommand' };
  }
  if (tool === 'WebSearch') return { key: 'webSearch' };
  if (tool === 'WebFetch') {
    return detail ? { key: 'webFetch', vars: { host: detail } } : { key: 'webFetchNoHost' };
  }
  if (tool === 'Task' || tool === 'Agent') return { key: 'delegating' };
  if (tool === 'Skill') return { key: 'skill' };
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1];
    if (server) return { key: 'mcp', vars: { server } };
  }
  return { key: 'working' };
}

/** Tools whose detail is the command they run (shortened by the hook). */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * A step worth listing in the little row above the bubble: a file read, a file
 * written, a command run. Searches, web pages and other tools are not listed.
 * @returns {{ kind: 'read' | 'write' | 'run', text: string } | null}
 */
function stepForTool(tool, detail) {
  if (typeof detail !== 'string' || !detail) return null;
  if (FILE_TOOLS.has(tool)) return { kind: stateForTool(tool) === 'typing' ? 'write' : 'read', text: detail };
  if (COMMAND_TOOLS.has(tool)) return { kind: 'run', text: detail };
  return null;
}

module.exports = { stateForTool, bubbleForTool, stepForTool, isFileTool, TOOL_STATES, STATE_BY_TOOL, FILE_TOOLS, COMMAND_TOOLS };
