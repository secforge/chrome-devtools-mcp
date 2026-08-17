/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {getCookies} from '../../src/tools/cookies.js';
import {serverHooks} from '../server.js';
import {getTextContent, html, withMcpContext} from '../utils.js';

describe('cookies', () => {
  const server = serverHooks();

  afterEach(() => {
    sinon.restore();
  });

  describe('get_cookies', () => {
    it('writes cookie values to the file but not the response', async () => {
      server.addHtmlRoute('/', html`<main>Cookie page</main>`);
      const filePath = 'cookies.json';

      await withMcpContext(async (response, context) => {
        const saveFileStub = sinon
          .stub(context, 'saveFile')
          .resolves({filename: filePath});

        const page = context.getSelectedMcpPage().pptrPage;
        await page.goto(server.getRoute('/'));
        await page.evaluate(() => {
          document.cookie = 'testcookie=testvalue';
        });

        await getCookies.handler(
          {params: {filePath}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        // The value must be written to the file...
        sinon.assert.calledOnce(saveFileStub);
        const [savedData, savedPath] = saveFileStub.firstCall.args;
        assert.strictEqual(savedPath, filePath);
        const savedText = new TextDecoder().decode(savedData);
        assert.match(savedText, /testvalue/);

        // ...but the value must never appear in the response context.
        const responseData = await response.handle(context);
        const text = getTextContent(responseData.content[0]);
        assert.match(text, /testcookie/); // name is reported
        assert.doesNotMatch(text, /testvalue/); // value is not
        assert.match(text, new RegExp(filePath));
      });
    });

    it('filters cookies by domain', async () => {
      server.addHtmlRoute('/', html`<main>Cookie page</main>`);
      const filePath = 'cookies.json';

      await withMcpContext(async (response, context) => {
        sinon.stub(context, 'saveFile').resolves({filename: filePath});

        const page = context.getSelectedMcpPage().pptrPage;
        await page.goto(server.getRoute('/'));
        await page.evaluate(() => {
          document.cookie = 'testcookie=testvalue';
        });

        await getCookies.handler(
          {
            params: {filePath, domain: 'no-such-domain.example'},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const responseData = await response.handle(context);
        const text = getTextContent(responseData.content[0]);
        assert.match(text, /No cookies found/);
      });
    });
  });
});
