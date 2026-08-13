import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { LNHPD_SOURCE_NAMESPACE } from "./format.ts";

/**
 * The narrow view of the existing corpus this importer needs: which typed IDs
 * are already spoken for, and which record already sources each LNHPD product.
 *
 * It is deliberately not a second corpus parser. `src/corpus.ts` owns validation
 * and is the thing that decides whether the corpus is well-formed; this reads a
 * well-formed corpus for two facts and refuses to guess at anything else.
 *
 * Taken IDs come from **file names**, because the record path layout is the
 * public contract (`records/<record_type>/<id-shard>/<id>.yaml`) and validation
 * already proves the name and the `id` field agree. Reading 30,000 YAML bodies
 * to learn what a directory listing already states would cost a minute per run
 * to answer a question the layout answers for free. Only the files that mention
 * this importer's namespace are parsed, because those are the only ones it may
 * rewrite.
 */

export type ExistingRecord = {
  id: string;
  path: string;
  entityType: string;
  data: Record<string, unknown>;
  sources: { namespace: string; sourceRecordId: string }[];
};

export type CorpusIndex = {
  takenIds: Set<string>;
  /** Records already carrying an `hc.lnhpd` source row, keyed by that row's id. */
  byLnhpdId: Map<string, ExistingRecord>;
  recordCount: number;
};

const RECORD_FILE = /^([A-Z]{2}[0-9A-Z]{6})\.yaml$/;

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const walk = (directory: string, found: string[]): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (entry.isFile() && entry.name.endsWith(".yaml")) found.push(path);
  }
};

export const indexCorpus = (corpusRoot: string): CorpusIndex => {
  const root = resolve(corpusRoot);
  const recordsRoot = resolve(root, "records");
  const takenIds = new Set<string>();
  const byLnhpdId = new Map<string, ExistingRecord>();

  if (!existsSync(recordsRoot)) {
    return { takenIds, byLnhpdId, recordCount: 0 };
  }

  const files: string[] = [];
  walk(recordsRoot, files);

  for (const file of files) {
    const name = file.split(sep).at(-1) ?? "";
    const matched = RECORD_FILE.exec(name);
    if (!matched?.[1]) continue;
    takenIds.add(matched[1]);

    const text = readFileSync(file, "utf8");
    if (!text.includes(LNHPD_SOURCE_NAMESPACE)) continue;

    const data = asRecord(parse(text) as unknown);
    if (!data) continue;
    const sources: ExistingRecord[ "sources" ] = [];
    for (const item of Array.isArray(data.sources) ? data.sources : []) {
      const source = asRecord(item);
      if (
        typeof source?.namespace !== "string" ||
        typeof source.source_record_id !== "string"
      ) {
        continue;
      }
      sources.push({
        namespace: source.namespace,
        sourceRecordId: source.source_record_id,
      });
    }

    const existing: ExistingRecord = {
      id: matched[1],
      path: relative(root, file).split(sep).join("/"),
      entityType: typeof data.entity_type === "string" ? data.entity_type : "",
      data,
      sources,
    };
    for (const source of sources) {
      if (source.namespace !== LNHPD_SOURCE_NAMESPACE) continue;
      byLnhpdId.set(source.sourceRecordId, existing);
    }
  }

  return { takenIds, byLnhpdId, recordCount: takenIds.size };
};
