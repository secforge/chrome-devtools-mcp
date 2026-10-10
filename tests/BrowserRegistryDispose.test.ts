/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import type {BrowserConfig} from '../src/BrowserRegistry.js';
import {BrowserRegistry} from '../src/BrowserRegistry.js';

import {createMockBrowser, createMockMcpContext} from './mocks.js';

/**
 * A browser the server connected to must keep running when the server shuts
 * down; only one the server launched itself may be closed.
 */
function registryWith(entry: {
  launched: boolean;
}): ReturnType<typeof BrowserRegistry.getInstance> {
  BrowserRegistry.resetForTesting();
  const registry = BrowserRegistry.getInstance();
  const config: BrowserConfig = {
    devtools: false,
    mcpContextOptions: {
      experimentalDevToolsDebugging: false,
      performanceCrux: false,
    },
  };
  if (entry.launched) {
    config.launchOptions = {headless: true, isolated: true, devtools: false};
  } else {
    config.browserURL = 'http://127.0.0.1:9222';
  }
  registry.register(
    config,
    entry.launched ? 'launched' : 'http://127.0.0.1:9222',
  );
  return registry;
}

describe('BrowserRegistry.disposeAll', () => {
  afterEach(() => {
    sinon.restore();
    BrowserRegistry.resetForTesting();
  });

  it('disconnects from a browser it did not launch', async () => {
    const registry = registryWith({launched: false});
    const browser = createMockBrowser();
    const context = createMockMcpContext();
    const entry = registry.get(1);
    entry.browser = browser;
    entry.context = context;

    await registry.disposeAll();

    sinon.assert.calledOnce(browser.disconnect);
    sinon.assert.notCalled(browser.close);
    sinon.assert.calledOnce(context.closeOwnTargets);
    sinon.assert.calledOnce(context.dispose);
  });

  it('closes a browser it launched itself', async () => {
    const registry = registryWith({launched: true});
    const browser = createMockBrowser();
    const context = createMockMcpContext();
    const entry = registry.get(1);
    entry.browser = browser;
    entry.context = context;

    await registry.disposeAll();

    sinon.assert.calledOnce(browser.close);
    sinon.assert.notCalled(browser.disconnect);
    // The whole browser goes away, so there is nothing to close individually.
    sinon.assert.notCalled(context.closeOwnTargets);
  });
});
