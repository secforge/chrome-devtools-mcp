/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import type {Channel} from './browser.js';
import {BrowserRegistry, type BrowserConfig} from './BrowserRegistry.js';
import {type ParsedArguments} from './config/mcp-options.js';
import {loadIssueDescriptions} from './devtools/issueDescriptions.js';
import {buildServerInstructions} from './server-instructions.js';
import type {McpContext} from './McpContext.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {FilePersistence} from './telemetry/persistence.js';
import {
  McpServer as SdkMcpServer,
  type CallToolResult,
  type Root,
  type Transport,
  SetLevelRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
  Mutex,
  puppeteer,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {logger} from './utils/logger.js';
import {VERSION} from './version.js';

puppeteer.setFollowSymlinks(false);

/**
 * Timeout for a `roots/list` that a tool call is waiting on, matching the 5s
 * default used for page operations. `getContext()` awaits it while
 * `ToolHandler` holds the tool mutex, so leaving it unbounded lets a client
 * that negotiates `roots` but does not answer block every tool for the SDK's
 * default of 60s. Background refreshes are not bounded by this, so roots a
 * slow client sends late still land.
 */
const ROOTS_REQUEST_TIMEOUT = 5_000;

export interface McpServerOptions {
  logFile?: fs.WriteStream;
}

export class McpServer {
  readonly server: SdkMcpServer;
  #serverArgs: ParsedArguments;
  /**
   * Every browser — including a single launched one — goes through the
   * registry, so one code path serves both the one- and many-browser cases.
   */
  readonly registry: BrowserRegistry;
  #options: McpServerOptions;
  #context?: McpContext;

  /**
   * Client roots stay valid across browser reconnects and only the client can
   * invalidate them through a `roots/list_changed` notification. CLI-configured
   * roots are read from `#serverArgs` when combining roots.
   */
  #lastClientRoots?: Root[];
  #toolMutex = new Mutex();

  private constructor(
    serverArgs: ParsedArguments,
    options: McpServerOptions = {},
  ) {
    this.#serverArgs = serverArgs;
    this.#options = options;
    this.registry = BrowserRegistry.getInstance();
    // Registered up front, without connecting, so the instructions can
    // describe the actual browsers and their indices.
    this.#registerBrowserConfigs();

    if (this.#serverArgs.usageStatistics) {
      ClearcutLogger.initialize({
        persistence: new FilePersistence(),
        logFile: this.#serverArgs.logFile,
        appVersion: VERSION,
        clearcutEndpoint: this.#serverArgs.clearcutEndpoint,
        clearcutForceFlushIntervalMs:
          this.#serverArgs.clearcutForceFlushIntervalMs,
        clearcutIncludePidHeader: this.#serverArgs.clearcutIncludePidHeader,
      });
    }

    this.server = new SdkMcpServer(
      {
        name: 'chrome_devtools',
        title: 'Chrome DevTools MCP server',
        version: VERSION,
      },
      {
        capabilities: {logging: {}},
        instructions: buildServerInstructions(
          this.registry.getAll().map(entry => ({
            url: entry.url,
            hasStartCommand: Boolean(entry.config.startCommand),
          })),
        ),
      },
    );

    this.server.server.setRequestHandler(SetLevelRequestSchema, () => {
      return {};
    });

    this.server.server.oninitialized = () => {
      const clientName = this.server.server.getClientVersion()?.name;
      if (clientName) {
        ClearcutLogger.get()?.setClientName(clientName);
      }
      if (this.server.server.getClientCapabilities()?.roots) {
        void this.#updateRoots();
        this.server.server.setNotificationHandler(
          RootsListChangedNotificationSchema,
          () => {
            void this.#updateRoots();
          },
        );
      } else if (
        !this.#serverArgs.allowUnrestrictedPaths &&
        (this.#serverArgs.filesystemRoot ?? []).length === 0
      ) {
        console.warn(
          '[chrome-devtools-mcp] The connecting client did not negotiate the MCP roots ' +
            'capability. File-writing tools will be restricted to the OS temp directory. ' +
            'To restore the previous unrestricted behavior, start the server with ' +
            '--allow-unrestricted-paths.',
        );
      }
    };
  }

  async connect(transport: Transport): Promise<void> {
    return await this.server.connect(transport);
  }

  /**
   * Closes the MCP connection and disposes internal context/listeners.
   */
  async close(): Promise<void> {
    this.#context?.dispose();
    this.#context = undefined;
    await this.server.close();
  }

  [Symbol.dispose](): void {
    this.close().catch(() => {
      // TODO: wire up the logger
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  static async from(
    serverArgs: ParsedArguments,
    options: McpServerOptions = {},
  ): Promise<McpServer> {
    const server = new McpServer(serverArgs, options);
    await server.#init();
    return server;
  }

  async #init(): Promise<void> {
    const tools = createTools(this.#serverArgs, this.registry.count());
    for (const tool of tools) {
      this.#registerTool(tool);
    }
    await loadIssueDescriptions();
    this.registry.connectAllInBackground();
  }

  #combinedRoots(): Root[] | undefined {
    const configuredRoots = (
      this.#serverArgs.allowUnrestrictedPaths
        ? []
        : (this.#serverArgs.filesystemRoot ?? [])
    ).map(root => {
      const rootPath = path.resolve(String(root));
      return {
        uri: pathToFileURL(rootPath).href,
        name: path.basename(rootPath) || rootPath,
      };
    });
    if (configuredRoots.length === 0 && this.#lastClientRoots === undefined) {
      return undefined;
    }
    return [...configuredRoots, ...(this.#lastClientRoots ?? [])];
  }

  /**
   * `timeout` is only passed where a tool call is waiting on the result – the
   * background refreshes below block nobody, so bounding them would just discard
   * roots a slow client was about to send
   */
  async #updateRoots(timeout?: number): Promise<void> {
    if (!this.server.server.getClientCapabilities()?.roots) {
      return;
    }
    try {
      const roots = await this.server.server.request(
        {method: 'roots/list'},
        ListRootsResultSchema,
        timeout === undefined ? undefined : {timeout},
      );
      this.#lastClientRoots = roots.roots;
      this.#context?.setRoots(this.#combinedRoots());
    } catch (e) {
      logger?.('Failed to list roots', e);
    }
  }

  /**
   * Registers every configured browser without connecting. The server starts
   * immediately; connections are established lazily and in the background.
   */
  #registerBrowserConfigs(): void {
    const serverArgs = this.#serverArgs;
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
      sourceMaps: serverArgs.sourceMaps,
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
        this.registry.register(config, browserUrlConfig.url);
      }
    } else if (serverArgs.wsEndpoint) {
      const endpoints = Array.isArray(serverArgs.wsEndpoint)
        ? serverArgs.wsEndpoint
        : [serverArgs.wsEndpoint];
      for (const endpoint of endpoints) {
        const config: BrowserConfig = {
          wsEndpoint: String(endpoint),
          wsHeaders: serverArgs.wsHeaders,
          devtools,
          mcpContextOptions,
          blocklist,
          allowlist,
        };
        this.registry.register(config, String(endpoint));
      }
    } else if (serverArgs.autoConnect) {
      const label = serverArgs.userDataDir
        ? `user-data-dir:${serverArgs.userDataDir}`
        : `channel:${serverArgs.channel}`;
      this.registry.register(
        {
          channel: serverArgs.channel as Channel,
          userDataDir: serverArgs.userDataDir,
          devtools,
          mcpContextOptions,
          blocklist,
          allowlist,
        },
        label,
      );
    } else {
      const ignoreDefaultChromeArgs: string[] = (
        serverArgs.ignoreDefaultChromeArg ?? []
      ).map(String);
      this.registry.register(
        {
          launchOptions: {
            headless: serverArgs.headless,
            executablePath: serverArgs.executablePath,
            channel: serverArgs.channel as Channel,
            isolated: serverArgs.isolated ?? false,
            userDataDir: serverArgs.userDataDir,
            logFile: this.#options.logFile,
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
        },
        'launched',
      );
    }
    logger?.(
      `Registered ${this.registry.count()} browser(s) (connections pending)`,
    );
  }

  async #getContext(browserIndex?: number): Promise<McpContext> {
    const context = await this.registry.getContext(browserIndex);
    // The registry owns context creation, so this only mirrors upstream's
    // roots handling for whichever context a call is routed to.
    const isNewContext = this.#context !== context;
    this.#context = context;
    if (isNewContext) {
      context.setRoots(this.#combinedRoots());
      if (this.#lastClientRoots === undefined) {
        // Nothing listed yet, so this call has to wait - bounded, since it is
        // holding the tool mutex, and a later background refresh still lands
        await this.#updateRoots(ROOTS_REQUEST_TIMEOUT);
      } else {
        // Carry the known roots over and refresh out of band, so a reconnect
        // never pays for a client round-trip
        void this.#updateRoots();
      }
    }
    return context;
  }

  #registerTool(tool: ToolDefinition | DefinedPageTool): void {
    const toolHandler = new ToolHandler(
      tool,
      this.#serverArgs,
      browserIndex => this.#getContext(browserIndex),
      this.#toolMutex,
      this.registry.count(),
    );

    if (!toolHandler.shouldRegister) {
      return;
    }

    this.server.registerTool(
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
}

/**
 * Creates and initializes a Chrome DevTools MCP server instance.
 *
 * Maintained as a public API for backwards compatibility because external
 * consumers and integrations rely on `createMcpServer()`. For new code,
 * prefer using `McpServer.from(serverArgs, options)`.
 */
export async function createMcpServer(
  serverArgs: ParsedArguments,
  options: McpServerOptions = {},
): Promise<{server: SdkMcpServer}> {
  const server = await McpServer.from(serverArgs, options);
  return {server: server.server};
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
