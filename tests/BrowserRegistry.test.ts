/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {beforeEach, describe, it} from 'node:test';

import {
  BrowserRegistry,
  buildStartCommandArgv,
  parseCommandLine,
  sanitizeStartUrl,
} from '../src/BrowserRegistry.js';
import type {BrowserConfig} from '../src/BrowserRegistry.js';
import type {McpContext} from '../src/McpContext.js';
import type {Browser} from '../src/third_party/index.js';

const mcpContextOptions = {
  experimentalDevToolsDebugging: false,
  performanceCrux: false,
};

function makeConfig(browserURL: string): BrowserConfig {
  return {browserURL, devtools: false, mcpContextOptions};
}

function fakeBrowser(connected = true): Browser {
  return {connected} as unknown as Browser;
}

function fakeContext(): McpContext {
  return {} as unknown as McpContext;
}

describe('BrowserRegistry', () => {
  beforeEach(() => {
    BrowserRegistry.resetForTesting();
  });

  it('starts empty', () => {
    const r = BrowserRegistry.getInstance();
    assert.strictEqual(r.isEmpty(), true);
    assert.strictEqual(r.count(), 0);
    assert.strictEqual(r.hasMultipleBrowsers(), false);
  });

  it('is a stable singleton until reset', () => {
    const a = BrowserRegistry.getInstance();
    assert.strictEqual(a, BrowserRegistry.getInstance());
    BrowserRegistry.resetForTesting();
    assert.notStrictEqual(a, BrowserRegistry.getInstance());
  });

  it('register returns 1-based indices and updates counts', () => {
    const r = BrowserRegistry.getInstance();
    assert.strictEqual(r.register(makeConfig('http://a'), 'http://a'), 1);
    assert.strictEqual(r.register(makeConfig('http://b'), 'http://b'), 2);
    assert.strictEqual(r.count(), 2);
    assert.strictEqual(r.hasMultipleBrowsers(), true);
    assert.strictEqual(r.getAll().length, 2);
  });

  it('get() throws on an out-of-bounds index', () => {
    const r = BrowserRegistry.getInstance();
    r.register(makeConfig('http://a'), 'http://a');
    assert.throws(() => r.get(0), /out of bounds/);
    assert.throws(() => r.get(2), /out of bounds/);
    assert.doesNotThrow(() => r.get(1));
  });

  describe('getContext index validation', () => {
    it('rejects an explicit index when only one browser exists', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      await assert.rejects(() => r.getContext(1), /must NOT be specified/);
    });

    it('requires an index when multiple browsers exist', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      r.register(makeConfig('http://b'), 'http://b');
      await assert.rejects(() => r.getContext(undefined), /is required/);
    });

    it('rejects an out-of-bounds index', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      r.register(makeConfig('http://b'), 'http://b');
      await assert.rejects(() => r.getContext(99), /out of bounds/);
    });

    it('returns the connected context for the requested index', async () => {
      const r = BrowserRegistry.getInstance();
      const ctx1 = fakeContext();
      const ctx2 = fakeContext();
      r.addConnectedBrowser(fakeBrowser(), ctx1, 'http://a');
      r.addConnectedBrowser(fakeBrowser(), ctx2, 'http://b');
      assert.strictEqual(await r.getContext(1), ctx1);
      assert.strictEqual(await r.getContext(2), ctx2);
    });

    it('returns the only context with no index in single-browser mode', async () => {
      const r = BrowserRegistry.getInstance();
      const ctx = fakeContext();
      r.addConnectedBrowser(fakeBrowser(), ctx, 'http://a');
      assert.strictEqual(await r.getContext(), ctx);
    });
  });

  describe('retry cooldown', () => {
    it('blocks auto-retry within the cooldown window', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      const entry = r.get(1);
      entry.state = 'disconnected';
      entry.lastError = new Error('boom');
      entry.lastAttempt = Date.now();
      assert.strictEqual(r.canRetry(1), false);
      await assert.rejects(() => r.getContext(), /connection failed recently/);
    });

    it('allows retry once the cooldown has elapsed', () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      const entry = r.get(1);
      entry.state = 'disconnected';
      entry.lastAttempt = Date.now() - 61_000;
      assert.strictEqual(r.canRetry(1), true);
    });
  });

  describe('parseCommandLine', () => {
    it('splits a simple command', () => {
      assert.deepStrictEqual(parseCommandLine('a b c'), ['a', 'b', 'c']);
    });

    it('keeps single-quoted spans (paths with spaces) intact', () => {
      assert.deepStrictEqual(parseCommandLine("'/a b/c.exe' --flag"), [
        '/a b/c.exe',
        '--flag',
      ]);
    });

    it('concatenates adjacent unquoted and quoted segments', () => {
      assert.deepStrictEqual(parseCommandLine("--dir='L:\\Test Dir\\x'"), [
        '--dir=L:\\Test Dir\\x',
      ]);
    });

    it('does NOT treat shell metacharacters as operators', () => {
      // Without a shell these are literal argv tokens, not command chaining.
      assert.deepStrictEqual(parseCommandLine('app; rm -rf / && echo $(x)'), [
        'app;',
        'rm',
        '-rf',
        '/',
        '&&',
        'echo',
        '$(x)',
      ]);
    });

    it('tokenizes a realistic Edge launch command', () => {
      const cmd =
        "'/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' " +
        "--user-data-dir='L:\\Development\\Tools\\Start Test Browsers\\Test 1' " +
        '--no-first-run --window-size=1905,1050 ' +
        '--remote-debugging-port=9281 https://127.0.0.1:3001';
      const argv = parseCommandLine(cmd);
      assert.strictEqual(
        argv[0],
        '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      );
      assert.ok(
        argv.includes(
          '--user-data-dir=L:\\Development\\Tools\\Start Test Browsers\\Test 1',
        ),
      );
      assert.strictEqual(argv.at(-1), 'https://127.0.0.1:3001');
    });

    it('throws on an unterminated quote', () => {
      assert.throws(() => parseCommandLine("'unbalanced"), /Unterminated/);
    });
  });

  describe('sanitizeStartUrl', () => {
    it('accepts http and https and normalizes', () => {
      assert.strictEqual(
        sanitizeStartUrl('https://example.com/a'),
        'https://example.com/a',
      );
      assert.strictEqual(
        sanitizeStartUrl('http://127.0.0.1:3001'),
        'http://127.0.0.1:3001/',
      );
    });

    it('rejects dangerous schemes', () => {
      assert.throws(() => sanitizeStartUrl('file:///etc/passwd'), /scheme/);
      assert.throws(() => sanitizeStartUrl('javascript:alert(1)'), /scheme/);
      assert.throws(() => sanitizeStartUrl('data:text/html,x'), /scheme/);
      assert.throws(() => sanitizeStartUrl('chrome://settings'), /scheme/);
    });

    it('rejects values that are not absolute URLs (incl. flag injection)', () => {
      assert.throws(
        () => sanitizeStartUrl('--proxy-server=http://evil'),
        /Invalid url/,
      );
      assert.throws(() => sanitizeStartUrl('-foo'), /Invalid url/);
      assert.throws(() => sanitizeStartUrl('/local/path'), /Invalid url/);
      assert.throws(() => sanitizeStartUrl('example.com'), /Invalid url/);
    });

    it('rejects overly long URLs', () => {
      assert.throws(
        () => sanitizeStartUrl('https://e.com/' + 'a'.repeat(3000)),
        /too long/,
      );
    });
  });

  describe('buildStartCommandArgv', () => {
    it('substitutes {url} as a single argv element', () => {
      const argv = buildStartCommandArgv(
        "'/a b/edge.exe' --flag {url}",
        'https://example.com/x',
      );
      assert.deepStrictEqual(argv, [
        '/a b/edge.exe',
        '--flag',
        'https://example.com/x',
      ]);
    });

    it('keeps an injected URL as ONE arg even with shell metacharacters in path', () => {
      // The placeholder lives in its own token; the sanitized URL replaces it
      // wholesale and cannot split or add arguments.
      const argv = buildStartCommandArgv('edge {url}', 'https://e.com/a%20b');
      assert.strictEqual(argv.length, 2);
      assert.strictEqual(argv[1], 'https://e.com/a%20b');
    });

    it('throws if a url is given but there is no placeholder', () => {
      assert.throws(
        () => buildStartCommandArgv('edge https://fixed', 'https://x.com'),
        /no \{url\} placeholder/,
      );
    });

    it('throws if a placeholder is present but no url is given', () => {
      assert.throws(
        () => buildStartCommandArgv('edge {url}'),
        /url parameter is required/,
      );
    });

    it('passes through unchanged when neither url nor placeholder is present', () => {
      assert.deepStrictEqual(buildStartCommandArgv('edge --headless'), [
        'edge',
        '--headless',
      ]);
    });

    it('rejects a dangerous url before building argv', () => {
      assert.throws(
        () => buildStartCommandArgv('edge {url}', 'file:///etc/passwd'),
        /scheme/,
      );
    });
  });

  describe('disposeAll', () => {
    it('closes connected browsers and empties the registry', async () => {
      const r = BrowserRegistry.getInstance();
      let closed = 0;
      let disposed = 0;
      const browser = {
        connected: true,
        close: async () => {
          closed++;
        },
      } as unknown as Browser;
      const ctx = {
        dispose: () => {
          disposed++;
        },
      } as unknown as McpContext;
      r.addConnectedBrowser(browser, ctx, 'http://a');
      await r.disposeAll();
      assert.strictEqual(disposed, 1);
      assert.strictEqual(closed, 1);
      assert.strictEqual(r.isEmpty(), true);
    });
  });
});
