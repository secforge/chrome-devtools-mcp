/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {beforeEach, describe, it} from 'node:test';

import {BrowserRegistry} from '../src/BrowserRegistry.js';
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
