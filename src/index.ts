/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';

import type {parseArguments} from './bin/chrome-devtools-mcp-cli-options.js';
import type {Channel} from './browser.js';
import {BrowserRegistry, type BrowserConfig} from './BrowserRegistry.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger} from './logger.js';
import type {McpContext} from './McpContext.js';
import {Mutex} from './Mutex.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {FilePersistence} from './telemetry/persistence.js';
import {
  McpServer,
  type CallToolResult,
  SetLevelRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {VERSION} from './version.js';

export {buildFlag} from './ToolHandler.js';

export async function createMcpServer(
  serverArgs: ReturnType<typeof parseArguments>,
  options: {
    logFile?: fs.WriteStream;
  },
) {
  if (serverArgs.usageStatistics) {
    ClearcutLogger.initialize({
      persistence: new FilePersistence(),
      logFile: serverArgs.logFile,
      appVersion: VERSION,
      clearcutEndpoint: serverArgs.clearcutEndpoint,
      clearcutForceFlushIntervalMs: serverArgs.clearcutForceFlushIntervalMs,
      clearcutIncludePidHeader: serverArgs.clearcutIncludePidHeader,
    });
  }

  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP server',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  const registry = BrowserRegistry.getInstance();
  let cachedRoots: Parameters<McpContext['setRoots']>[0] | undefined;

  const updateRoots = async () => {
    if (!server.server.getClientCapabilities()?.roots) {
      return;
    }
    try {
      const roots = await server.server.request(
        {method: 'roots/list'},
        ListRootsResultSchema,
      );
      cachedRoots = roots.roots;
      // Apply to every already-connected browser context.
      for (const entry of registry.getAll()) {
        entry.context?.setRoots(cachedRoots);
      }
    } catch (e) {
      logger?.('Failed to list roots', e);
    }
  };

  server.server.oninitialized = () => {
    const clientName = server.server.getClientVersion()?.name;
    if (clientName) {
      ClearcutLogger.get()?.setClientName(clientName);
    }
    if (server.server.getClientCapabilities()?.roots) {
      void updateRoots();
      server.server.setNotificationHandler(
        RootsListChangedNotificationSchema,
        () => {
          void updateRoots();
        },
      );
    }
  };

  /**
   * Register browser configurations without connecting. The MCP server starts
   * immediately and browser connections are established lazily / in the
   * background. All browsers — including the default launched one — go through
   * the registry so a single code path supports one or many browsers.
   */
  function registerBrowserConfigs(): void {
    const chromeArgs: string[] = (serverArgs.chromeArg ?? []).map(String);
    if (serverArgs.proxyServer) {
      chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
    }
    const devtools = serverArgs.experimentalDevtools ?? false;
    const mcpContextOptions = {
      experimentalDevToolsDebugging: devtools,
      experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
      performanceCrux: serverArgs.performanceCrux ?? false,
    };

    if (serverArgs.browserUrl && serverArgs.browserUrl.length > 0) {
      for (const browserUrlConfig of serverArgs.browserUrl) {
        const config: BrowserConfig = {
          browserURL: browserUrlConfig.url,
          wsHeaders: serverArgs.wsHeaders,
          devtools,
          mcpContextOptions,
          startCommand: browserUrlConfig.startCommand,
        };
        registry.register(config, browserUrlConfig.url);
      }
    } else if (serverArgs.wsEndpoint && serverArgs.wsEndpoint.length > 0) {
      for (const endpoint of serverArgs.wsEndpoint) {
        const config: BrowserConfig = {
          wsEndpoint: endpoint,
          wsHeaders: serverArgs.wsHeaders,
          devtools,
          mcpContextOptions,
        };
        registry.register(config, endpoint);
      }
    } else if (serverArgs.autoConnect) {
      const label = serverArgs.userDataDir
        ? `user-data-dir:${serverArgs.userDataDir}`
        : `channel:${serverArgs.channel}`;
      const config: BrowserConfig = {
        channel: serverArgs.channel as Channel,
        userDataDir: serverArgs.userDataDir,
        devtools,
        mcpContextOptions,
      };
      registry.register(config, label);
    } else {
      const ignoreDefaultChromeArgs: string[] = (
        serverArgs.ignoreDefaultChromeArg ?? []
      ).map(String);
      const config: BrowserConfig = {
        launchOptions: {
          headless: serverArgs.headless,
          executablePath: serverArgs.executablePath,
          channel: serverArgs.channel as Channel,
          isolated: serverArgs.isolated ?? false,
          userDataDir: serverArgs.userDataDir,
          logFile: options.logFile,
          viewport: serverArgs.viewport,
          chromeArgs,
          ignoreDefaultChromeArgs,
          acceptInsecureCerts: serverArgs.acceptInsecureCerts,
          devtools,
          enableExtensions: serverArgs.categoryExtensions,
          viaCli: serverArgs.viaCli,
        },
        devtools,
        mcpContextOptions,
      };
      registry.register(config, 'launched');
    }
    logger?.(`Registered ${registry.count()} browser(s) (connections pending)`);
  }

  async function getContext(browserIndex?: number): Promise<McpContext> {
    const context = await registry.getContext(browserIndex);
    if (cachedRoots) {
      context.setRoots(cachedRoots);
    }
    return context;
  }

  const toolMutex = new Mutex();

  function registerTool(tool: ToolDefinition | DefinedPageTool): void {
    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      getContext,
      toolMutex,
    );

    if (!toolHandler.shouldRegister) {
      return;
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: toolHandler.registeredInputSchema,
        annotations: tool.annotations,
      },
      async (params): Promise<CallToolResult> => {
        return await toolHandler.handle(params);
      },
    );
  }

  registerBrowserConfigs();

  const tools = createTools(serverArgs);
  for (const tool of tools) {
    registerTool(tool);
  }

  await loadIssueDescriptions();

  // Start browser connections in the background (fire-and-forget).
  registry.connectAllInBackground();

  return {server, registry};
}

export const logDisclaimers = (args: ReturnType<typeof parseArguments>) => {
  console.error(
    `chrome-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );

  if (!args.slim && args.performanceCrux) {
    console.error(
      `Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.`,
    );
  }

  if (!args.slim && args.usageStatistics) {
    console.error(
      `
Google collects usage statistics to improve Chrome DevTools MCP. To opt-out, run with --no-usage-statistics.
For more details, visit: https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics`,
    );
  }
};
