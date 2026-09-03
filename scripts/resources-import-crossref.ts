#!/usr/bin/env bun

import { resolve } from "node:path";
import { acquireCrossrefReferences } from "../src/crossref/acquire.ts";
import { emitCrossrefImport } from "../src/crossref/emit.ts";
import { CrossrefImportError } from "../src/crossref/format.ts";
import { planCrossrefImport } from "../src/crossref/plan.ts";
import { readCrossrefSnapshot, readTargetResources } from "../src/crossref/read.ts";

/**
 * Enriches curated resource references with the bibliographic identity of the
 * works they cite: DOI, ordered author names, and container title, from the
 * exact Crossref works records their PubMed Central identifiers resolve to.
 *
 * Acquisition and import are two commands rather than one, because they
 * answer to different things. `acquire` talks to the NCBI PMC ID Converter
 * and the Crossref REST API — only the endpoints the named references need,
 * with no authentication — and writes a snapshot plus a receipt; `import`
 * reads that snapshot and writes corpus files. The same snapshot yields the
 * same bytes on any machine and at any later time, and re-running `import`
 * over the corpus it produced writes nothing.
 *
 *   bun run scripts/resources-import-crossref.ts acquire <snapshot-dir> <resource-path> [...]
 *   bun run scripts/resources-import-crossref.ts plan    <snapshot-dir> [corpus-root]
 *   bun run scripts/resources-import-crossref.ts import  <snapshot-dir> [corpus-root]
 *
 * `plan` is `import` without the writes: it reports exactly what would change.
 */

function usage(): never {
  console.error(
    "Usage: bun run scripts/resources-import-crossref.ts acquire <snapshot-dir> <resource-path> [...]\n" +
      "       bun run scripts/resources-import-crossref.ts <plan|import> <snapshot-dir> [corpus-root]",
  );
  process.exit(2);
}

const [command, snapshotArgument, ...rest] = process.argv.slice(2);
if (!command || !snapshotArgument) usage();

const snapshot = resolve(snapshotArgument);

const report = (message: string): void => {
  console.log(message);
};

try {
  if (command === "acquire") {
    if (rest.length === 0) usage();
    const acquisition = await acquireCrossrefReferences({
      directory: snapshot,
      corpusRoot: ".",
      resourcePaths: rest,
      onProgress: report,
    });
    report(
      `acquired ${acquisition.requests.length} response(s) for ` +
        `${acquisition.targets.length} reference(s)`,
    );
    report(`retrieved_at ${acquisition.retrievedAt}`);
    report(`snapshot written to ${snapshot}`);
  } else if (command === "plan" || command === "import") {
    if (rest.length > 1) usage();
    const corpusRoot = resolve(rest[0] ?? ".");
    const parsed = readCrossrefSnapshot(snapshot);
    report(
      `read ${parsed.works.size} verified work(s) for ` +
        `${parsed.acquisition.targets.length} target reference(s) from ${snapshot}`,
    );

    const resources = readTargetResources(
      corpusRoot,
      parsed.acquisition.targets.map((target) => target.resourcePath),
    );
    const plan = planCrossrefImport({ snapshot: parsed, resources });
    report(`batch ${plan.batchId} retrieved_at ${plan.retrievedAt}`);
    report(
      `enriching ${plan.counts.references} reference(s) across ` +
        `${plan.counts.resources} resource(s)`,
    );
    for (const reference of plan.references) {
      report(
        `  ${reference.resourcePath} '${reference.referenceId}' -> DOI ${reference.doi}`,
      );
    }

    if (command === "plan") {
      report(
        `would write ${plan.resources.length + 1 + plan.reports.length} file(s)`,
      );
    } else {
      const emitted = emitCrossrefImport(corpusRoot, plan);
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
  if (error instanceof CrossrefImportError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
