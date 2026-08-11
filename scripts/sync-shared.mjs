#!/usr/bin/env node
/**
 * Copy shared/ into the Angular app's models folder.
 *
 * The Angular build cannot reach outside src/, so the frontend consumes a
 * mirror of shared/ rather than importing it. Run `npm run shared:sync` after
 * touching anything in shared/, and `npm run shared:check` to prove the two
 * copies still agree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'frontend/dotrace-app/src/app/core/models');
const files = ['ws-types.ts', 'tracks.ts', 'bot-ai.ts'];

const check = process.argv.includes('--check');
const stale = [];

for (const file of files) {
  const from = join(root, 'shared', file);
  const to = join(target, file);
  const source = readFileSync(from, 'utf8');
  const mirror = (() => {
    try {
      return readFileSync(to, 'utf8');
    } catch {
      return null;
    }
  })();

  if (source === mirror) continue;
  if (check) {
    stale.push(file);
    continue;
  }
  writeFileSync(to, source);
  console.log(`synced shared/${file}`);
}

if (stale.length > 0) {
  console.error(
    `Frontend mirror is out of date: ${stale.join(', ')}\n` +
      'Run `npm run shared:sync` and commit the result.'
  );
  process.exit(1);
}

if (check) console.log('Frontend mirror matches shared/.');
