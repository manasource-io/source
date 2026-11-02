#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  acquireIngredients,
  acquireSubstances,
  hasDataset,
  writeAcquisition,
} from "../src/families/acquire.ts";
import { FamilyImportError } from "../src/families/format.ts";

/**
 * Builds the family ledger.
 *
 * `acquire` talks to Health Canada and openFDA and writes a transient snapshot plus a
 * receipt. `plan` and `import` read that snapshot, so the same snapshot yields the same
 * bytes, and re-running `import` over its own output writes nothing.
 *
 *   bun run families:import acquire <snapshot-dir> [corpus-root] [--stop-after-minutes <n>]
 *   bun run families:import plan    <snapshot-dir> [corpus-root]
 *   bun run families:import import  <snapshot-dir> [corpus-root]
 */

const argumentsGiven = process.argv.slice(2);
const stopFlag = argumentsGiven.indexOf("--stop-after-minutes");
const stopAfterMinutes =
  stopFlag === -1 ? Number.POSITIVE_INFINITY : Number(argumentsGiven[stopFlag + 1]);
if (stopFlag !== -1) argumentsGiven.splice(stopFlag, 2);
const [command, snapshotArgument, rootArgument = "."] = argumentsGiven;
if (!command || !snapshotArgument) {
  console.error(
    "Usage: bun run families:import <acquire|plan|import> <snapshot-dir> [corpus-root] [--stop-after-minutes <n>]",
  );
  process.exit(2);
}

const snapshot = resolve(snapshotArgument);
const report = (message: string): void => {
  console.log(message);
};

try {
  if (command === "acquire") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(snapshot, { recursive: true });
    if (!hasDataset(snapshot, "substances.jsonl")) {
      writeAcquisition(snapshot, await acquireSubstances(snapshot, { onProgress: report }));
    }
    if (!hasDataset(snapshot, "medicinalingredient.jsonl")) {
      const { readFamilyProducts } = await import("../src/families/import.ts");
      const ids = readFamilyProducts(resolve(rootArgument)).map(({ lnhpdId }) => lnhpdId);
      const acquired = await acquireIngredients(snapshot, ids, {
        stopAfterMs: stopAfterMinutes * 60_000,
        onProgress: report,
      });
      if (!acquired) {
        report("stopped early: run the same command to continue");
        process.exit(0);
      }
      writeAcquisition(snapshot, acquired);
    }
    report(`snapshot written to ${snapshot}`);
  } else {
    const { runFamilyImport } = await import("../src/families/import.ts");
    runFamilyImport({
      snapshot,
      corpusRoot: resolve(rootArgument),
      write: command === "import",
      report,
    });
  }
} catch (error) {
  if (error instanceof FamilyImportError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
