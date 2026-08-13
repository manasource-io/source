import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  LNHPD_COLUMNS,
  LNHPD_DATASETS,
  LnhpdImportError,
  isLnhpdDataset,
} from "./format.ts";
import type { LnhpdDataset } from "./format.ts";

/**
 * The strict half of the LNHPD contract: an acquired snapshot in, one indexed
 * row set out, or nothing at all.
 *
 * **Shape is contract; value is content.** Those are two different failures and
 * they leave by two different doors. A snapshot that is not this shape — a
 * missing dataset, a body that is not a JSON array, an unknown column, a column
 * holding the wrong JSON type — means Health Canada's feed and this importer
 * disagree about what the data *is*, so the whole batch is refused here and
 * nothing is written. A column holding a value that is merely wrong — a blank
 * licence number, a dose in capsules — is content, and `identity.ts` quarantines
 * that row while the rest of the batch proceeds.
 *
 * **A batch must wholly hold what it claims.** The bulk endpoints publish a
 * plain JSON array with no pagination block, so wholeness is proven on the
 * transfer rather than on a page count. Three independent things have to agree
 * before a row is read:
 *
 * - the acquisition receipt records the `content-length` the response declared
 *   and the bytes actually written, and they must be equal;
 * - the file on disk must still be exactly that many bytes and still digest to
 *   the SHA-256 the receipt recorded, so an edited or re-fetched snapshot cannot
 *   be imported under the old receipt's provenance;
 * - and the body must parse as a JSON array, which a truncated download cannot
 *   do — a short read of `productdose` ends mid-object.
 *
 * That is what makes a fragment structurally unimportable: there is no way to
 * hand this importer 100 of 207,190 dose rows and have it write a manifest
 * describing them as the dataset.
 */

/** The receipt `acquire.ts` writes beside a snapshot, and this module trusts. */
export const LNHPD_ACQUISITION_CONTRACT = "manasource/lnhpd-acquisition/1";

export type LnhpdAcquiredDataset = {
  dataset: LnhpdDataset;
  /** The exact URL requested, recorded so a reader can repeat the download. */
  url: string;
  file: string;
  httpStatus: number;
  /** The `content-length` the response declared. */
  declaredBytes: number;
  /** The bytes actually written to disk. Must equal `declaredBytes`. */
  observedBytes: number;
  sha256: string;
  rowCount: number;
  /** The response's own `date` header: when Health Canada served these bytes. */
  servedAt: string;
};

export type LnhpdAcquisition = {
  contract: string;
  /**
   * The instant this batch is published as having been retrieved. Taken from
   * the acquisition rather than from a clock at import time, so re-importing one
   * snapshot emits identical bytes however long afterwards it runs.
   */
  retrievedAt: string;
  datasets: LnhpdAcquiredDataset[];
};

/** A row of either dataset, tagged with where in the batch it came from. */
export type LnhpdInputRow = {
  dataset: LnhpdDataset;
  /** Position across this dataset, in row order. */
  index: number;
  /** The declared columns, already proven to be of the declared JSON types. */
  columns: Record<string, string | number | null>;
};

export type LnhpdRowSet = {
  rows: Record<LnhpdDataset, LnhpdInputRow[]>;
  acquisition: LnhpdAcquisition;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  const kind = typeof value;
  return `${kind === "object" ? "an" : "a"} ${kind}`;
};

const refuse = (message: string): never => {
  throw new LnhpdImportError(
    `${message} This importer reads an acquisition snapshot declaring contract ` +
      `'${LNHPD_ACQUISITION_CONTRACT}', carrying one whole bulk download per ` +
      `dataset (${LNHPD_DATASETS.join(", ")}) whose rows carry exactly the ` +
      `columns Health Canada was observed to publish. A dataset that has gained, ` +
      `lost or renamed a column fails the batch closed rather than being read as ` +
      `though the change had not happened.`,
  );
};

const requireString = (
  raw: Record<string, unknown>,
  key: string,
  at: string,
): string => {
  const value = raw[key];
  if (typeof value !== "string" || value === "") {
    refuse(`${at}.${key} is ${describe(value)}, not a non-empty string.`);
  }
  return value as string;
};

