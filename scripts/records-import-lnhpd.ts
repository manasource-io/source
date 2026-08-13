#!/usr/bin/env bun

import { resolve } from "node:path";
import { acquireLnhpdSnapshot } from "../src/lnhpd/acquire.ts";
import { indexCorpus } from "../src/lnhpd/corpus.ts";
import { emitLnhpdImport } from "../src/lnhpd/emit.ts";
import { LnhpdImportError } from "../src/lnhpd/format.ts";
import { planLnhpdImport } from "../src/lnhpd/plan.ts";
import { readLnhpdSnapshot } from "../src/lnhpd/read.ts";

/**
 * Imports Health Canada LNHPD dose ranges into this corpus.
 *
 * Acquisition and import are two commands rather than one, because they answer
 * to different things. `acquire` talks to Health Canada and writes a snapshot
 * plus a receipt; `import` reads that snapshot and writes corpus files. Keeping
 * them apart is what makes a re-import reproducible: the same snapshot yields
 * the same bytes on any machine and at any later time, and re-running `import`
 * over the corpus it produced writes nothing.
 *
 *   bun run scripts/records-import-lnhpd.ts acquire <snapshot-dir>
 *   bun run scripts/records-import-lnhpd.ts import <snapshot-dir> [corpus-root]
 *   bun run scripts/records-import-lnhpd.ts plan <snapshot-dir> [corpus-root]
 *
 * `plan` is `import` without the writes: it reports exactly what would change.
 */

function usage(): never {
  console.error(
    "Usage: bun run scripts/records-import-lnhpd.ts <acquire|plan|import> <snapshot-dir> [corpus-root]",
  );
  process.exit(2);
}

const [command, snapshotArgument, rootArgument = "."] = process.argv.slice(2);
if (!command || !snapshotArgument) usage();

const snapshot = resolve(snapshotArgument);
const corpusRoot = resolve(rootArgument);

const report = (message: string): void => {
  console.log(message);
};

try {
  if (command === "acquire") {
    const acquisition = await acquireLnhpdSnapshot({
      directory: snapshot,
      onProgress: report,
    });
    report(`retrieved_at ${acquisition.retrievedAt}`);
    report(`snapshot written to ${snapshot}`);
  } else if (command === "plan" || command === "import") {
    const rows = readLnhpdSnapshot(snapshot);
    report(
      `read ${rows.rows.productlicence.length} productlicence rows and ` +
        `${rows.rows.productdose.length} productdose rows from ${snapshot}`,
    );

    const index = indexCorpus(corpusRoot);
    report(
      `corpus at ${corpusRoot} holds ${index.recordCount} records, ` +
        `${index.byLnhpdId.size} already sourcing LNHPD`,
    );

    const plan = planLnhpdImport({ rows, index });
    report(`batch ${plan.batchId} retrieved_at ${plan.retrievedAt}`);
    report(
      `input ${plan.counts.inputRows} rows ` +
        `(${plan.counts.productRows} product, ${plan.counts.doseRows} dose); ` +
        `resolved ${plan.counts.resolvedLicences} licences; ` +
        `accepted ${plan.counts.accepted} records carrying ${plan.counts.facts} dose_range facts; ` +
        `held ${plan.counts.quarantined} rows`,
    );
    for (const { reason, count } of JSON.parse(
      plan.reports
        .find((file) => file.path.endsWith("-quarantine.json"))!
        .contents,
    ).reasons as { reason: string; count: number }[]) {
      report(`  held ${count} ${reason}`);
    }

    if (command === "plan") {
      report(`would write ${plan.records.length + 1 + plan.reports.length} files`);
    } else {
      const emitted = emitLnhpdImport(corpusRoot, plan);
      report(
        `wrote ${emitted.written.length} file(s), ${emitted.unchanged.length} unchanged`,
      );
      if (emitted.written.length === 0) {
        report("in-place rerun issued no writes");
      }
    }
  } else {
    usage();
  }
} catch (error) {
  if (error instanceof LnhpdImportError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
