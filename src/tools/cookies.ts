/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Protocol} from '../third_party/index.js';
import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

/**
 * Describes a cookie WITHOUT exposing its value, so cookie values never end up
 * in the model context. The full cookie, including values, is written to the
 * file instead.
 */
function describeCookie(cookie: Protocol.Network.Cookie): string {
  const parts = [`${cookie.name} (domain=${cookie.domain}`];
  if (cookie.path) {
    parts.push(`path=${cookie.path}`);
  }
  if (cookie.expires && cookie.expires > 0) {
    parts.push(`expires=${new Date(cookie.expires * 1000).toISOString()}`);
  } else {
    parts.push('session');
  }
  if (cookie.httpOnly) {
    parts.push('httpOnly');
  }
  if (cookie.secure) {
    parts.push('secure');
  }
  if (cookie.sameSite) {
    parts.push(`sameSite=${cookie.sameSite}`);
  }
  return parts.join(', ') + ')';
}

export const getCookies = definePageTool({
  name: 'get_cookies',
  description: `Gets all cookies stored in the browser's default context and writes them, including their values, to a JSON file. The tool reports only which cookies were found (name, domain, and security metadata); cookie values are never returned inline and only exist in the file.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    filePath: zod
      .string()
      .describe(
        'The absolute or relative path to a .json file to write the cookies (including their values) to.',
      ),
    domain: zod
      .string()
      .optional()
      .describe(
        'Only return cookies whose domain contains this string (case-insensitive). When omitted, returns all cookies.',
      ),
  },
  blockedByDialog: false,
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response, context) => {
    const session = await request.page.pptrPage.createCDPSession();
    let cookies: Protocol.Network.Cookie[];
    try {
      ({cookies} = await session.send('Storage.getCookies'));
    } finally {
      await session.detach().catch(() => undefined);
    }

    const domainFilter = request.params.domain?.toLowerCase();
    if (domainFilter) {
      cookies = cookies.filter(cookie =>
        cookie.domain.toLowerCase().includes(domainFilter),
      );
    }

    const data = new TextEncoder().encode(JSON.stringify(cookies, null, 2));
    const file = await context.saveFile(data, request.params.filePath, '.json');

    if (cookies.length === 0) {
      response.appendResponseLine(`No cookies found. Wrote ${file.filename}.`);
      return;
    }

    response.appendResponseLine(
      `Found ${cookies.length} cookie(s); values written to ${file.filename}.`,
    );
    for (const cookie of cookies) {
      response.appendResponseLine(describeCookie(cookie));
    }
  },
});
