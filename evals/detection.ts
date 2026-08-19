/**
 * Offline evaluation of the detection step against a labelled golden set.
 * Runs against whichever provider is configured; `SEROS_PROVIDER=fake` for the
 * deterministic baseline, otherwise local Qwen. Never touches a live vendor API.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { complete, DetectionSchema } from '../src/provider/index';

type Row = { text: string; label: boolean };
const rows: Row[] = JSON.parse(readFileSync(join(__dirname, 'golden.json'), 'utf-8'));
const THRESHOLD = Number(process.env.SEROS_DETECT_THRESHOLD || 55);
const SYSTEM =
  'You decide whether a chat message contains a commitment: something a person undertook to do. ' +
  'Reply ONLY with JSON: {"isCommitment":boolean,"confidence":0-100,"reason":string}. ' +
  'A question, an opinion or praise is not a commitment.';

async function main() {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  const wrong: string[] = [];
  let provider = '';
  const t0 = Date.now();

  for (const r of rows) {
    const out = await complete({ tier: 'cheap', purpose: 'detect', system: SYSTEM, user: r.text }, DetectionSchema);
    provider = out.provider;
    const predicted = out.value.isCommitment && out.value.confidence >= THRESHOLD;
    if (predicted && r.label) tp++;
    else if (predicted && !r.label) { fp++; wrong.push(`FP  ${r.text}`); }
    else if (!predicted && r.label) { fn++; wrong.push(`FN  ${r.text}`); }
    else tn++;
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  console.log('');
  console.log(`  provider      ${provider}`);
  console.log(`  threshold     ${THRESHOLD}`);
  console.log(`  examples      ${rows.length}   (${rows.filter(r => r.label).length} positive)`);
  console.log(`  elapsed       ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('  ----------------------------------------');
  console.log(`  true pos      ${tp}`);
  console.log(`  false pos     ${fp}      <- precision is the one that matters`);
  console.log(`  false neg     ${fn}`);
  console.log(`  true neg      ${tn}`);
  console.log('  ----------------------------------------');
  console.log(`  precision     ${(precision * 100).toFixed(1)}%`);
  console.log(`  recall        ${(recall * 100).toFixed(1)}%`);
  console.log(`  f1            ${(f1 * 100).toFixed(1)}%`);
  if (wrong.length) { console.log(''); for (const w of wrong) console.log('  ' + w); }
  console.log('');
}
main();
