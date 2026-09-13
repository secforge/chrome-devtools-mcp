/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

import {createTempDir} from './utils.js';
import {
  deleteSecrets,
  resolvePlaceholders,
  SECRETS_DIR,
} from '../src/utils/secrets.js';

// Unique per run so the tests never clobber a real secret.
const PREFIX = `cdp-test-${process.pid}-`;
const written: string[] = [];

async function writeSecret(name: string, contents: string): Promise<string> {
  const full = `${PREFIX}${name}`;
  const file = path.join(SECRETS_DIR, full);
  await fs.writeFile(file, contents);
  written.push(file);
  return full;
}

describe('secrets', () => {
  before(async () => {
    await fs.mkdir(SECRETS_DIR, {recursive: true});
  });

  after(async () => {
    for (const file of written) {
      await fs.rm(file, {force: true});
    }
  });

  describe('resolvePlaceholders', () => {
    it('returns text without placeholders unchanged', async () => {
      const result = await resolvePlaceholders('just a value');
      assert.strictEqual(result.value, 'just a value');
      assert.deepStrictEqual(result.names, []);
    });

    it('substitutes a secret and strips the trailing newline', async () => {
      const name = await writeSecret('pw', 'hunter2\n');
      const result = await resolvePlaceholders(`{{secret:${name}}}`);
      assert.strictEqual(result.value, 'hunter2');
      assert.deepStrictEqual(result.names, [name]);
      assert.deepStrictEqual(result.consume, [name]);
    });

    it('keeps the trailing newline with :raw', async () => {
      const name = await writeSecret('raw', 'hunter2\n');
      const result = await resolvePlaceholders(`{{secret:${name}:raw}}`);
      assert.strictEqual(result.value, 'hunter2\n');
    });

    it('substitutes inside surrounding text and repeats', async () => {
      const name = await writeSecret('tok', 'abc');
      const result = await resolvePlaceholders(
        `Bearer {{secret:${name}}} and {{secret:${name}}}`,
      );
      assert.strictEqual(result.value, 'Bearer abc and abc');
      assert.deepStrictEqual(result.names, [name]);
    });

    it('marks a :keep secret as not to be consumed', async () => {
      const name = await writeSecret('kept', 'v\n');
      const result = await resolvePlaceholders(`{{secret:${name}:keep}}`);
      assert.strictEqual(result.value, 'v');
      assert.deepStrictEqual(result.names, [name]);
      assert.deepStrictEqual(result.consume, []);
    });

    it('supports :raw:keep together', async () => {
      const name = await writeSecret('rawkept', 'v\n');
      const result = await resolvePlaceholders(`{{secret:${name}:raw:keep}}`);
      assert.strictEqual(result.value, 'v\n');
      assert.deepStrictEqual(result.consume, []);
    });

    it('consumes when the same secret is also used without :keep', async () => {
      const name = await writeSecret('mixed', 'v');
      const result = await resolvePlaceholders(
        `{{secret:${name}:keep}} {{secret:${name}}}`,
      );
      assert.strictEqual(result.value, 'v v');
      assert.deepStrictEqual(result.consume, [name]);
    });

    it('rejects an unknown modifier', async () => {
      const name = await writeSecret('badmod', 'v');
      await assert.rejects(
        () => resolvePlaceholders(`{{secret:${name}:nope}}`),
        /Unknown modifier ":nope"/,
      );
    });

    it('rejects a name that escapes the secrets dir', async () => {
      await assert.rejects(
        () => resolvePlaceholders('{{secret:../../etc/passwd}}'),
        /Invalid secret name/,
      );
    });

    it('reports a missing secret clearly', async () => {
      await assert.rejects(
        () => resolvePlaceholders(`{{secret:${PREFIX}nope}}`),
        /No secret named/,
      );
    });
  });

  describe('deleteSecrets', () => {
    it('removes the file and tolerates a missing one', async () => {
      const name = await writeSecret('temp', 'x');
      await deleteSecrets([name]);
      await assert.rejects(() => fs.access(path.join(SECRETS_DIR, name)));
      // Second delete must not throw.
      await deleteSecrets([name]);
    });
  });
});

describe('secrets in a script loaded from sourcePath', () => {
  it('resolves placeholders after the file is read', async () => {
    // evaluate_script reads sourcePath first, then resolves placeholders on
    // the result, so a stored script may carry a credential.
    using dir = createTempDir('cdp-src-');
    const scriptFile = path.join(dir.path, 'login.js');
    const secretName = `cdp-test-${process.pid}-fromsource`;
    await fs.mkdir(SECRETS_DIR, {recursive: true});
    await fs.writeFile(path.join(SECRETS_DIR, secretName), 'tok-abc\n');
    await fs.writeFile(scriptFile, `() => login("{{secret:${secretName}}}")`);

    // This mirrors what the tool does: read the file, then resolve.
    const fileContents = await fs.readFile(scriptFile, 'utf8');
    const resolved = await resolvePlaceholders(fileContents);

    assert.strictEqual(resolved.value, '() => login("tok-abc")');
    assert.deepStrictEqual(resolved.consume, [secretName]);

    await fs.rm(path.join(SECRETS_DIR, secretName), {force: true});
  });
});
