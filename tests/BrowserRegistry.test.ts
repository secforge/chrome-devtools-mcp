/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';

import sinon from 'sinon';
import {beforeEach, describe, it} from 'node:test';

import {
  BrowserRegistry,
  buildStartCommandArgv,
  parseCommandLine,
  sanitizeStartUrl,
} from '../src/BrowserRegistry.js';
import type {BrowserConfig} from '../src/BrowserRegistry.js';
import {BrowserManager} from '../src/BrowserManager.js';
import {createMockParsedArguments} from './mocks.js';
import type {McpContext} from '../src/McpContext.js';
import type {Browser} from '../src/third_party/index.js';

function makeConfig(browserURL: string): BrowserConfig {
  // Each entry drives one BrowserManager, built from args narrowed to this
  // single browser.
  return {
    serverArgs: {...createMockParsedArguments(), browserUrl: browserURL},
  };
}

function fakeManager(): BrowserManager {
  return new BrowserManager(createMockParsedArguments());
}

function fakeBrowser(connected = true): Browser {
  return {connected} as unknown as Browser;
}

function fakeContext(): McpContext {
  return {
    dispose: () => {
      // no-op
    },
  } as unknown as McpContext;
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
      await assert.rejects(() => r.ensureBrowser(1), /must NOT be specified/);
    });

    it('requires an index when multiple browsers exist', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      r.register(makeConfig('http://b'), 'http://b');
      await assert.rejects(() => r.ensureBrowser(undefined), /is required/);
    });

    it('rejects an out-of-bounds index', async () => {
      const r = BrowserRegistry.getInstance();
      r.register(makeConfig('http://a'), 'http://a');
      r.register(makeConfig('http://b'), 'http://b');
      await assert.rejects(() => r.ensureBrowser(99), /out of bounds/);
    });

    it('returns the browser for the requested index', async () => {
      // The registry hands out browsers; McpServer owns the single context
      // per browser, so page ids are numbered in one place.
      const r = BrowserRegistry.getInstance();
      const b1 = fakeBrowser();
      const b2 = fakeBrowser();
      r.addConnectedBrowser(b1, fakeContext(), 'http://a', fakeManager());
      r.addConnectedBrowser(b2, fakeContext(), 'http://b', fakeManager());
      assert.strictEqual(await r.ensureBrowser(1), b1);
      assert.strictEqual(await r.ensureBrowser(2), b2);
    });

    it('returns the only browser with no index in single-browser mode', async () => {
      const r = BrowserRegistry.getInstance();
      const browser = fakeBrowser();
      r.addConnectedBrowser(browser, fakeContext(), 'http://a', fakeManager());
      assert.strictEqual(await r.ensureBrowser(), browser);
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
      await assert.rejects(
        () => r.ensureBrowser(),
        /connection failed recently/,
      );
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
    it('lets the manager close each browser, and empties the registry', async () => {
      // Closing a launched browser versus disconnecting from one that was
      // already running is BrowserManager's decision; the registry delegates.
      const r = BrowserRegistry.getInstance();
      const manager = fakeManager();
      const close = sinon.stub(manager, 'close').resolves();
      let disposed = 0;
      let ownTargetsClosed = 0;
      const context = {
        dispose: () => {
          disposed++;
        },
        closeOwnTargets: async () => {
          ownTargetsClosed++;
        },
      } as unknown as McpContext;
      r.addConnectedBrowser(fakeBrowser(), context, 'http://a', manager);

      await r.disposeAll();

      sinon.assert.calledOnce(close);
      assert.strictEqual(disposed, 1);
      assert.strictEqual(ownTargetsClosed, 1);
      assert.strictEqual(r.isEmpty(), true);
    });
  });

  describe('dispose', () => {
    it('keeps the slot when a single browser is disposed', async () => {
      const r = BrowserRegistry.getInstance();
      const manager = fakeManager();
      const close = sinon.stub(manager, 'close').resolves();
      r.addConnectedBrowser(fakeBrowser(), fakeContext(), 'http://a', manager);

      await r.dispose(1);

      sinon.assert.calledOnce(close);
      assert.strictEqual(r.count(), 1);
      assert.strictEqual(r.get(1).state, 'disconnected');
    });

    it('delegates to the manager when terminate=true', async () => {
      const r = BrowserRegistry.getInstance();
      const manager = fakeManager();
      const close = sinon.stub(manager, 'close').resolves();
      r.addConnectedBrowser(fakeBrowser(), fakeContext(), 'http://a', manager);

      await r.dispose(1, true);

      sinon.assert.calledOnce(close);
      assert.strictEqual(r.count(), 1);
    });

    it('delegates a launched browser to its manager too', async () => {
      // The launched-vs-connected decision lives in BrowserManager; the
      // registry asks it to close either way.
      const r = BrowserRegistry.getInstance();
      const manager = fakeManager();
      const close = sinon.stub(manager, 'close').resolves();
      r.addConnectedBrowser(fakeBrowser(), fakeContext(), 'launched', manager);
      r.getAll()[0].config.launched = true;

      await r.dispose(1);

      sinon.assert.calledOnce(close);
      assert.strictEqual(r.getAll()[0].state, 'disconnected');
    });
  });
});
