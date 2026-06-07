/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {buildServerInstructions} from '../src/server-instructions.js';

describe('buildServerInstructions', () => {
  it('never uses conditional "in X-browser mode" phrasing', () => {
    const single = buildServerInstructions([
      {url: 'launched', hasStartCommand: false},
    ]);
    const multi = buildServerInstructions([
      {url: 'http://a', hasStartCommand: false},
      {url: 'http://b', hasStartCommand: false},
    ]);
    assert.doesNotMatch(single, /in (single|multi)-browser mode/i);
    assert.doesNotMatch(multi, /in (single|multi)-browser mode/i);
  });

  describe('single browser', () => {
    it('tells the AI not to pass a browserIndex', () => {
      const text = buildServerInstructions([
        {url: 'launched', hasStartCommand: false},
      ]);
      assert.match(text, /Do not pass a `browserIndex`/);
      assert.doesNotMatch(text, /\[1\]/); // no per-browser index listing
    });

    it('mentions the core snapshot-driven workflow', () => {
      const text = buildServerInstructions([
        {url: 'launched', hasStartCommand: false},
      ]);
      assert.match(text, /take_snapshot/);
      assert.match(text, /list_pages/);
    });

    it('says the browser must already be running when no start command is configured', () => {
      const text = buildServerInstructions([
        {url: 'launched', hasStartCommand: false},
      ]);
      assert.match(text, /reconnect_browser/);
      assert.match(text, /must already be running/);
    });

    it('says the browser can be (re)started when a start command is configured', () => {
      const text = buildServerInstructions([
        {url: 'http://localhost:9222', hasStartCommand: true},
      ]);
      assert.match(text, /reconnect_browser/);
      assert.match(text, /can be \(re\)started/);
      assert.doesNotMatch(text, /must already be running/);
    });
  });

  describe('multiple browsers', () => {
    const browsers = [
      {url: 'http://a', hasStartCommand: true},
      {url: 'http://b', hasStartCommand: false},
      {url: 'ws://c', hasStartCommand: true},
    ];

    it('requires a browserIndex and states the valid range', () => {
      const text = buildServerInstructions(browsers);
      assert.match(text, /browserIndex/);
      assert.match(text, /1 to 3/);
      assert.doesNotMatch(text, /Do not pass a `browserIndex`/);
    });

    it('enumerates every browser with its index and url', () => {
      const text = buildServerInstructions(browsers);
      assert.match(text, /\[1\] http:\/\/a/);
      assert.match(text, /\[2\] http:\/\/b/);
      assert.match(text, /\[3\] ws:\/\/c/);
    });

    it('marks per-browser whether it can be (re)started or must already be running', () => {
      const text = buildServerInstructions(browsers);
      const lines = text.split('\n');
      const line1 = lines.find(l => l.includes('[1]'))!;
      const line2 = lines.find(l => l.includes('[2]'))!;
      const line3 = lines.find(l => l.includes('[3]'))!;
      assert.match(line1, /can be \(re\)started/);
      assert.match(line2, /must already be running/);
      assert.match(line3, /can be \(re\)started/);
    });

    it('points to list_browsers for live state and open pages', () => {
      const text = buildServerInstructions(browsers);
      assert.match(text, /list_browsers/);
    });
  });

  it('returns a non-empty introduction even with no browsers configured', () => {
    const text = buildServerInstructions([]);
    assert.ok(text.trim().length > 0);
  });
});
