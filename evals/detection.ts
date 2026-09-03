/**
 * Offline evaluation of the detection step against a labelled golden set.
 * Runs against whichever provider is configured; `SEROS_PROVIDER=fake` for the
 * deterministic baseline, otherwise local Qwen. Never touches a live vendor API.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { complete, dbMeterContext, DetectionSchema } from '../src/provider/index';
import { migrateDbAsync, openDb } from '../src/db/client';
import { WorkspaceScope } from '../src/db/scope';

type Row = { text: string; label: boolean };
const rows: Row[] = JSON.parse(readFileSync(join(__dirname, 'golden.json'), 'utf-8'));
const THRESHOLD = Number(process.env.SEROS_DETECT_THRESHOLD || 55);
import { DETECT_SYSTEM as SYSTEM } from '../src/prompts';

async function main() {
  let provider = '';
  const t0 = Date.now();

  // One pass over the corpus, then score it at every threshold. The model is the
  // expensive part; the threshold is free, and choosing it is the whole point.
  await migrateDbAsync();
  const db = openDb();
  await WorkspaceScope.ensure(db, 'eval', 'Evaluation harness');   // budgets default to unlimited
  const meter = dbMeterContext(db, 'eval');

  const preds: { label: boolean; said: boolean; conf: number; text: string }[] = [];
  for (const r of rows) {
    const out = await complete(meter, { tier: 'cheap', purpose: 'detect', system: SYSTEM, user: r.text }, DetectionSchema);
    if (!out.ok || out.value === null) { console.error(`  provider unavailable: ${out.outcome}`); process.exit(1); }
    provider = out.provider;
    preds.push({ label: r.label, said: out.value!.isCommitment, conf: out.value!.confidence, text: r.text });
  }

  const score = (t: number) => {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const p of preds) {
      const yes = p.said && p.conf >= t;
      if (yes && p.label) tp++; else if (yes && !p.label) fp++;
      else if (!yes && p.label) fn++; else tn++;
    }
    const pr = tp + fp === 0 ? 1 : tp / (tp + fp);
    const rc = tp + fn === 0 ? 1 : tp / (tp + fn);
    return { tp, fp, tn, fn, pr, rc, f1: pr + rc === 0 ? 0 : (2 * pr * rc) / (pr + rc) };
  };

  console.log('');
  console.log('  threshold sweep');
  console.log('  thresh   precision   recall      f1     false pos');
  for (const t of [50, 55, 60, 65, 70, 75, 80, 85, 90, 95]) {
    const s = score(t);
    console.log(`  ${String(t).padStart(5)}   ${(s.pr * 100).toFixed(1).padStart(8)}%  ${(s.rc * 100).toFixed(1).padStart(6)}%  ${(s.f1 * 100).toFixed(1).padStart(6)}%  ${String(s.fp).padStart(9)}`);
  }

  const at = score(THRESHOLD);
  const tp = at.tp, fp = at.fp, tn = at.tn, fn = at.fn;
  const wrong = preds.filter((p) => (p.said && p.conf >= THRESHOLD) !== p.label)
    .map((p) => `${p.label ? 'FN' : 'FP'}  [${p.conf}] ${p.text}`);

  const precision = at.pr, recall = at.rc, f1 = at.f1;

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
  // M14: the corpus is synthetic, but printing it by default is still a habit worth
  // not having, since the same harness will one day be pointed at a consented corpus.
  if (wrong.length) {
    if (process.env.SEROS_EVAL_SHOW_TEXT === '1') {
      console.log(''); for (const w of wrong) console.log('  ' + w);
    } else {
      console.log(`\n  ${wrong.length} misclassified. Re-run with SEROS_EVAL_SHOW_TEXT=1 to see them.`);
    }
  }
  console.log('');
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
