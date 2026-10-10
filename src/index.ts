/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {BrowserManager} from './BrowserManager.js';
import type {Browser} from './third_party/index.js';
import {BrowserRegistry} from './BrowserRegistry.js';
import {type ParsedArguments} from './config/ConfigParser.js';
import {loadIssueDescriptions} from './devtools/issueDescriptions.js';
import {buildServerInstructions} from './server-instructions.js';
import {McpContext} from './McpContext.js';
import {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {FilePersistence} from './telemetry/persistence.js';
import {
  type CallToolResult,
  McpServer as SdkMcpServer,
  type RegisteredTool,
  type Root,
  type Transport,
  Mutex,
  puppeteer,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import {
  type DefinedPageTool,
  isAvailableInMode,
  type ToolDefinition,
} from './tools/ToolDefinition.js';
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
  browserManager: BrowserManager;
  logFile?: fs.WriteStream;
}

interface ToolEntry {
  handler: ToolHandler;
  registeredTool: RegisteredTool;
}

export class McpServer {
  readonly server: SdkMcpServer;
  #serverArgs: ParsedArguments;
  #browserManager: BrowserManager;
  /**
   * Every configured browser goes through the registry, so one code path
   * serves both the one- and many-browser cases.
   */
  readonly registry: BrowserRegistry;
  #context?: McpContext;

  /**
   * Client roots stay valid across browser reconnects and only the client can
   * invalidate them through a `roots/list_changed` notification. CLI-configured
   * roots are read from `#serverArgs` when combining roots.
   */
  #lastClientRoots?: Root[];
  #toolMutex = new Mutex();
  #tools = new Map<string, ToolEntry>();

  private constructor(serverArgs: ParsedArguments, options: McpServerOptions) {
    this.#serverArgs = serverArgs;
    this.#browserManager = options.browserManager;
    this.registry = BrowserRegistry.getInstance();
    // Registered before the instructions are built, so those can describe the
    // actual browsers and their indices.
    this.registry.setContextFactory(browser => this.#createContext(browser));
    this.#registerBrowserConfigs(options);

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
        capabilities: {logging: {}, tools: {listChanged: true}},
        // Enabling or updating many tools at once sends a single notification.
        debouncedNotificationMethods: ['notifications/tools/list_changed'],
        // Describes the browsers that are actually configured, with their
        // indices, so the model never has to guess which one to target.
        instructions: buildServerInstructions(
          this.registry.getAll().map(entry => ({
            url: entry.url,
            hasStartCommand: Boolean(entry.config.startCommand),
          })),
        ),
      },
    );

    this.server.server.setRequestHandler('logging/setLevel', () => {
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
          'notifications/roots/list_changed',
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

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    const toolHandler = this.#tools.get(name)?.handler;
    if (!toolHandler) {
      return {
        content: [
          {
            type: 'text',
            text: `Tool ${name} not found`,
          },
        ],
        isError: true,
      };
    }
    const parseResult =
      await toolHandler.registeredInputSchema.safeParseAsync(args);
    if (!parseResult.success) {
      return {
        content: [
          {
            type: 'text',
            text: `Input validation error: Invalid arguments for tool ${name}: ${parseResult.error.issues
              .map(
                issue =>
                  `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`,
              )
              .join(', ')}`,
          },
        ],
        isError: true,
      };
    }
    return await toolHandler.handle(parseResult.data);
  }

  /**
   * Closes the MCP connection and disposes internal context/listeners.
   */
  async close(): Promise<void> {
    // Contexts live on their registry entries; disposeAll() closes the tabs we
    // opened and then disposes each one, so disposing here first would pull
    // the context out from under that cleanup.
    this.#context = undefined;
    await Promise.allSettled([
      this.#browserManager.close(),
      this.registry.disposeAll(),
      this.server.close(),
    ]);
  }

  [Symbol.dispose](): void {
    this.close().catch(err => {
      logger?.('Failed to dispose McpServer', err);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  static async from(
    serverArgs: ParsedArguments,
    options: McpServerOptions,
  ): Promise<McpServer> {
    const server = new McpServer(serverArgs, options);
    await server.#init();
    return server;
  }

  async #init(): Promise<void> {
    this.registry.connectAllInBackground();
    for (const tool of createTools(this.#serverArgs)) {
      // Slim and regular tools may share names, only register the current mode.
      if (isAvailableInMode(tool, this.#serverArgs)) {
        this.#registerTool(tool);
      }
    }
    await loadIssueDescriptions();
  }

  #combinedRoots(): Root[] | undefined {
    const configuredRoots = (
      this.#serverArgs.allowUnrestrictedPaths
        ? []
        : (this.#serverArgs.filesystemRoot ?? [])
    ).map(root => {
      const rootPath = path.resolve(root);
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
      const result = await this.server.server.request(
        {method: 'roots/list'},
        timeout === undefined ? undefined : {timeout},
      );
      this.#lastClientRoots = result.roots;
      // Every browser has its own context, and roots are a path restriction:
      // updating only the selected one would leave the others reachable with
      // the roots they were created with, after the client narrowed them.
      this.#applyRootsToAllContexts();
    } catch (e) {
      logger?.('Failed to list roots', e);
    }
  }

  /**
   * Registers every configured browser without connecting. The server starts
   * immediately; connections are established lazily and in the background.
   * A browser given as --browser-url may carry a start command used by
   * reconnect_browser.
   */
  #registerBrowserConfigs(options: McpServerOptions): void {
    const serverArgs = this.#serverArgs;
    const mcpContextOptions = {
      experimentalDevToolsDebugging: serverArgs.experimentalDevtools ?? false,
      experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
      performanceCrux: serverArgs.performanceCrux,
      sourceMaps: serverArgs.sourceMaps,
      allowlist: serverArgs.allowedUrlPattern,
      blocklist: serverArgs.blockedUrlPattern,
      allowUnrestrictedPaths: serverArgs.allowUnrestrictedPaths,
      categoryExtensions: serverArgs.categoryExtensions,
    };

    const urls = serverArgs.browserUrls ?? [];
    const endpoints = serverArgs.wsEndpoints ?? [];

    if (urls.length > 0) {
      for (const entry of urls) {
        this.registry.register(
          {
            serverArgs: {...serverArgs, browserUrl: entry.url},
            mcpContextOptions,
            startCommand: entry.startCommand,
          },
          entry.url,
        );
      }
      return;
    }

    if (endpoints.length > 0) {
      for (const endpoint of endpoints) {
        this.registry.register(
          {
            serverArgs: {...serverArgs, wsEndpoint: endpoint},
            mcpContextOptions,
          },
          endpoint,
        );
      }
      return;
    }

    // No multi-browser input: the single browser the server was built with.
    this.registry.addManager(
      options.browserManager,
      {
        serverArgs,
        mcpContextOptions,
        launched: !serverArgs.browserUrl && !serverArgs.wsEndpoint,
      },
      serverArgs.browserUrl ?? serverArgs.wsEndpoint ?? 'launched',
    );
  }

  /**
   * The one place a context is built. The registry calls this as soon as a
   * browser connects, so list_browsers can report its pages - with the same
   * ids page tools resolve - before any other tool has run.
   */
  async #createContext(browser: Browser): Promise<McpContext> {
    return await McpContext.from(browser, logger, {
      experimentalDevToolsDebugging:
        this.#serverArgs.experimentalDevtools ?? false,
      experimentalIncludeAllPages: this.#serverArgs.experimentalIncludeAllPages,
      performanceCrux: this.#serverArgs.performanceCrux,
      sourceMaps: this.#serverArgs.sourceMaps,
      allowlist: this.#serverArgs.allowedUrlPattern,
      blocklist: this.#serverArgs.blockedUrlPattern,
      allowUnrestrictedPaths: this.#serverArgs.allowUnrestrictedPaths,
      // Surfaces a one-time note in the next response after a reconnect.
      reconnected: this.#context !== undefined,
      categoryExtensions: this.#serverArgs.categoryExtensions,
      onNotification: (message: string) => {
        void this.server
          .sendLoggingMessage({
            level: 'info',
            data: message,
          })
          .catch(e => {
            logger?.('Failed to send MCP notification', e);
          });
      },
    });
  }

  /** Applies the current roots to every browser's context. */
  #applyRootsToAllContexts(): void {
    const roots = this.#combinedRoots();
    for (const entry of this.registry.getAll()) {
      entry.context?.setRoots(roots);
    }
    this.#context?.setRoots(roots);
  }

  async #getContext(browserIndex?: number): Promise<McpContext> {
    const index = this.registry.resolveIndex(browserIndex);
    const browser = await this.registry.ensureBrowser(index);
    const entry = this.registry.get(index);

    // One context per browser, kept on its registry entry. Switching browsers
    // must not dispose the one we are leaving: with several browsers the model
    // goes back and forth, and a disposed context takes its pages with it.
    if (entry.context?.browser !== browser) {
      // Only this entry's own stale context is disposed, when its browser was
      // replaced by a reconnect.
      entry.context?.dispose();
      entry.context = await this.#createContext(browser);
      entry.context.setRoots(this.#combinedRoots());
      this.#context = entry.context;
      if (this.#lastClientRoots === undefined) {
        // Nothing listed yet, so this call has to wait – bounded, since it is
        // holding the tool mutex, and a later background refresh still lands
        await this.#updateRoots(ROOTS_REQUEST_TIMEOUT);
      } else {
        // Carry the known roots over and refresh out of band, so a reconnect
        // never pays for a client round-trip
        void this.#updateRoots();
      }
    }
    this.#context = entry.context;
    return entry.context;
  }

  #createToolHandler(tool: ToolDefinition | DefinedPageTool): ToolHandler {
    return new ToolHandler(
      tool,
      this.#serverArgs,
      browserIndex => this.#getContext(browserIndex),
      this.#toolMutex,
      browser => this.#browserManager.forget(browser),
      () => this.#browserManager.abandonPendingAttempt(),
      this.registry.count(),
    );
  }

  #registerTool(tool: ToolDefinition | DefinedPageTool): void {
    const handler = this.#createToolHandler(tool);

    const registeredTool = this.server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: handler.registeredInputSchema,
        annotations: tool.annotations,
      },
      handler.handle,
    );

    if (handler.disabled) {
      registeredTool.disable();
    }

    this.#tools.set(tool.name, {handler, registeredTool});
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
  options: {
    logFile?: fs.WriteStream;
  },
): Promise<{server: SdkMcpServer}> {
  const browserManager = new BrowserManager(serverArgs, {
    logFile: options.logFile,
  });
  const server = await McpServer.from(serverArgs, {
    browserManager,
    ...options,
  });
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
