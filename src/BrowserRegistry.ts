/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';

import type {Channel} from './browser.js';
import {
  ensureBrowserConnected,
  launch,
  type McpLaunchOptions,
} from './browser.js';
import {McpContext} from './McpContext.js';
import {Mutex} from './third_party/index.js';
import {logger} from './utils/logger.js';
import type {Browser} from './third_party/index.js';

export type ConnectionState =
  | 'pending'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export interface McpContextOptions {
  experimentalDevToolsDebugging: boolean;
  experimentalIncludeAllPages?: boolean;
  performanceCrux: boolean;
}

export interface BrowserConfig {
  browserURL?: string;
  wsEndpoint?: string;
  wsHeaders?: Record<string, string>;
  channel?: Channel;
  userDataDir?: string;
  launchOptions?: McpLaunchOptions;
  devtools: boolean;
  mcpContextOptions: McpContextOptions;
  /** Shell command to start the browser on reconnect if connection fails. */
  startCommand?: string;
  blocklist?: string[];
  allowlist?: string[];
}

export interface BrowserEntry {
  config: BrowserConfig;
  browser?: Browser;
  context?: McpContext;
  state: ConnectionState;
  lastError?: Error;
  lastAttempt?: number;
  connectionMutex: Mutex;
  url: string;
}

const RETRY_COOLDOWN_MS = 60_000; // 1 minute cooldown before auto-retry

/**
 * Split a start command into an argv array using POSIX-style quoting rules
 * (single quotes are literal; double quotes allow \\ escapes of " \\ $ `).
 *
 * The result is spawned WITHOUT a shell, so shell metacharacters such as
 * `;`, `|`, `&&`, `$(...)` and backticks are treated as literal argument text
 * and cannot chain or substitute commands. This prevents a model-triggered
 * reconnect from escalating an operator-configured start command into
 * arbitrary shell execution.
 */
