import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { formatYaml } from "../corpus.ts";
import { readIngredients, readSubstances } from "./acquire.ts";
import type { FamilyAcquisition } from "./acquire.ts";
import { planFamilyEdges } from "./edges.ts";
import type { FamilyRecord, FamilyReport, Overrides, ProductRecord } from "./edges.ts";
import {
  EDGES_FILE,
  FAMILIES_DIRECTORY,
  FAMILY_IMPORTER_VERSION,
  FAMILY_SOURCE_NAME,
  FamilyImportError,
  OVERRIDES_FILE,
  REPORT_FILE,
  edgeLine,
} from "./format.ts";
import type { FamilyEdge } from "./format.ts";
import { RECORD_ORDER } from "./resolve.ts";

/** What the ledger reads from a corpus: names, aliases, UNIIs and LNHPD ids. */
type RawRecord = {
  id: string;
  canonical_name: string;
  facts?: { kind: string; value?: string }[];
  identifiers?: { kind: string; value: string }[];
  sources?: { namespace: string; source_record_id: string }[];
};

const LICENSES: Record<string, string> = {
  "hc.lnhpd.medicinalingredient":
    "Open Government Licence – Canada (OGL-Canada-2.0)",
  "fda.openfda.substance": "CC0 1.0",
};

const NOTICE =
  "Derived from Health Canada's Licensed Natural Health Products Database, which " +
  "contains information licensed under the Open Government Licence – Canada, and " +
  "from openFDA substance data. The information was modified: ingredient names are " +
  "resolved to corpus records and grouped by a closed rule. No endorsement is implied. " +
  "A family is a view over records and states nothing about evidence.";

const walkYaml = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
    : [];

const readRecord = (path: string): RawRecord =>
  parse(readFileSync(path, "utf8")) as RawRecord;

export const readFamilyRecords = (root: string): FamilyRecord[] =>
  ["compound", "supplement_ingredient", "food"].flatMap((type) =>
    walkYaml(resolve(root, "records", type)).map((path) => {
      const record = readRecord(path);
      return {
        id: record.id,
        order: RECORD_ORDER[type] ?? 9,
        name: record.canonical_name,
        aliases: (record.facts ?? []).flatMap((fact) =>
          fact.kind === "alias" && fact.value ? [fact.value] : [],
        ),
        unii:
          record.identifiers?.find(({ kind }) => kind === "unii")?.value ?? null,
      };
    }),
  );

export const readFamilyProducts = (root: string): ProductRecord[] =>
  walkYaml(resolve(root, "records", "supplement_product")).flatMap((path) => {
    const record = readRecord(path);
    const lnhpd = record.sources?.find(
      ({ namespace }) => namespace === "hc.lnhpd",
    );
    return lnhpd
      ? [{ id: record.id, lnhpdId: lnhpd.source_record_id, name: record.canonical_name }]
      : [];
  });

export const readOverrides = (root: string): Overrides => {
  const path = resolve(root, FAMILIES_DIRECTORY, OVERRIDES_FILE);
  const empty: Overrides = { forms: [], rejected: [], aliases: [], display: [] };
  if (!existsSync(path)) return empty;
  return { ...empty, ...(parse(readFileSync(path, "utf8")) as Partial<Overrides>) };
};

const hashOf = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);

const manifestFor = (
  acquisition: FamilyAcquisition,
  batchId: string,
  report: FamilyReport,
): Record<string, unknown> => ({
  attribution: "Manasource families",
  batch_id: batchId,
  counts: report.counts,
  importer_version: FAMILY_IMPORTER_VERSION,
  kind: "family_manifest",
  notice: NOTICE,
  schema_version: 1,
  source: FAMILY_SOURCE_NAME,
  source_namespace: "manasource.families",
  upstream: acquisition.datasets.map((dataset) => ({
    bytes: dataset.bytes,
    dataset: dataset.dataset,
    license: LICENSES[dataset.dataset] ?? "See NOTICE",
    retrieved_at: dataset.retrieved_at,
    rows: dataset.rows,
    sha256: dataset.sha256,
    url: dataset.url,
  })),
});

type Written = { path: string; text: string };

export type FamilyPlan = {
  edges: FamilyEdge[];
  report: FamilyReport;
  batchId: string;
  files: Written[];
};

export const planFamilyImport = (snapshot: string, root: string): FamilyPlan => {
  const acquisitionPath = resolve(snapshot, "acquisition.json");
  if (!existsSync(acquisitionPath)) {
    throw new FamilyImportError(`${snapshot} holds no acquisition receipt.`);
  }
  const acquisition = JSON.parse(
    readFileSync(acquisitionPath, "utf8"),
  ) as FamilyAcquisition;

  const { edges, report } = planFamilyEdges({
    records: readFamilyRecords(root),
    products: readFamilyProducts(root),
    ingredients: readIngredients(snapshot),
    substances: readSubstances(snapshot),
    overrides: readOverrides(root),
  });

  const edgesText = `${edges.map(edgeLine).join("\n")}\n`;
  const batchId = `${FAMILY_SOURCE_NAME}-${hashOf(
    edgesText,
    ...acquisition.datasets.map(({ sha256 }) => sha256),
  )}`;

  return {
    edges,
    report,
    batchId,
    files: [
      { path: join(FAMILIES_DIRECTORY, EDGES_FILE), text: edgesText },
      {
        path: join(FAMILIES_DIRECTORY, REPORT_FILE),
        text: `${JSON.stringify(report, null, 2)}\n`,
      },
      {
        path: join("manifests", FAMILY_SOURCE_NAME, `${batchId}.yaml`),
        text: formatYaml(manifestFor(acquisition, batchId, report)),
      },
    ],
  };
};

/**
 * Writes the plan. The ledger is one file, so one manifest describes it, and a batch
 * that replaces it takes the old manifest with it. Re-running over its own output
 * writes nothing.
 */
export const emitFamilyImport = (root: string, plan: FamilyPlan): string[] => {
  const written: string[] = [];
  for (const { path, text } of plan.files) {
    const target = resolve(root, path);
    if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    written.push(path);
  }
  const manifests = resolve(root, "manifests", FAMILY_SOURCE_NAME);
  for (const name of readdirSync(manifests)) {
    if (name !== `${plan.batchId}.yaml`) {
      rmSync(join(manifests, name));
      written.push(join("manifests", FAMILY_SOURCE_NAME, name));
    }
  }
  return written;
};

export const runFamilyImport = ({
  snapshot,
  corpusRoot,
  write,
  report,
}: {
  snapshot: string;
  corpusRoot: string;
  write: boolean;
  report: (message: string) => void;
}): void => {
  const plan = planFamilyImport(snapshot, corpusRoot);
  const { counts, coverage } = plan.report;
  report(`batch ${plan.batchId}`);
  report(
    `${counts.edges} edges over ${counts.bases} bases: ${counts.forms} forms, ` +
      `${counts.products} products, ${counts.combinations} combination lines`,
  );
  report(
    `products with a base: ${coverage.productsWithBase} of ${coverage.products} ` +
      `(${(coverage.productShare * 100).toFixed(1)}%)`,
  );
  report(
    `ingredient names resolved: ${coverage.ingredientNamesResolved} of ` +
      `${coverage.ingredientNames} (${(coverage.ingredientNameShare * 100).toFixed(1)}%)`,
  );
  if (write) {
    const written = emitFamilyImport(corpusRoot, plan);
    report(
      written.length === 0
        ? "in-place rerun issued no writes"
        : `wrote ${written.length} file(s)`,
    );
  }
};
