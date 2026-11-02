import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { LNHPD_API_BASE } from "../lnhpd/format.ts";
import { FamilyImportError } from "./format.ts";

/**
 * The only part of the ledger that touches the network.
 *
 * It holds two public datasets in a transient snapshot and writes a receipt naming the
 * URL, instant, bytes and digest of each. Nothing downstream fetches anything, so an
 * import is a function of a snapshot on disk.
 *
 * Health Canada's `medicinalingredient` is read one licence at a time. Its paged list
 * looks whole and is not: the pages have no stable order, so a full pull holds the right
 * number of rows with a third of them repeated, and 23% of the ingredient names in a
 * sample of 380 products were simply absent. Asking by licence is slow and exact. Each
 * answer is kept as it arrives, so an interrupted pull resumes, and wholeness is every
 * licence in the corpus having answered. The snapshot keeps only the columns the
 * ledger reads, sorted, so one upstream state is one file.
 */

export const FAMILY_SNAPSHOT_CONTRACT = "manasource-families-snapshot-1";

const INGREDIENT_URL = `${LNHPD_API_BASE}/medicinalingredient/?lang=en&type=json`;
const FDA_DOWNLOADS = "https://api.fda.gov/download.json";
const MAX_ATTEMPTS = 6;
const USER_AGENT = "manasource-families/1 (+https://github.com/manasource-io/source)";

export type IngredientRow = {
  lnhpd_id: number;
  ingredient_name: string;
  source_material: string;
};

export type SubstanceRow = {
  unii: string;
  name: string;
  relationships: { type: string; unii: string }[];
};

export type AcquiredFile = {
  dataset: string;
  url: string;
  file: string;
  retrieved_at: string;
  bytes: number;
  sha256: string;
  rows: number;
};

type Report = (message: string) => void;

const digestOf = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

const compareIngredients = (left: IngredientRow, right: IngredientRow): number =>
  left.lnhpd_id - right.lnhpd_id ||
  (left.ingredient_name < right.ingredient_name ? -1 : 1) ||
  (left.source_material < right.source_material ? -1 : 1);

