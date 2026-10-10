/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {beforeEach, describe, it} from 'node:test';

import {BrowserRegistry} from '../../src/BrowserRegistry.js';
import {BrowserManager} from '../../src/BrowserManager.js';
import {createMockParsedArguments} from '../mocks.js';
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
  // Shaped like a real McpPage: list_browsers reports the page's own id and
  // reads the URL through pptrPage, exactly as list_pages does.
  const page = {id: 1, pptrPage: {url: () => url}};
  return {
    getPages: () => [page],
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
const args = createMockParsedArguments();

function fakeManager(): BrowserManager {
  return new BrowserManager(createMockParsedArguments());
}

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
        BrowserRegistry.resetForTesting();
        const r = BrowserRegistry.getInstance();
        for (let i = 0; i < count; i++) {
          r.addConnectedBrowser(
            fakeBrowser(),
            fakeContextWithPage('https://example.com/'),
            `http://${i}`,
            fakeManager(),
          );
        }
        for (const factory of [listBrowsers, reconnectBrowser, closeBrowser]) {
          assert.doesNotMatch(
            factory(args).description,
            /(single|multi)-browser mode/i,
          );
        }
      }
    });

    it('omits browserIndex from schemas with a single browser', () => {
      assert.ok(!('browserIndex' in reconnectBrowser(args).schema));
      assert.ok(!('browserIndex' in closeBrowser(args).schema));
      // url stays available for reconnect even with one browser.
      assert.ok('url' in reconnectBrowser(args).schema);
    });

    it('includes browserIndex in schemas only with multiple browsers', () => {
      // The count comes from the registry, so register before building.
      BrowserRegistry.resetForTesting();
      const single = BrowserRegistry.getInstance();
      single.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('https://a/'),
        'http://a',
        fakeManager(),
      );
      assert.ok(!('browserIndex' in reconnectBrowser(args).schema));
      assert.doesNotMatch(listBrowsers(args).description, /browserIndex/);

      single.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('https://b/'),
        'http://b',
        fakeManager(),
      );
      assert.ok('browserIndex' in reconnectBrowser(args).schema);
      assert.ok('browserIndex' in closeBrowser(args).schema);
      assert.match(listBrowsers(args).description, /browserIndex/);
    });
  });

  describe('list_browsers', () => {
    it('reports when no browsers are registered', async () => {
      const {lines, response} = makeResponse();
      await listBrowsers(args).handler({params: {}}, response, noContext);
      assert.deepStrictEqual(lines, ['No browsers are currently registered.']);
    });

    it('lists a single connected browser with its pages', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('https://example.com/'),
        'http://127.0.0.1:9281',
        fakeManager(),
      );
      const {lines, response} = makeResponse();
      await listBrowsers(args).handler({params: {}}, response, noContext);
      const text = lines.join('\n');
      assert.match(text, /Total browsers: 1/);
      assert.match(text, /\[1\] http:\/\/127\.0\.0\.1:9281 - connected/);
      assert.match(text, /1: https:\/\/example\.com\/ \[selected\]/);
      assert.match(text, /One browser is connected/);
    });

    it('warns that browserIndex is required with multiple browsers', async () => {
      const r = BrowserRegistry.getInstance();
      for (const url of ['http://a', 'http://b']) {
        r.register(
          {
            serverArgs: {...createMockParsedArguments(), browserUrl: url},
            mcpContextOptions: {
              experimentalDevToolsDebugging: false,
              performanceCrux: false,
            },
          },
          url,
        );
      }
      const {lines, response} = makeResponse();
      await listBrowsers(args).handler({params: {}}, response, noContext);
      const text = lines.join('\n');
      assert.match(text, /Total browsers: 2/);
      assert.match(text, /Multiple browsers are connected/);
    });
  });

  describe('reconnect_browser validation', () => {
    it('rejects an index when only one browser is connected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        {} as McpContext,
        'http://a',
        fakeManager(),
      );
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          reconnectBrowser(args).handler(
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
        {} as McpContext,
        'http://a',
        fakeManager(),
      );
      r.addConnectedBrowser(
        fakeBrowser(),
        {} as McpContext,
        'http://b',
        fakeManager(),
      );
      const {response} = makeResponse();
      await assert.rejects(
        () => reconnectBrowser(args).handler({params: {}}, response, noContext),
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
        fakeManager(),
      );
      const {response} = makeResponse();
      await assert.rejects(
        () =>
          closeBrowser(args).handler(
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
        fakeManager(),
      );
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('b'),
        'http://b',
        fakeManager(),
      );
      const {response} = makeResponse();
      await assert.rejects(
        () => closeBrowser(args).handler({params: {}}, response, noContext),
        /browserIndex is required when multiple browsers are connected/,
      );
    });

    it('closes the single browser and leaves it disconnected', async () => {
      const r = BrowserRegistry.getInstance();
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('http://a'),
        'http://a',
        fakeManager(),
      );
      const {lines, response} = makeResponse();
      await closeBrowser(args).handler({params: {}}, response, noContext);
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
        fakeManager(),
      );
      r.addConnectedBrowser(
        fakeBrowser(),
        fakeContextWithPage('b'),
        'http://b',
        fakeManager(),
      );
      const {lines, response} = makeResponse();
      await closeBrowser(args).handler(
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
