/**
 * Write the Nova SFT split. Train and validation share one shuffle seed so
 * regenerating the files does not reshuffle which rows are held out.
 *
 *   npx tsx scripts/build-bedrock-dataset.ts
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { collectFinetuneRecords } from '../src/bedrock-samples';

const VALIDATION_EVERY = 10;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const records = collectFinetuneRecords();
const random = mulberry32(0x1a7a);
for (let i = records.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  const swap = records[i]!;
  records[i] = records[j]!;
  records[j] = swap;
}

const train = records.filter((_, index) => index % VALIDATION_EVERY !== 0);
const validation = records.filter((_, index) => index % VALIDATION_EVERY === 0);

const dir = resolve(__dirname, '..', 'finetune');
mkdirSync(dir, { recursive: true });
const dump = (name: string, rows: typeof records) => {
  const path = resolve(dir, name);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
};

const trainPath = dump('train.jsonl', train);
const validationPath = dump('validation.jsonl', validation);
console.log(
  `records=${records.length} train=${train.length} validation=${validation.length}\n${trainPath}\n${validationPath}`
);
