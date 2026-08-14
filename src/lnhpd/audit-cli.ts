#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { auditLnhpdDoseQuantities } from "./audit.ts";
import { LnhpdImportError } from "./format.ts";
import { readLnhpdSnapshot } from "./read.ts";

/**
 * Runs the fixed-`quantity_dose` audit over an acquired snapshot.
 *
 *   bun run src/lnhpd/audit-cli.ts <snapshot-dir> [corpus-root]
 *
 * The only half of the audit that touches a filesystem, and it touches two
 * paths: the report under `reports/hc-lnhpd/` and the sampled raw rows under
 * `tests/fixtures/lnhpd/`. It writes no record, no manifest and no schema — an
 * audit that could change the corpus it audits would not be one.
 *
 * A file is written only when its bytes would change, so a re-run over the files
 * it produced issues no write at all and a reviewer can check the replay claim
 * with a clean `git status`.
 */

function usage(): never {
  console.error("Usage: bun run src/lnhpd/audit-cli.ts <snapshot-dir> [corpus-root]");
  process.exit(2);
}

const [snapshotArgument, rootArgument = ".", ...extra] = process.argv.slice(2);
if (!snapshotArgument || extra.length > 0) usage();

const snapshot = resolve(snapshotArgument);
const corpusRoot = resolve(rootArgument);

try {
  const rows = readLnhpdSnapshot(snapshot);
  console.log(
    `read ${rows.rows.productdose.length} productdose rows from ${snapshot}`,
  );

  const audit = auditLnhpdDoseQuantities({ rows });
  console.log(`audit ${audit.auditId} retrieved_at ${audit.retrievedAt}`);
  console.log(
    `classified ${audit.counts.doseRows} rows; ` +
      `${audit.counts.candidates} fixed mass/volume candidates; ` +
      `${audit.counts.eligible} eligible for a scalar fact`,
  );

  let written = 0;
  for (const file of audit.files) {
    const path = resolve(corpusRoot, ...file.path.split("/"));
    let existing: string | null = null;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = null;
    }
    if (existing === file.contents) {
      console.log(`  unchanged ${file.path}`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents, "utf8");
    written += 1;
    console.log(`  wrote ${file.path}`);
  }
  if (written === 0) console.log("in-place rerun issued no writes");
} catch (error) {
  if (error instanceof LnhpdImportError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