export function parseCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (
        ch === '\\' &&
        i + 1 < command.length &&
        ['"', '\\', '$', '`'].includes(command[i + 1])
      ) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        args.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (inSingle || inDouble) {
    throw new Error('Unterminated quote in start command');
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

const URL_PLACEHOLDER = '{url}';
const ALLOWED_START_URL_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_START_URL_LENGTH = 2048;

/**
 * Validate a (potentially model-supplied) URL before it is substituted into a
 * start command. Only absolute http(s) URLs are allowed — this guarantees the
 * value cannot begin with '-' (so it can never be parsed as an executable
 * flag) and cannot use a dangerous scheme (file:, javascript:, data:,
 * chrome:, ...). Returns the normalized URL.
 *
 * @throws Error if the URL is too long, unparseable, or uses a disallowed
 * scheme.
 */
export function sanitizeStartUrl(url: string): string {
  if (url.length > MAX_START_URL_LENGTH) {
    throw new Error(
      `url is too long (max ${MAX_START_URL_LENGTH} characters).`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid url "${url}": must be an absolute http(s) URL.`);
  }
  if (!ALLOWED_START_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Disallowed url scheme "${parsed.protocol}" in "${url}": only http and https are allowed.`,
    );
  }
  return parsed.href;
}

/**
 * Build the argv for a start command, substituting the {url} placeholder with
 * a sanitized URL. Substitution happens AFTER tokenization, so the URL is
 * always exactly one argv element and can never split into extra arguments or
 * be reinterpreted as a flag.
 *
 * @throws Error if a url is supplied without a placeholder to receive it, or a
 * placeholder is present without a url, or the url fails sanitization.
 */
export function buildStartCommandArgv(command: string, url?: string): string[] {
  const argv = parseCommandLine(command);
  const hasPlaceholder = argv.some(token => token.includes(URL_PLACEHOLDER));

  if (url !== undefined) {
    if (!hasPlaceholder) {
      throw new Error(
        `Start command has no ${URL_PLACEHOLDER} placeholder to receive the url.`,
      );
    }
    const safe = sanitizeStartUrl(url);
    return argv.map(token => token.split(URL_PLACEHOLDER).join(safe));
  }

  if (hasPlaceholder) {
    throw new Error(
      `This browser's start command contains a ${URL_PLACEHOLDER} placeholder; a url parameter is required to reconnect it.`,
    );
  }
  return argv;
}

/**
 * Registry for managing multiple browser instances in parallel.
 */
export class BrowserRegistry {
  private browsers: BrowserEntry[] = [];

  private static instance: BrowserRegistry | null = null;

  /**
   * Get the singleton instance of BrowserRegistry. Used by tools to access
   * the registry without creating circular dependencies.
   */
  static getInstance(): BrowserRegistry {
    if (!BrowserRegistry.instance) {
      BrowserRegistry.instance = new BrowserRegistry();
    }
    return BrowserRegistry.instance;
  }

  /**
   * Reset the singleton instance. Should only be used in tests.
   * @internal
   */
  static resetForTesting(): void {
    BrowserRegistry.instance = null;
  }

  /**
   * Register a browser configuration without connecting.
   * @returns The index of the registered browser (1-based)
   */
  register(config: BrowserConfig, url: string): number {
    this.browsers.push({
      config,
      state: 'pending',
      connectionMutex: new Mutex(),
      url,
    });
    const index = this.browsers.length;
    logger?.(`Browser registered at index ${index}: ${url} (pending)`);
    return index;
  }

  /**
   * Add an already-connected browser to the registry.
   * Used for testing and backwards compatibility.
   * @returns The index of the added browser (1-based)
   */
  addConnectedBrowser(
    browser: Browser,
    context: McpContext,
    url: string,
  ): number {
    this.browsers.push({
      config: {
        devtools: false,
        mcpContextOptions: {
          experimentalDevToolsDebugging: false,
          performanceCrux: false,
        },
      },
      browser,
      context,
      state: 'connected',
      connectionMutex: new Mutex(),
      url,
    });
    const index = this.browsers.length;
    logger?.(`Browser added at index ${index}: ${url} (connected)`);
    return index;
  }

  /**
   * Spawn the operator-configured start command for a browser. The command is
   * parsed into argv and executed WITHOUT a shell (no shell-metacharacter
   * interpretation), detached so it doesn't block or keep the parent alive.
   */
  private spawnStartCommand(
    index: number,
    command: string,
    url?: string,
  ): void {
    const argv = buildStartCommandArgv(command, url);
    if (argv.length === 0) {
      logger?.(`Browser ${index}: empty start command, nothing to spawn`);
      return;
    }
    const [file, ...args] = argv;
    logger?.(
      `Browser ${index}: Spawning start command: ${file} ${args.join(' ')}`,
    );
    const child = spawn(file, args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Try to connect to a browser.
   */
  private async tryConnect(entry: BrowserEntry): Promise<Browser> {
    return entry.config.launchOptions
      ? await launch(entry.config.launchOptions)
      : await ensureBrowserConnected({
          browserURL: entry.config.browserURL,
          wsEndpoint: entry.config.wsEndpoint,
          wsHeaders: entry.config.wsHeaders,
          devtools: entry.config.devtools,
          channel: entry.config.channel,
          userDataDir: entry.config.userDataDir,
          blocklist: entry.config.blocklist,
          allowlist: entry.config.allowlist,
          reuseGlobal: false,
        });
  }

  /**
   * Attempt connection to a browser (called by reconnect_browser or background
   * init).
   * @param index Browser index (1-based)
   * @param force If true, bypasses cooldown check (for manual reconnect)
   * @param runStartCommand If true and connection fails, run the configured
   * start command
   * @param startUrl Optional sanitized-on-use URL substituted into the start
   * command's {url} placeholder when (re)launching the browser
   */
  async connect(
    index: number,
    force = false,
    runStartCommand = false,
    startUrl?: string,
  ): Promise<McpContext> {
    if (index < 1 || index > this.browsers.length) {
      throw new Error(
        `Browser index ${index} is out of bounds. Valid range: 1-${this.browsers.length}`,
      );
    }

    const entry = this.browsers[index - 1];

    // Acquire mutex to prevent duplicate connection attempts
    const guard = await entry.connectionMutex.acquire();
    try {
      // Re-check state after acquiring mutex to prevent race condition
      if (!force && entry.state === 'connected' && entry.browser?.connected) {
        if (!entry.context) {
          throw new Error(
            `Browser ${index} is marked as connected but context is missing`,
          );
        }
        return entry.context;
      }

      // Dispose old context if exists
      if (entry.context) {
        entry.context.dispose();
        entry.context = undefined;
      }

      // Attempt connection
      entry.state = 'connecting';
      entry.lastAttempt = Date.now();
      logger?.(
        `Connecting to browser ${index}: ${entry.config.browserURL || entry.config.wsEndpoint || 'launch'}`,
      );

      let browser: Browser | undefined;
      try {
        browser = await this.tryConnect(entry);
      } catch (firstError) {
        // If connection failed and we have a start command AND runStartCommand
        // is true, try to start the browser.
        if (runStartCommand && entry.config.startCommand) {
          logger?.(
            `Browser ${index}: Initial connection failed, attempting to start browser...`,
          );
          this.spawnStartCommand(index, entry.config.startCommand, startUrl);

          // Wait for browser to start (try a few times with delays)
          const maxRetries = 5;
          const retryDelayMs = 2000;
          let lastError = firstError;

          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            await this.sleep(retryDelayMs);
            logger?.(
              `Browser ${index}: Retry attempt ${attempt}/${maxRetries}...`,
            );
            try {
              browser = await this.tryConnect(entry);
              logger?.(
                `Browser ${index}: Connected successfully after starting browser`,
              );
              break;
            } catch (retryError) {
              lastError = retryError;
              if (attempt === maxRetries) {
                throw lastError;
              }
            }
          }
        } else {
          throw firstError;
        }
      }

      if (!browser) {
        throw new Error(
          `Failed to connect to browser ${index} after all retry attempts`,
        );
      }

      const context = await McpContext.from(
        browser,
        logger,
        entry.config.mcpContextOptions,
      );

      entry.browser = browser;
      entry.context = context;
      entry.state = 'connected';
      entry.lastError = undefined;

      logger?.(`Browser ${index} connected successfully`);
      return context;
    } catch (error) {
      entry.state = 'disconnected';
      entry.lastError = error as Error;
      logger?.(
        `Browser ${index} connection failed: ${(error as Error).message}`,
      );
      throw new Error(
        `Failed to connect to browser ${index}: ${(error as Error).message}`,
      );
    } finally {
      guard[Symbol.dispose]();
    }
  }

  /**
   * Connect if needed (respects cooldown), return context.
   * @param index Browser index (1-based)
   */
  async ensureConnected(index: number): Promise<McpContext> {
    if (index < 1 || index > this.browsers.length) {
      throw new Error(
        `Browser index ${index} is out of bounds. Valid range: 1-${this.browsers.length}`,
      );
    }

    const entry = this.browsers[index - 1];

    // Already connected and still alive
    if (entry.state === 'connected' && entry.browser?.connected) {
      if (!entry.context) {
        throw new Error(
          `Browser ${index} is marked as connected but context is missing`,
        );
      }
      return entry.context;
    }

    // Check cooldown - if recently failed, don't auto-retry
    if (entry.state === 'disconnected' && entry.lastAttempt) {
      const elapsed = Date.now() - entry.lastAttempt;
      if (elapsed < RETRY_COOLDOWN_MS) {
        const waitSec = Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000);
        throw new Error(
          `Browser ${index} connection failed recently. ` +
            `Use reconnect_browser to retry now, or wait ${waitSec}s for auto-retry. ` +
            `Last error: ${entry.lastError?.message}`,
        );
      }
    }

    // Attempt connection
    return this.connect(index);
  }

  /**
   * Start all connections without waiting.
   */
  connectAllInBackground(): void {
    for (let i = 0; i < this.browsers.length; i++) {
      const index = i + 1;
      // Fire-and-forget connection
      this.connect(index).catch(error => {
        logger?.(
          `Background connection to browser ${index} failed: ${error.message}`,
        );
      });
    }
  }

  /**
   * Check if cooldown period has passed for a browser.
   */
  canRetry(index: number): boolean {
    if (index < 1 || index > this.browsers.length) {
      return false;
    }
    const entry = this.browsers[index - 1];
    if (entry.state !== 'disconnected' || !entry.lastAttempt) {
      return true;
    }
    const elapsed = Date.now() - entry.lastAttempt;
    return elapsed >= RETRY_COOLDOWN_MS;
  }

  /**
   * Get a browser entry by index (1-based).
   * @throws Error if index is out of bounds
   */
  get(index: number): BrowserEntry {
    if (index < 1 || index > this.browsers.length) {
      throw new Error(
        `Browser index ${index} is out of bounds. Valid range: 1-${this.browsers.length}`,
      );
    }
    return this.browsers[index - 1];
  }

  /**
   * Get the context for a specific browser by index (1-based).
   * If there is only one browser, index MUST be undefined.
   * If there are multiple browsers, index MUST be specified.
   * This method will attempt to connect if not already connected.
   */
  async getContext(index?: number): Promise<McpContext> {
    // Single browser case: index must NOT be specified
    if (this.browsers.length === 1) {
      if (index !== undefined) {
        throw new Error(
          `browserIndex parameter must NOT be specified when only one browser is connected. ` +
            `Remove the browserIndex parameter from your tool call.`,
        );
      }
      return this.ensureConnected(1);
    }

    // Multiple browsers case: index is required
    if (index === undefined) {
      throw new Error(
        `browserIndex parameter is required when multiple browsers are connected. ` +
          `Use list_browsers to see available browsers (1-${this.browsers.length}).`,
      );
    }

    const context = await this.ensureConnected(index);
    const entry = this.get(index);
    logger?.(
      `getContext(${index}) returning context for browser: ${entry.url}`,
    );
    return context;
  }

  /**
   * Get all browser entries.
   */
  getAll(): BrowserEntry[] {
    return [...this.browsers];
  }

  /**
   * Get the number of registered browsers.
   */
  count(): number {
    return this.browsers.length;
  }

  /**
   * Check if the registry is empty.
   */
  isEmpty(): boolean {
    return this.browsers.length === 0;
  }

  /**
   * Check if there are multiple browsers registered.
   */
  hasMultipleBrowsers(): boolean {
    return this.browsers.length > 1;
  }

  /**
   * Tear down a single browser by index while keeping its registry slot (so
   * the 1-based indices of the other browsers stay stable). Browsers we
   * launched are closed; browsers provided externally (browserURL/wsEndpoint)
   * are only disconnected so we never kill a browser the user started. The
   * entry is left in the `disconnected` state and can be brought back with
   * `reconnect_browser` if a start command or launch configuration exists.
   */
  async dispose(index: number, terminate = false): Promise<void> {
    const entry = this.get(index);
    // Tear down context and browser independently so a failure in one does not
    // leak the other, and always reset the slot's state afterwards.
    try {
      entry.context?.dispose();
    } catch (error) {
      logger?.(
        `Error disposing context for browser ${index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (entry.browser?.connected) {
        // terminate=true (explicit close_browser call) or launchOptions (we own
        // the process) → send Browser.close via CDP to terminate the window.
        // Otherwise just disconnect the DevTools session and leave the browser up.
        if (terminate || entry.config.launchOptions) {
          await entry.browser.close();
        } else {
          await entry.browser.disconnect();
        }
      }
    } catch (error) {
      logger?.(
        `Error closing browser ${index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    entry.browser = undefined;
    entry.context = undefined;
    entry.state = 'disconnected';
    entry.lastError = undefined;
    entry.lastAttempt = undefined;
  }

  /**
   * Dispose all browsers and clear the registry.
   */
  async disposeAll(): Promise<void> {
    logger?.(`Disposing ${this.browsers.length} browsers`);
    for (const entry of this.browsers) {
      try {
        if (entry.context) {
          entry.context.dispose();
        }
        if (entry.browser?.connected) {
          await entry.browser.close();
        }
      } catch (error) {
        logger?.(
          `Error disposing browser: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.browsers = [];
  }
}
