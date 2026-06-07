/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BrowserRegistry} from '../BrowserRegistry.js';
import type {BrowserEntry} from '../BrowserRegistry.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool, makeBrowserIndexSchema} from './ToolDefinition.js';

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

/**
 * The browser-targeting schema for the skip-context tools: a `browserIndex`
 * parameter only when more than one browser is connected, nothing otherwise.
 */
function browserTargetSchema(browserCount: number) {
  return browserCount > 1 ? makeBrowserIndexSchema(browserCount) : {};
}

const startUrlSchema = zod
  .string()
  .optional()
  .describe(
    'Absolute http(s) URL the browser should open when it is (re)launched. ' +
      'Substituted into the {url} placeholder of the configured start command. ' +
      'Required when that start command contains a {url} placeholder. Only http ' +
      'and https URLs are accepted.',
  );

export const listBrowsers = (_args: unknown, browserCount: number) =>
  defineTool({
    name: 'list_browsers',
    description:
      browserCount > 1
        ? `List all connected browsers with their 1-based index, connection state and open pages. Use a browser's index as the browserIndex argument on other tools to target it.`
        : `List the connected browser, its connection state and open pages.`,
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
          `\nMultiple browsers are connected. Pass the matching browserIndex on every tool call to target a specific browser.`,
        );
      } else {
        response.appendResponseLine(
          `\nOne browser is connected; tools target it automatically (do not pass browserIndex).`,
        );
      }
    },
  });

export const reconnectBrowser = (_args: unknown, browserCount: number) =>
  defineTool({
    name: 'reconnect_browser',
    description:
      browserCount > 1
        ? `Reconnect a browser that is disconnected or whose connection failed, selected by browserIndex. If that browser has a start command configured it is (re)started.`
        : `Reconnect the browser if its connection was lost or it is not running yet. If a start command is configured the browser is (re)started.`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: false,
      skipBrowserContext: true,
    },
    schema: {
      ...browserTargetSchema(browserCount),
      url: startUrlSchema,
    },
    verifyFilesSchema: [],
    blockedByDialog: false,
    handler: async (request, response) => {
      const registry = BrowserRegistry.getInstance();
      const {browserIndex: index, url} = request.params as {
        browserIndex?: number;
        url?: string;
      };

      // Validate index (same logic as getContext)
      if (registry.count() === 1) {
        if (index !== undefined) {
          throw new Error(
            'browserIndex must NOT be specified when only one browser is connected.',
          );
        }
        // force=true bypasses cooldown, runStartCommand=true runs the start
        // command if configured.
        await registry.connect(1, true, true, url);
        response.appendResponseLine('Browser reconnected successfully.');
      } else {
        if (index === undefined) {
          throw new Error(
            'browserIndex is required when multiple browsers are connected.',
          );
        }
        await registry.connect(index, true, true, url);
        response.appendResponseLine(
          `Browser ${index} reconnected successfully.`,
        );
      }
    },
  });

export const closeBrowser = (_args: unknown, browserCount: number) =>
  defineTool({
    name: 'close_browser',
    description:
      browserCount > 1
        ? `Close a whole browser (not a single tab), selected by browserIndex. The browser window is terminated. The index is preserved, so reconnect_browser can bring it back if a start command or launch configuration is available.`
        : `Close the whole browser (not a single tab). The browser window is terminated. reconnect_browser can bring it back if a start command or launch configuration is available.`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: false,
      skipBrowserContext: true,
    },
    schema: {
      ...browserTargetSchema(browserCount),
    },
    verifyFilesSchema: [],
    blockedByDialog: false,
    handler: async (request, response) => {
      const registry = BrowserRegistry.getInstance();
      const {browserIndex: index} = request.params as {browserIndex?: number};

      if (registry.count() === 1) {
        if (index !== undefined) {
          throw new Error(
            'browserIndex must NOT be specified when only one browser is connected.',
          );
        }
        await registry.dispose(1, true);
        response.appendResponseLine('Browser closed.');
      } else {
        if (index === undefined) {
          throw new Error(
            'browserIndex is required when multiple browsers are connected.',
          );
        }
        await registry.dispose(index, true);
        response.appendResponseLine(`Browser ${index} closed.`);
      }
    },
  });
