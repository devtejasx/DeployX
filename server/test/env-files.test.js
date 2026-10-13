// The example environment files are copied to .env and read by Docker
// Compose, which refuses the whole file on one malformed line. Every line must
// be blank, a comment, or KEY=value, and no key may appear twice.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('example environment files', () => {
  for (const name of ['.env.example', '.env.production.example']) {
    test(`${name} is valid for Docker Compose`, () => {
      const lines = fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/);
      const keys = new Set();
      lines.forEach((line, index) => {
        if (/^\s*(#.*)?$/.test(line)) return;
        const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
        assert.ok(match, `${name}:${index + 1} is neither a comment nor KEY=value: ${JSON.stringify(line.slice(0, 60))}`);
        assert.ok(!keys.has(match[1]), `${name}:${index + 1} sets ${match[1]} a second time`);
        keys.add(match[1]);
      });
      assert.ok(keys.size > 10, `${name} defines only ${keys.size} variables`);
    });
  }
});
