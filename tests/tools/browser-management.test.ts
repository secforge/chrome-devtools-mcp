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
  closeBrowser,
  listBrowsers,
  reconnectBrowser,
} from '../../src/tools/browser-management.js';

function fakeBrowser(connected = true): Browser {
  return {
    connected,
    close: async () => {
      // no-op
    },
    disconnect: async () => {
      // no-op
    },
  } as unknown as Browser;
}

/** Minimal McpContext exposing only what these tools read. */
function fakeContextWithPage(url: string): McpContext {
  return {
    getPages: () => [{url: () => url}],
    isPageSelected: () => true,
    dispose: () => {
      // no-op
    },
  } as unknown as McpContext;
}

function makeResponse() {
  const lines: string[] = [];
  return {
    lines,
    response: {
      appendResponseLine: (value: string) => lines.push(value),
    } as unknown as Parameters<ReturnType<typeof listBrowsers>['handler']>[1],
  };
}

const noContext = undefined as unknown as Parameters<
  ReturnType<typeof listBrowsers>['handler']
>[2];

// The skip-context tools never use the args parameter.
const noArgs = undefined as unknown as never;

// Pass arguments the (mode-specific) schema would reject at the type level, so
// we can verify the handler's own runtime validation.
function invalidRequest(params: Record<string, unknown>) {
  return {params} as unknown as {params: never};
}

describe('browser-management tools', () => {
  beforeEach(() => {
    BrowserRegistry.resetForTesting();
  });

  describe('mode-aware definitions', () => {
    it('never uses conditional "X-browser mode" phrasing', () => {
      for (const count of [1, 2]) {
        for (const factory of [listBrowsers, reconnectBrowser, closeBrowser]) {
          assert.doesNotMatch(
            factory(noArgs, count).description,
            /(single|multi)-browser mode/i,
          );
        }
      }
    });

    it('omits browserIndex from schemas with a single browser', () => {
      assert.ok(!('browserIndex' in reconnectBrowser(noArgs, 1).schema));
      assert.ok(!('browserIndex' in closeBrowser(noArgs, 1).schema));
      // url stays available for reconnect even with one browser.
      assert.ok('url' in reconnectBrowser(noArgs, 1).schema);
    });

    it('includes browserIndex in schemas with multiple browsers', () => {
      assert.ok('browserIndex' in reconnectBrowser(noArgs, 3).schema);
      assert.ok('browserIndex' in closeBrowser(noArgs, 3).schema);
    });

    it('only mentions browserIndex in descriptions when multiple browsers exist', () => {
      assert.doesNotMatch(listBrowsers(noArgs, 1).description, /browserIndex/);
      assert.match(listBrowsers(noArgs, 2).description, /browserIndex/);
    });
  });

  describe('list_browsers', () => {
    it('reports when no browsers are registered', async () => {
      const {lines, response} = makeResponse();
      await listBrowsers(noArgs, 1).handler({params: {}}, response, noContext);
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
      await listBrowsers(noArgs, 1).handler({params: {}}, response, noContext);
      const text = lines.join('\n');
      assert.match(text, /Total browsers: 1/);
      assert.match(text, /\[1\] http:\/\/127\.0\.0\.1:9281 - connected/);
      assert.match(text, /0: https:\/\/example\.com\/ \[selected\]/);
      assert.match(text, /One browser is connected/);
    });

    it('warns that browserIndex is required with multiple browsers', async () => {
      const r = BrowserRegistry.getInstance();
      for (const url of ['http://a', 'http://b']) {
        r.register(
          {
            browserURL: url,
            devtools: false,
            mcpContextOptions: {
              experimentalDevToolsDebugging: false,
              performanceCrux: false,
            },
          },
          url,
        );
      }
      const {lines, response} = makeResponse();
      await listBrowsers(noArgs, 2).handler({params: {}}, response, noContext);
      const text = lines.join('\n');
      assert.match(text, /Total browsers: 2/);
      assert.match(text, /Multiple browsers are connected/);
    });
  });

  describe('reconnect_browser validation', () => {
    it('rejects an index when only one browser is connected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(fakeBrowser(), {} as McpContext, 'http://a');
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          reconnectBrowser(noArgs, 1).handler(
            invalidRequest({browserIndex: 1}),
            response,
            noContext,
          ),
        /must NOT be specified when only one browser is connected/,
      );
    });

    it('requires an index when multiple browsers are connected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(fakeBrowser(), {} as McpContext, 'http://a');
      r.addConnectedBrowser(fakeBrowser(), {} as McpContext, 'http://b');
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          reconnectBrowser(noArgs, 2).handler(
            {params: {}},
            response,
            noContext,
          ),
        /browserIndex is required when multiple browsers are connected/,
      );
    });
  });

  describe('close_browser', () => {
    it('rejects an index when only one browser is connected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('http://a'),
        'http://a',
      );
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          closeBrowser(noArgs, 1).handler(
            invalidRequest({browserIndex: 1}),
            response,
            noContext,
          ),
        /must NOT be specified when only one browser is connected/,
      );
    });

    it('requires an index when multiple browsers are connected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('a'),
        'http://a',
      );
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('b'),
        'http://b',
      );
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          closeBrowser(noArgs, 2).handler({params: {}}, response, noContext),
        /browserIndex is required when multiple browsers are connected/,
      );
    });

    it('closes the single browser and leaves it disconnected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('http://a'),
        'http://a',
      );
      const {lines, response} = makeResponse();
      await closeBrowser(noArgs, 1).handler({params: {}}, response, noContext);
      assert.match(lines.join('\n'), /Browser closed/);
      assert.strictEqual(r.getAll()[0].state, 'disconnected');
      assert.strictEqual(r.getAll()[0].browser, undefined);
    });

    it('closes a specific browser by index without shifting indices', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('a'),
        'http://a',
      );
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('b'),
        'http://b',
      );
      const {lines, response} = makeResponse();
      await closeBrowser(noArgs, 2).handler(
        {params: {browserIndex: 2}},
        response,
        noContext,
      );
      assert.match(lines.join('\n'), /Browser 2 closed/);
      // Index 1 untouched, index 2 disconnected, count unchanged.
      assert.strictEqual(r.count(), 2);
      assert.strictEqual(r.getAll()[0].state, 'connected');
      assert.strictEqual(r.getAll()[1].state, 'disconnected');
    });
  });
});
