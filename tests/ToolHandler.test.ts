/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {parseArguments} from '../src/bin/chrome-devtools-mcp-cli-options.js';
import {McpContext} from '../src/McpContext.js';
import {McpPage} from '../src/McpPage.js';
import {Mutex} from '../src/Mutex.js';
import {zod} from '../src/third_party/index.js';
import {ToolHandler} from '../src/ToolHandler.js';
import {ToolCategory} from '../src/tools/categories.js';
import type {
  DefinedPageTool,
  ToolDefinition,
} from '../src/tools/ToolDefinition.js';

function serverArgs() {
  return parseArguments('1.0.0', ['node', 'script.js'], {
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
  });
}

describe('ToolHandler', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('calls page getter for page scoped tools', async () => {
    let handlerCalled = false;
    const tool: DefinedPageTool = {
      name: 'page_tool',
      description: 'A page scoped tool',
      annotations: {
        category: ToolCategory.INPUT,
        readOnlyHint: false,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      pageScoped: true,
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    const mockPage = sinon.createStubInstance(McpPage);
    mockContext.getSelectedMcpPage.returns(mockPage);
    mockContext.detectOpenDevToolsWindows.resolves();

    const toolMutex = new Mutex();

    const toolHandler = new ToolHandler(
      tool,
      serverArgs(),
      async () => mockContext,
      toolMutex,
      1,
    );

    assert.strictEqual(toolHandler.shouldRegister, true);
    await toolHandler.handle({});

    assert.strictEqual(mockContext.getSelectedMcpPage.calledOnce, true);
    assert.strictEqual(handlerCalled, true);
  });

  it('does not call page getter for non-page scoped tools', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'global_tool',
      description: 'A global tool',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    mockContext.detectOpenDevToolsWindows.resolves();

    const toolMutex = new Mutex();

    const toolHandler = new ToolHandler(
      tool,
      serverArgs(),
      async () => mockContext,
      toolMutex,
      1,
    );

    assert.strictEqual(toolHandler.shouldRegister, true);
    const result = await toolHandler.handle({});

    assert.strictEqual(mockContext.getSelectedMcpPage.called, false);
    assert.strictEqual(mockContext.getPageById.called, false);
    assert.strictEqual(handlerCalled, true);
    assert.strictEqual(result.isError, undefined);
  });

  describe('browserIndex injection', () => {
    const browserScopedTool: ToolDefinition = {
      name: 'browser_scoped',
      description: 'A browser-scoped tool',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        // no-op test handler
      },
    };

    function handlerFor(browserCount: number) {
      const mockContext = sinon.createStubInstance(McpContext);
      return new ToolHandler(
        browserScopedTool,
        serverArgs(),
        async () => mockContext,
        new Mutex(),
        browserCount,
      );
    }

    it('injects browserIndex when multiple browsers are connected', () => {
      const handler = handlerFor(2);
      assert.ok(
        !handler
          .unknownArgumentNames({browserIndex: 1})
          .includes('browserIndex'),
      );
    });

    it('omits browserIndex when a single browser is connected', () => {
      const handler = handlerFor(1);
      assert.ok(
        handler
          .unknownArgumentNames({browserIndex: 1})
          .includes('browserIndex'),
      );
    });
  });

  it('reports unknown arguments without browserIndex for a single browser', async () => {
    const tool: ToolDefinition = {
      name: 'lenient_tool',
      description: 'A tool with a required argument',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {
        url: zod.string(),
      },
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        // no-op test handler
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    mockContext.detectOpenDevToolsWindows.resolves();

    const toolHandler = new ToolHandler(
      tool,
      serverArgs(),
      async () => mockContext,
      new Mutex(),
      1,
    );

    const params = {url: 'https://example.com', description: 'open the page'};
    const result = await toolHandler.handle(params);

    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0].type === 'text' ? result.content[0].text : '',
      /Unknown argument for tool "lenient_tool": "description"\. Expected arguments: "url"\./,
    );
  });

  it('reports unknown arguments including browserIndex for multiple browsers', async () => {
    const tool: ToolDefinition = {
      name: 'lenient_tool',
      description: 'A tool with a required argument',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {
        url: zod.string(),
      },
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        // no-op test handler
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    mockContext.detectOpenDevToolsWindows.resolves();

    const toolHandler = new ToolHandler(
      tool,
      serverArgs(),
      async () => mockContext,
      new Mutex(),
      3,
    );

    const params = {url: 'https://example.com', description: 'open the page'};
    const result = await toolHandler.handle(params);

    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0].type === 'text' ? result.content[0].text : '',
      /Unknown argument for tool "lenient_tool": "description"\. Expected arguments: "browserIndex", "url"\./,
    );
  });

  it('sets shouldRegister to false and returns disabled reason when category is disabled', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'disabled_tool',
      description: 'A disabled tool',
      annotations: {
        category: ToolCategory.EMULATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      verifyFilesSchema: [],
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    const toolMutex = new Mutex();
    const args = parseArguments(
      '1.0.0',
      ['node', 'script.js', '--categoryEmulation=false'],
      {CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true'},
    );

    const toolHandler = new ToolHandler(
      tool,
      args,
      async () => mockContext,
      toolMutex,
      1,
    );

    assert.strictEqual(toolHandler.shouldRegister, false);

    const result = await toolHandler.handle({});
    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0].type === 'text' ? result.content[0].text : '',
      /is currently disabled/,
    );
    assert.strictEqual(handlerCalled, false);
  });
});