const requireInteger = (
  raw: Record<string, unknown>,
  key: string,
  at: string,
  minimum: number,
): number => {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    refuse(`${at}.${key} is ${describe(value)}, not an integer.`);
  }
  if ((value as number) < minimum) {
    refuse(`${at}.${key} is ${String(value)}, below the minimum ${minimum}.`);
  }
  return value as number;
};

export const parseAcquisition = (text: string, at: string): LnhpdAcquisition => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    refuse(`${at} is not valid JSON: ${(error as Error).message}.`);
  }
  if (!isPlainObject(parsed)) {
    refuse(`${at} is ${describe(parsed)}, not a mapping.`);
  }

  const raw = parsed as Record<string, unknown>;
  if (raw.contract !== LNHPD_ACQUISITION_CONTRACT) {
    refuse(`${at} declares contract ${JSON.stringify(raw.contract) ?? "nothing"}.`);
  }

  const retrievedAt = requireString(raw, "retrievedAt", at);
  if (Number.isNaN(Date.parse(retrievedAt))) {
    refuse(`${at}.retrievedAt '${retrievedAt}' is not a parseable instant.`);
  }

  if (!Array.isArray(raw.datasets)) {
    refuse(`${at}.datasets is ${describe(raw.datasets)}, not a list.`);
  }

  const datasets: LnhpdAcquiredDataset[] = [];
  for (const [position, entry] of (raw.datasets as unknown[]).entries()) {
    const where = `${at}.datasets[${position}]`;
    if (!isPlainObject(entry)) {
      refuse(`${where} is ${describe(entry)}, not a mapping.`);
    }
    const item = entry as Record<string, unknown>;
    const dataset = requireString(item, "dataset", where);
    if (!isLnhpdDataset(dataset)) {
      refuse(
        `${where}.dataset '${dataset}' is not one of ${LNHPD_DATASETS.join(", ")}.`,
      );
    }
    const httpStatus = requireInteger(item, "httpStatus", where, 100);
    if (httpStatus !== 200) {
      refuse(
        `${where} records HTTP ${httpStatus}. Only a 200 carries a complete body.`,
      );
    }
    const declaredBytes = requireInteger(item, "declaredBytes", where, 1);
    const observedBytes = requireInteger(item, "observedBytes", where, 1);
    if (declaredBytes !== observedBytes) {
      refuse(
        `${where} wrote ${observedBytes} bytes for a response declaring ` +
          `content-length ${declaredBytes}, so the download is a fragment.`,
      );
    }
    datasets.push({
      dataset: dataset as LnhpdDataset,
      url: requireString(item, "url", where),
      file: requireString(item, "file", where),
      httpStatus,
      declaredBytes,
      observedBytes,
      sha256: requireString(item, "sha256", where),
      rowCount: requireInteger(item, "rowCount", where, 1),
      servedAt: requireString(item, "servedAt", where),
    });
  }

  for (const dataset of LNHPD_DATASETS) {
    const held = datasets.filter((entry) => entry.dataset === dataset);
    if (held.length === 0) {
      refuse(`${at} carries no '${dataset}' download.`);
    }
    if (held.length > 1) {
      refuse(
        `${at} carries ${held.length} '${dataset}' downloads, so which one the ` +
          `batch read would depend on ordering.`,
      );
    }
  }

  return { contract: LNHPD_ACQUISITION_CONTRACT, retrievedAt, datasets };
};

/**
 * One row's declared columns, proven to be strings, numbers or null.
 *
 * Column keys are matched **exactly**, upstream spellings included. These names
 * are Health Canada's own and have been observed against the live feed, so the
 * exact spelling is the checkable thing; forgiving case would quietly accept a
 * snapshot that does not look like the feed it claims to come from.
 */