const readLicence = async (
  id: string,
  fetchImplementation: typeof fetch,
  backoffMs: number,
): Promise<IngredientRow[]> => {
  const url = `${INGREDIENT_URL}&id=${encodeURIComponent(id)}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status === 200) {
        const { data } = (await response.json()) as { data: IngredientRow[] };
        return data.map(({ lnhpd_id, ingredient_name, source_material }) => ({
          lnhpd_id,
          ingredient_name,
          source_material: source_material ?? "",
        }));
      }
      if (attempt >= MAX_ATTEMPTS) {
        throw new FamilyImportError(`${url} answered HTTP ${response.status}.`);
      }
    } catch (error) {
      if (error instanceof FamilyImportError || attempt >= MAX_ATTEMPTS) throw error;
    }
    await sleep(backoffMs * 2 ** attempt);
  }
};

const PROGRESS_FILE = "medicinalingredient.progress.jsonl";

/** What an earlier run finished. A line cut off by a kill is read as not done. */
const readProgress = (path: string): Map<string, IngredientRow[]> => {
  const done = new Map<string, IngredientRow[]>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const { id, rows } = JSON.parse(line) as { id: string; rows: IngredientRow[] };
      done.set(id, rows);
    } catch {
      // The last line of a run that was killed mid-write.
    }
  }
  return done;
};

/**
 * Reads every licence not yet held. Returns `null` when `stopAfterMs` ends a run early,
 * and the same call picks up where it stopped.
 */
export const acquireIngredients = async (
  directory: string,
  ids: readonly string[],
  {
    fetchImplementation = fetch,
    concurrency = 4,
    stopAfterMs = Number.POSITIVE_INFINITY,
    backoffMs = 2_000,
    onProgress = () => {},
  }: {
    fetchImplementation?: typeof fetch;
    concurrency?: number;
    stopAfterMs?: number;
    backoffMs?: number;
    onProgress?: Report;
  } = {},
): Promise<AcquiredFile | null> => {
  const progressPath = resolve(directory, PROGRESS_FILE);
  const done = readProgress(progressPath);
  const queue = ids.filter((id) => !done.has(id));
  const stopAt = Date.now() + stopAfterMs;
  onProgress(`medicinalingredient: ${done.size} of ${ids.length} licences held`);

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (Date.now() >= stopAt) return;
        const id = queue.shift();
        if (id === undefined) return;
        const rows = await readLicence(id, fetchImplementation, backoffMs);
        done.set(id, rows);
        appendFileSync(progressPath, `${JSON.stringify({ id, rows })}\n`);
        if (done.size % 1000 === 0) {
          onProgress(`medicinalingredient: ${done.size} of ${ids.length} licences`);
        }
      }
    }),
  );
  if (ids.some((id) => !done.has(id))) return null;

  const seen = new Set<string>();
  const rows = [...done.values()]
    .flat()
    .sort(compareIngredients)
    .flatMap((row) => {
      const line = JSON.stringify({
        lnhpd_id: row.lnhpd_id,
        ingredient_name: row.ingredient_name,
        source_material: row.source_material,
      });
      if (seen.has(line)) return [];
      seen.add(line);
      return [line];
    });

  const file = "medicinalingredient.jsonl";
  const target = resolve(directory, file);
  writeFileSync(target, `${rows.join("\n")}\n`);
  rmSync(progressPath, { force: true });

  return {
    dataset: "hc.lnhpd.medicinalingredient",
    url: INGREDIENT_URL,
    file,
    retrieved_at: new Date().toISOString(),
    bytes: statSync(target).size,
    sha256: digestOf(target),
    rows: rows.length,
  };
};

/**
 * Calls `onValue` with the text of each object in the top-level `results` array. The
 * archive is several gigabytes, so it is read in chunks, and an object split across two
 * chunks is carried over with the scan resuming where it stopped.
 */
export const splitResults = (onValue: (text: string) => void) => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let carry = "";
  let armed = false;

  return (chunk: string): void => {
    let text = carry + chunk;
    let index = carry.length;
    if (!armed) {
      const at = text.indexOf('"results"');
      const open = at === -1 ? -1 : text.indexOf("[", at);
      if (open === -1) {
        carry = at === -1 ? text.slice(-16) : text.slice(at);
        return;
      }
      armed = true;
      text = text.slice(open + 1);
      index = 0;
    }
    let start = depth > 0 ? 0 : -1;
    for (; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) inString = false;
        continue;
      }
      if (code === 34) inString = true;
      else if (code === 123) {
        if (depth === 0) start = index;
        depth += 1;
      } else if (code === 125) {
        depth -= 1;
        if (depth === 0) {
          onValue(text.slice(start, index + 1));
          start = -1;
        }
      }
    }
    carry = depth > 0 ? text.slice(start) : "";
  };
};

type RawSubstance = {
  unii?: string;
  names?: { name?: string; display_name?: boolean | string; preferred?: boolean | string }[];
  relationships?: {
    type?: string;
    related_substance?: { unii?: string };
  }[];
};

export const substanceRowOf = (raw: RawSubstance): SubstanceRow | null => {
  if (!raw.unii) return null;
  const names = raw.names ?? [];
  const preferred =
    names.find((each) => each.display_name === true || each.display_name === "true") ??
    names.find((each) => each.preferred === true || each.preferred === "true") ??
    names[0];
  return {
    unii: raw.unii,
    name: preferred?.name ?? raw.unii,
    relationships: (raw.relationships ?? []).flatMap(({ type, related_substance }) =>
      type && related_substance?.unii
        ? [{ type, unii: related_substance.unii }]
        : [],
    ),
  };
};

export const acquireSubstances = async (
  directory: string,
  {
    fetchImplementation = fetch,
    onProgress = () => {},
  }: { fetchImplementation?: typeof fetch; onProgress?: Report } = {},
): Promise<AcquiredFile> => {
  const index = (await (await fetchImplementation(FDA_DOWNLOADS)).json()) as {
    results: {
      other: {
        substance: {
          export_date: string;
          partitions: { file: string; records: number }[];
        };
      };
    };
  };
  const { partitions } = index.results.other.substance;
  const partition = partitions[0];
  if (partitions.length !== 1 || !partition) {
    throw new FamilyImportError(
      `openFDA substance data has ${partitions.length} partitions; this reader expects one.`,
    );
  }

  const archive = resolve(directory, "substance.json.zip");
  const retrievedAt = new Date().toISOString();
  if (!existsSync(archive)) {
    onProgress(`fetching ${partition.file}`);
    const response = await fetchImplementation(partition.file);
    if (response.status !== 200 || !response.body) {
      throw new FamilyImportError(`${partition.file} answered HTTP ${response.status}.`);
    }
    const partial = `${archive}.partial`;
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
    renameSync(partial, archive);
  }

  const file = "substances.jsonl";
  const target = resolve(directory, file);
  const out = createWriteStream(target);
  let rows = 0;
  const split = splitResults((text) => {
    rows += 1;
    // A substance with no UNII cannot join to a record, so it is read and not kept.
    const row = substanceRowOf(JSON.parse(text) as RawSubstance);
    if (row) out.write(`${JSON.stringify(row)}\n`);
  });

  const unzip = spawn("unzip", ["-p", archive], { stdio: ["ignore", "pipe", "inherit"] });
  const decoder = new TextDecoder();
  for await (const chunk of unzip.stdout as AsyncIterable<Uint8Array>) {
    split(decoder.decode(chunk, { stream: true }));
  }
  await new Promise<void>((done) => out.end(done));

  if (rows !== partition.records) {
    throw new FamilyImportError(
      `The substance archive held ${rows} rows against ${partition.records} declared.`,
    );
  }
  const receipt: AcquiredFile = {
    dataset: "fda.openfda.substance",
    url: partition.file,
    file,
    retrieved_at: retrievedAt,
    bytes: statSync(archive).size,
    sha256: digestOf(archive),
    rows,
  };
  rmSync(archive, { force: true });
  return receipt;
};

export type FamilyAcquisition = {
  contract: string;
  datasets: AcquiredFile[];
};

export const writeAcquisition = (
  directory: string,
  dataset: AcquiredFile,
): FamilyAcquisition => {
  const path = resolve(directory, "acquisition.json");
  const held = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as FamilyAcquisition).datasets
    : [];
  const acquisition: FamilyAcquisition = {
    contract: FAMILY_SNAPSHOT_CONTRACT,
    datasets: [...held.filter((each) => each.dataset !== dataset.dataset), dataset].sort(
      (left, right) => (left.dataset < right.dataset ? -1 : 1),
    ),
  };
  writeFileSync(path, `${JSON.stringify(acquisition, null, 2)}\n`);
  return acquisition;
};

export const readIngredients = (directory: string): IngredientRow[] =>
  readFileSync(resolve(directory, "medicinalingredient.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IngredientRow);

export const readSubstances = (directory: string): SubstanceRow[] =>
  readFileSync(resolve(directory, "substances.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SubstanceRow);

export const hasDataset = (directory: string, file: string): boolean =>
  existsSync(resolve(directory, file)) && readdirSync(directory).includes(file);
