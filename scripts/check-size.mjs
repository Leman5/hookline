#!/usr/bin/env node
// Fails the build when the gzipped JS bundle grows past the budget.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET = 40 * 1024;
const dir = 'dist/assets';
let total = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const gz = gzipSync(readFileSync(join(dir, f))).length;
  total += gz;
  console.log(`${f.padEnd(40)} ${(gz / 1024).toFixed(1)} KB gz`);
}
console.log(`total JS: ${(total / 1024).toFixed(1)} KB gz (budget ${BUDGET / 1024} KB)`);
if (total > BUDGET) process.exit(1);
