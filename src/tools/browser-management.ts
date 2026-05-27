/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BrowserRegistry} from '../BrowserRegistry.js';
import type {BrowserEntry} from '../BrowserRegistry.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

/**
 * Format connection state for display.
 */
function formatState(entry: BrowserEntry): string {
  switch (entry.state) {
    case 'pending':
      return 'pending';
    case 'connecting':
      return 'connecting...';
    case 'connected':
      // Double-check actual connection status
      if (entry.browser?.connected) {
        return 'connected';
      }
      return 'disconnected (connection lost)';
    case 'disconnected':
      if (entry.lastError) {
        return `disconnected (${entry.lastError.message})`;
      }
      return 'disconnected';
    default:
      return 'unknown';
  }
}

export const listBrowsers = defineTool({
  name: 'list_browsers',
  description: `Get a list of all registered browsers and their connection states. Use this to see which browsers are available, their indices, and whether they are connected. When multiple browsers are registered, you must use the browserIndex parameter in tools to specify which browser to target.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
    skipBrowserContext: true,
  },
  schema: {},
  verifyFilesSchema: [],
  blockedByDialog: false,
  handler: async (_request, response) => {
    const registry = BrowserRegistry.getInstance();
    const browsers = registry.getAll();

    if (browsers.length === 0) {
      response.appendResponseLine('No browsers are currently registered.');
      return;
    }

    response.appendResponseLine(`Total browsers: ${browsers.length}\n`);

    for (let i = 0; i < browsers.length; i++) {
      const entry = browsers[i];
      response.appendResponseLine(
        `[${i + 1}] ${entry.url} - ${formatState(entry)}`,
      );

      // List pages for connected browsers
      if (
        entry.state === 'connected' &&
        entry.browser?.connected &&
        entry.context
      ) {
        const pages = entry.context.getPages();
        for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
          const page = pages[pageIdx];
          const selected = entry.context.isPageSelected(page)
            ? ' [selected]'
            : '';
          response.appendResponseLine(
            `    ${pageIdx}: ${page.url()}${selected}`,
          );
        }
      }
    }

    if (browsers.length > 1) {
      response.appendResponseLine(
        `\nMultiple browsers detected. You MUST specify browserIndex parameter in all tool calls to target a specific browser.`,
      );
    } else {
      response.appendResponseLine(
        `\nSingle browser mode: browserIndex parameter must NOT be specified.`,
      );
    }
  },
});

export const reconnectBrowser = defineTool({
  name: 'reconnect_browser',
  description: `Manually reconnect to a disconnected browser. Use this when a browser connection was lost or failed. In single-browser mode, no parameter needed. In multi-browser mode, specify browserIndex.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
    skipBrowserContext: true,
  },
  schema: {
    browserIndex: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Index of the browser to reconnect (1-based). Required in multi-browser mode.',
      ),
  },
  verifyFilesSchema: [],
  blockedByDialog: false,
  handler: async (request, response) => {
    const registry = BrowserRegistry.getInstance();
    const index = (request.params as {browserIndex?: number}).browserIndex;

    // Validate index (same logic as getContext)
    if (registry.count() === 1) {
      if (index !== undefined) {
        throw new Error(
          'browserIndex must NOT be specified in single-browser mode.',
        );
      }
      // force=true bypasses cooldown, runStartCommand=true runs the start
      // command if configured.
      await registry.connect(1, true, true);
      response.appendResponseLine('Browser reconnected successfully.');
    } else {
      if (index === undefined) {
        throw new Error('browserIndex is required in multi-browser mode.');
      }
      await registry.connect(index, true, true);
      response.appendResponseLine(`Browser ${index} reconnected successfully.`);
    }
  },
});
