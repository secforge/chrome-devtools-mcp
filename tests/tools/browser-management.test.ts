/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {beforeEach, describe, it} from 'node:test';

import {BrowserRegistry} from '../../src/BrowserRegistry.js';
import type {McpContext} from '../../src/McpContext.js';
import type {Browser} from '../../src/third_party/index.js';
import {
  listBrowsers,
  reconnectBrowser,
} from '../../src/tools/browser-management.js';

function fakeBrowser(connected = true): Browser {
  return {connected} as unknown as Browser;
}

/** Minimal McpContext exposing only what list_browsers reads. */
function fakeContextWithPage(url: string): McpContext {
  return {
    getPages: () => [{url: () => url}],
    isPageSelected: () => true,
  } as unknown as McpContext;
}

function makeResponse() {
  const lines: string[] = [];
  return {
    lines,
    response: {
      appendResponseLine: (value: string) => lines.push(value),
    } as unknown as Parameters<typeof listBrowsers.handler>[1],
  };
}

const noContext = undefined as unknown as Parameters<
  typeof listBrowsers.handler
>[2];

describe('browser-management tools', () => {
  beforeEach(() => {
    BrowserRegistry.resetForTesting();
  });

  describe('list_browsers', () => {
    it('reports when no browsers are registered', async () => {
      const {lines, response} = makeResponse();
      await listBrowsers.handler({params: {}}, response, noContext);
      assert.deepStrictEqual(lines, ['No browsers are currently registered.']);
    });

    it('lists a single connected browser with its pages', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('https://example.com/'),
        'http://127.0.0.1:9281',
      );
      const {lines, response} = makeResponse();
      await listBrowsers.handler({params: {}}, response, noContext);
      const text = lines.join('\n');
      assert.match(text, /Total browsers: 1/);
      assert.match(text, /\[1\] http:\/\/127\.0\.0\.1:9281 - connected/);
      assert.match(text, /0: https:\/\/example\.com\/ \[selected\]/);
      assert.match(text, /Single browser mode/);
    });

    it('warns that browserIndex is required with multiple browsers', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(
        {
          browserURL: 'http://a',
          devtools: false,
          mcpContextOptions: {
            experimentalDevToolsDebugging: false,
            performanceCrux: false,
          },
        },
        'http://a',
      );
      r.register(
        {
          browserURL: 'http://b',
          devtools: false,
          mcpContextOptions: {
            experimentalDevToolsDebugging: false,
            performanceCrux: false,
          },
        },
        'http://b',
      );
      const {lines, response} = makeResponse();
      await listBrowsers.handler({params: {}}, response, noContext);
      const text = lines.join('\n');
      assert.match(text, /Total browsers: 2/);
      assert.match(text, /Multiple browsers detected/);
    });
  });

  describe('reconnect_browser validation', () => {
    it('rejects an index in single-browser mode', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(fakeBrowser(), {} as McpContext, 'http://a');
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          reconnectBrowser.handler(
            {params: {browserIndex: 1}},
            response,
            noContext,
          ),
        /must NOT be specified in single-browser mode/,
      );
    });

    it('requires an index in multi-browser mode', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(fakeBrowser(), {} as McpContext, 'http://a');
      r.addConnectedBrowser(fakeBrowser(), {} as McpContext, 'http://b');
      const {response} = makeResponse();
      await assert.rejects(
        () => reconnectBrowser.handler({params: {}}, response, noContext),
        /browserIndex is required in multi-browser mode/,
      );
    });
  });
});