const parseRow = (
  value: unknown,
  dataset: LnhpdDataset,
  at: string,
  index: number,
): LnhpdInputRow => {
  if (!isPlainObject(value)) {
    refuse(`${at} is ${describe(value)}, not a mapping.`);
  }

  const raw = value as Record<string, unknown>;
  const declared = LNHPD_COLUMNS[dataset];
  const unknown = Object.keys(raw)
    .filter((key) => !declared.includes(key))
    .sort();
  if (unknown.length > 0) {
    refuse(
      `${at} carries unknown column${unknown.length > 1 ? "s" : ""} ` +
        `${unknown.map((key) => `'${key}'`).join(", ")}.`,
    );
  }
  const missing = declared.filter((key) => !Object.hasOwn(raw, key));
  if (missing.length > 0) {
    refuse(
      `${at} is missing declared column${missing.length > 1 ? "s" : ""} ` +
        `${missing.map((key) => `'${key}'`).join(", ")}.`,
    );
  }

  const columns: Record<string, string | number | null> = {};
  for (const column of declared) {
    const cell = raw[column];
    if (cell === undefined || cell === null) {
      columns[column] = null;
      continue;
    }
    if (typeof cell !== "string" && typeof cell !== "number") {
      refuse(`${at}.${column} is ${describe(cell)}, not a string or a number.`);
    }
    if (typeof cell === "number" && !Number.isFinite(cell)) {
      refuse(`${at}.${column} is ${String(cell)}, not a finite number.`);
    }
    columns[column] = cell as string | number;
  }

  return { dataset, index, columns };
};

export const readDatasetRows = (
  text: string,
  dataset: LnhpdDataset,
  at: string,
): LnhpdInputRow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    refuse(
      `${at} is not valid JSON: ${(error as Error).message}. A truncated bulk ` +
        `download ends mid-object and fails exactly here.`,
    );
  }
  if (!Array.isArray(parsed)) {
    refuse(`${at} is ${describe(parsed)}, not the JSON array the bulk endpoint returns.`);
  }
  const rows = parsed as unknown[];
  if (rows.length === 0) {
    refuse(
      `${at} carries no rows. An empty batch has nothing to attribute and would ` +
        `still write a manifest, so it is refused rather than imported as a no-op.`,
    );
  }
  return rows.map((row, index) => parseRow(row, dataset, `${at}[${index}]`, index));
};

/**
 * Reads a whole snapshot: the receipt, then each dataset re-verified against it.
 *
 * The digest check is what makes the receipt binding rather than decorative. A
 * snapshot edited after acquisition — a row deleted, a unit corrected by hand —
 * would otherwise be published under a receipt asserting Health Canada served
 * those exact bytes at that exact instant, which is a provenance claim this
 * repository would be making falsely.
 */
export const readLnhpdSnapshot = (directory: string): LnhpdRowSet => {
  const root = resolve(directory);
  const receiptPath = resolve(root, "acquisition.json");
  const acquisition = parseAcquisition(
    readFileSync(receiptPath, "utf8"),
    "acquisition.json",
  );

  const rows = {
    productlicence: [] as LnhpdInputRow[],
    productdose: [] as LnhpdInputRow[],
  } satisfies Record<LnhpdDataset, LnhpdInputRow[]>;

  for (const entry of acquisition.datasets) {
    const path = resolve(root, entry.file);
    const size = statSync(path).size;
    if (size !== entry.observedBytes) {
      refuse(
        `${entry.file} is ${size} bytes on disk but the receipt records ` +
          `${entry.observedBytes}, so the snapshot changed after acquisition.`,
      );
    }
    const bytes = readFileSync(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) {
      refuse(
        `${entry.file} digests to ${digest} but the receipt records ` +
          `${entry.sha256}, so the snapshot changed after acquisition.`,
      );
    }
    const parsed = readDatasetRows(
      bytes.toString("utf8"),
      entry.dataset,
      entry.file,
    );
    if (parsed.length !== entry.rowCount) {
      refuse(
        `${entry.file} carries ${parsed.length} rows but the receipt records ` +
          `${entry.rowCount}.`,
      );
    }
    rows[entry.dataset] = parsed;
  }

  return { rows, acquisition };
};
