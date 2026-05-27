/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';

import {type ParsedArguments} from './config/mcp-options.js';
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
  type Root,
  SetLevelRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {logger} from './utils/logger.js';
import {Mutex} from './third_party/index.js';
import {VERSION} from './version.js';

export {buildFlag} from './ToolHandler.js';

/**
 * Timeout for a `roots/list` that a tool call is waiting on, matching the 5s
 * default used for page operations. `getContext()` awaits it while
 * `ToolHandler` holds the tool mutex, so leaving it unbounded lets a client
 * that negotiates `roots` but does not answer block every tool for the SDK's
 * default of 60s. Background refreshes are not bounded by this, so roots a
 * slow client sends late still land.
 */
const ROOTS_REQUEST_TIMEOUT = 5_000;

export async function createMcpServer(
  serverArgs: ParsedArguments,
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

  // `timeout` is only passed where a tool call is waiting on the result – the
  // background refreshes below block nobody, so bounding them would just discard
  // roots a slow client was about to send
  const updateRoots = async (timeout?: number) => {
    if (!server.server.getClientCapabilities()?.roots) {
      return;
    }
    try {
      const roots = await server.server.request(
        {method: 'roots/list'},
        ListRootsResultSchema,
        timeout === undefined ? undefined : {timeout},
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
    } else if (!serverArgs.allowUnrestrictedPaths) {
      console.warn(
        '[chrome-devtools-mcp] The connecting client did not negotiate the MCP roots ' +
          'capability. File-writing tools will be restricted to the OS temp directory. ' +
          'To restore the previous unrestricted behavior, start the server with ' +
          '--allow-unrestricted-paths.',
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
    const blocklist = serverArgs.blockedUrlPattern
      ? serverArgs.blockedUrlPattern.map(String)
      : undefined;
    const allowlist = serverArgs.allowedUrlPattern
      ? serverArgs.allowedUrlPattern.map(String)
      : undefined;

    const mcpContextOptions = {
      experimentalDevToolsDebugging: devtools,
      experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
      performanceCrux: serverArgs.performanceCrux ?? false,
      allowList: allowlist,
      blocklist,
    };

    if (serverArgs.browserUrl && serverArgs.browserUrl.length > 0) {
      for (const browserUrlConfig of serverArgs.browserUrl) {
        const config: BrowserConfig = {
          browserURL: browserUrlConfig.url,
          wsHeaders: serverArgs.wsHeaders,
          devtools,
          mcpContextOptions,
          startCommand: browserUrlConfig.startCommand,
          blocklist,
          allowlist,
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
          blocklist,
          allowlist,
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
        blocklist,
        allowlist,
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
          blocklist,
          allowlist,
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
>>>>>>> 22863ed (feat: port multi-browser support, list_browsers/reconnect_browser, press_keys onto upstream main)
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

export const logDisclaimers = (args: ParsedArguments) => {
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
