/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BrowserInstructionInfo {
  /** Human-readable identifier for the browser (its URL, endpoint or label). */
  url: string;
  /** Whether a start command is configured so it can be (re)started. */
  hasStartCommand: boolean;
}

const INTRO =
  'Chrome DevTools MCP lets you drive and inspect live Chrome browser(s) with ' +
  'full DevTools access: navigate, interact with pages, and inspect network, ' +
  'console, performance and memory.';

const CORE_WORKFLOW = [
  'Core workflow:',
  '- Call `take_snapshot` to get a structured text snapshot whose elements carry',
  '  `uid`s, then pass those `uid`s to the interaction tools (`click`, `fill`,',
  '  `hover`, `drag`, `fill_form`, ...). Prefer snapshots over screenshots for',
  '  locating elements.',
  '- `list_pages`, `new_page`, `select_page`, `navigate_page` and `wait_for`',
  '  manage tabs and navigation.',
  '- `list_network_requests`, `list_console_messages`, the performance tracing',
  '  tools and the emulation tools support debugging.',
].join('\n');

/**
 * Describe how a browser can be brought back online, for embedding in a
 * sentence about `reconnect_browser`.
 */
function restartClause(hasStartCommand: boolean): string {
  return hasStartCommand
    ? 'can be (re)started with `reconnect_browser` (start command configured)'
    : 'must already be running (no start command configured)';
}

/**
 * Build the MCP server `instructions` string. The text is tailored to the
 * browsers that are actually configured: a server that exposes one browser only
 * ever describes single-browser usage, and a server that exposes several only
 * ever describes multi-browser usage. It never asks the model to reason about
 * which "mode" it is in.
 */
export function buildServerInstructions(
  browsers: BrowserInstructionInfo[],
): string {
  if (browsers.length === 0) {
    return [INTRO, 'No browsers are currently configured.', CORE_WORKFLOW].join(
      '\n\n',
    );
  }

  if (browsers.length === 1) {
    const [browser] = browsers;
    const reconnect = browser.hasStartCommand
      ? 'If it is not running yet or the connection drops, it can be (re)started ' +
        'at any time with `reconnect_browser` (a start command is configured).'
      : 'If the connection drops, use `reconnect_browser` to reconnect; the ' +
        'browser must already be running (no start command is configured).';

    return [
      INTRO,
      'A single Chrome browser is connected. Do not pass a `browserIndex` ' +
        'argument to any tool — every tool automatically targets this browser.',
      reconnect +
        ' Use `list_browsers` to see its connection state and open pages.',
      CORE_WORKFLOW,
    ].join('\n\n');
  }

  const count = browsers.length;
  const listing = browsers
    .map(
      (browser, i) =>
        `  [${i + 1}] ${browser.url} — ${restartClause(browser.hasStartCommand)}`,
    )
    .join('\n');

  return [
    INTRO,
    `${count} Chrome browsers are connected. Every tool call must include a ` +
      '`browserIndex` argument (1-based) selecting which browser to act on. ' +
      `Valid indices: 1 to ${count}.`,
    ['Connected browsers:', listing].join('\n'),
    "Use `list_browsers` at any time to see each browser's connection state " +
      'and open pages, and `reconnect_browser` to (re)start a browser that has ' +
      'a start command configured (see above).',
    CORE_WORKFLOW,
  ].join('\n\n');
}
