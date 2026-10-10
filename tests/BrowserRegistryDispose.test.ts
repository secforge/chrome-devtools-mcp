/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {BrowserManager} from '../src/BrowserManager.js';
import {BrowserRegistry} from '../src/BrowserRegistry.js';
import type {McpContext} from '../src/McpContext.js';

import {createMockParsedArguments} from './mocks.js';

/**
 * Closing a browser we launched versus disconnecting from one that was already
 * running is BrowserManager's job. What the registry still owns is tidying up
 * the tabs this server opened before letting go of a browser it did not launch.
 */
describe('BrowserRegistry.disposeAll', () => {
  afterEach(() => {
    sinon.restore();
    BrowserRegistry.resetForTesting();
  });

  function entryWith(launched: boolean) {
    const registry = BrowserRegistry.getInstance();
    const manager = new BrowserManager(createMockParsedArguments());
    const closeStub = sinon.stub(manager, 'close').resolves();
    registry.addManager(
      manager,
      {
        serverArgs: createMockParsedArguments(),
        launched,
      },
      launched ? 'launched' : 'http://127.0.0.1:9222',
    );
    const closeOwnTargets = sinon.stub().resolves();
    const dispose = sinon.stub();
    const context = {closeOwnTargets, dispose} as unknown as McpContext;
    registry.get(1).context = context;
    return {registry, closeStub, closeOwnTargets, dispose};
  }

  it('closes the tabs it opened before letting go of a browser it did not launch', async () => {
    const {registry, closeStub, closeOwnTargets, dispose} = entryWith(false);

    await registry.disposeAll();

    sinon.assert.calledOnce(closeOwnTargets);
    sinon.assert.calledOnce(dispose);
    sinon.assert.calledOnce(closeStub);
    assert.strictEqual(registry.isEmpty(), true);
  });

  it('skips that cleanup for a browser it launched itself', async () => {
    const {registry, closeStub, closeOwnTargets} = entryWith(true);

    await registry.disposeAll();

    // The whole browser goes away, so there is nothing to tidy individually.
    sinon.assert.notCalled(closeOwnTargets);
    sinon.assert.calledOnce(closeStub);
  });
});
