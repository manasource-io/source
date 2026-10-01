#!/usr/bin/env bun

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { formatYaml } from "../src/corpus.ts";
import { byString, deriveBatchId } from "../src/lnhpd/format.ts";

export const EDITORIAL_CLASSES = ["nootropic", "drug", "peptide"] as const;
export type EditorialClass = (typeof EDITORIAL_CLASSES)[number];

export const EDITORIAL_SOURCE_NAMESPACE = "manasource.editorial";
export const EDITORIAL_SCHEME = "manasource_editorial";
export const EDITORIAL_SOURCE_NAME = "manasource-editorial";
export const EDITORIAL_SOURCE_URL =
  "https://raw.githubusercontent.com/manasource-io/source/master/classifications/editorial.yaml";
export const EDITORIAL_ATTRIBUTION = "Manasource editorial";
export const EDITORIAL_IMPORTER_VERSION = "manasource-editorial-1";

export interface EditorialEntry {
  record_id: string;
  class: EditorialClass;
  note: string;
  decided_at: string;
  decided_by: string;
}

interface RecordFile {
  id: string;
  path: string;
  absolutePath: string;
  source: string;
}

interface PlannedFile {
  path: string;
  contents: string;
}

export interface EditorialClassificationPlan {
  batchId: string;
  entries: EditorialEntry[];
  records: PlannedFile[];
  manifest: PlannedFile;
  staleManifests: string[];
}

export interface EditorialClassificationResult {
  batchId: string;
  removed: string[];
  unchanged: string[];
  written: string[];
}

export class EditorialClassificationError extends Error {
  override readonly name = "EditorialClassificationError";
}

const RECORD_ID = /^(SI|SP|FD|DI|PI|CP)[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLASS_SET: ReadonlySet<string> = new Set(EDITORIAL_CLASSES);
const ENTRY_FIELDS = new Set(["record_id", "class", "note", "decided_at", "decided_by"]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function slashPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isDate(value: string): boolean {
  const matched = DATE.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function requiredText(
  entry: Record<string, unknown>,
  field: "note" | "decided_by",
  at: string,
): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new EditorialClassificationError(`${at}.${field} must be a non-empty string.`);
  }
  if (value !== value.trim()) {
    throw new EditorialClassificationError(`${at}.${field} must not have leading or trailing whitespace.`);
  }
  return value;
}

export function readEditorialEntries(inputPath: string): EditorialEntry[] {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
    throw new EditorialClassificationError(`Editorial input is not an ordinary file: ${absolutePath}`);
  }

  let value: unknown;
  try {
    value = parse(readFileSync(absolutePath, "utf8"), {
      merge: false,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
  } catch (error) {
    throw new EditorialClassificationError(
      `Could not parse ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value)) {
    throw new EditorialClassificationError(`${absolutePath} must contain a YAML list.`);
  }

  const entries: EditorialEntry[] = [];
  const keys = new Set<string>();
  value.forEach((item, index) => {
    const at = `entry ${index + 1}`;
    const entry = asRecord(item);
    if (!entry) throw new EditorialClassificationError(`${at} must be an object.`);
    for (const field of Object.keys(entry)) {
      if (!ENTRY_FIELDS.has(field)) {
        throw new EditorialClassificationError(`${at} contains unknown field ${JSON.stringify(field)}.`);
      }
    }
    for (const field of ENTRY_FIELDS) {
      if (!Object.hasOwn(entry, field)) {
        throw new EditorialClassificationError(`${at} is missing required field ${JSON.stringify(field)}.`);
      }
    }

    const recordId = entry.record_id;
    if (typeof recordId !== "string" || !RECORD_ID.test(recordId)) {
      throw new EditorialClassificationError(`${at}.record_id is not a valid record ID: ${JSON.stringify(recordId)}.`);
    }
    const classification = entry.class;
    if (typeof classification !== "string" || !CLASS_SET.has(classification)) {
      throw new EditorialClassificationError(
        `${at}.class must be one of ${EDITORIAL_CLASSES.join(", ")}; received ${JSON.stringify(classification)}.`,
      );
    }
    const decidedAt = entry.decided_at;
    if (typeof decidedAt !== "string" || !isDate(decidedAt)) {
      throw new EditorialClassificationError(`${at}.decided_at must be a real YYYY-MM-DD date.`);
    }

    const key = `${recordId}\u0000${classification}`;
    if (keys.has(key)) {
      throw new EditorialClassificationError(
        `${at} duplicates editorial classification ${recordId}:${classification}.`,
      );
    }
    keys.add(key);
    entries.push({
      record_id: recordId,
      class: classification as EditorialClass,
      note: requiredText(entry, "note", at),
      decided_at: decidedAt,
      decided_by: requiredText(entry, "decided_by", at),
    });
  });

  return entries.sort(
    (left, right) =>
      byString(left.record_id, right.record_id) ||
      byString(left.class, right.class) ||
      byString(left.decided_at, right.decided_at) ||
      byString(left.decided_by, right.decided_by) ||
      byString(left.note, right.note),
  );
}

function recordFiles(corpusRoot: string): Map<string, RecordFile> {
  const recordsRoot = resolve(corpusRoot, "records");
  if (!existsSync(recordsRoot) || !lstatSync(recordsRoot).isDirectory()) {
    throw new EditorialClassificationError(`Records directory does not exist: ${recordsRoot}`);
  }

  const records = new Map<string, RecordFile>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
      const id = entry.name.slice(0, -5);
      if (!RECORD_ID.test(id)) continue;
      if (records.has(id)) {
        throw new EditorialClassificationError(`Record ID ${id} appears in more than one file.`);
      }
      records.set(id, {
        id,
        path: slashPath(corpusRoot, absolutePath),
        absolutePath,
        source: readFileSync(absolutePath, "utf8"),
      });
    }
  };
  visit(recordsRoot);
  return records;
}

function editorialFact(recordId: string, classification: EditorialClass): Record<string, unknown> {
  return {
    code: classification,
    kind: "classification",
    scheme: EDITORIAL_SCHEME,
    source: {
      attribution: EDITORIAL_ATTRIBUTION,
      namespace: EDITORIAL_SOURCE_NAMESPACE,
      source_record_id: `${recordId}:${classification}`,
      url: EDITORIAL_SOURCE_URL,
    },
  };
}

function hasEditorialNamespace(fact: unknown): boolean {
  return asRecord(asRecord(fact)?.source)?.namespace === EDITORIAL_SOURCE_NAMESPACE;
}

function staleManifestPaths(corpusRoot: string, currentPath: string): string[] {
  const directory = resolve(corpusRoot, "manifests", EDITORIAL_SOURCE_NAME);
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) {
    throw new EditorialClassificationError(`Editorial manifest path is not a directory: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => `manifests/${EDITORIAL_SOURCE_NAME}/${entry.name}`)
    .filter((path) => path !== currentPath)
    .sort(byString);
}

export function planEditorialClassifications(
  corpusRoot: string,
  inputPath: string,
): EditorialClassificationPlan {
  const root = resolve(corpusRoot);
  const entries = readEditorialEntries(inputPath);
  const records = recordFiles(root);
  const desired = new Map<string, EditorialClass[]>();
  for (const entry of entries) {
    if (!records.has(entry.record_id)) {
      throw new EditorialClassificationError(
        `Editorial classification ${entry.record_id}:${entry.class} targets an unknown record ID.`,
      );
    }
    const classes = desired.get(entry.record_id) ?? [];
    classes.push(entry.class);
    desired.set(entry.record_id, classes);
  }

  const touchedIds = new Set(desired.keys());
  for (const record of records.values()) {
    if (record.source.includes(EDITORIAL_SOURCE_NAMESPACE)) touchedIds.add(record.id);
  }

  const plannedRecords: PlannedFile[] = [];
  for (const id of [...touchedIds].sort(byString)) {
    const record = records.get(id)!;
    let data: Record<string, unknown>;
    try {
      data = asRecord(parse(record.source, { merge: false, uniqueKeys: true })) ?? {};
    } catch (error) {
      throw new EditorialClassificationError(
        `Could not parse ${record.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (data.id !== id || data.kind !== "record") {
      throw new EditorialClassificationError(`${record.path} is not the expected record ${id}.`);
    }

    const retained = (Array.isArray(data.facts) ? data.facts : []).filter(
      (fact) => !hasEditorialNamespace(fact),
    );
    const added = (desired.get(id) ?? []).map((classification) =>
      editorialFact(id, classification),
    );
    const facts = [...retained, ...added];
    if (facts.length === 0) delete data.facts;
    else data.facts = facts;
    plannedRecords.push({ path: record.path, contents: formatYaml(data) });
  }

  const recordIds = [...desired.keys()].sort(byString);
  const batchId = deriveBatchId(EDITORIAL_SOURCE_NAME, {
    importerVersion: EDITORIAL_IMPORTER_VERSION,
    sourceNamespace: EDITORIAL_SOURCE_NAMESPACE,
    entries,
  });
  const manifestPath = `manifests/${EDITORIAL_SOURCE_NAME}/${batchId}.yaml`;
  const manifest: PlannedFile = {
    path: manifestPath,
    contents: formatYaml({
      attribution: EDITORIAL_ATTRIBUTION,
      batch_id: batchId,
      classifications: entries,
      counts: { classifications: entries.length, records: recordIds.length },
      importer_version: EDITORIAL_IMPORTER_VERSION,
      kind: "classification_manifest",
      license: "CC-BY-SA-4.0",
      records: recordIds,
      schema_version: 1,
      source: EDITORIAL_SOURCE_NAME,
      source_namespace: EDITORIAL_SOURCE_NAMESPACE,
    }),
  };

  return {
    batchId,
    entries,
    records: plannedRecords,
    manifest,
    staleManifests: staleManifestPaths(root, manifestPath),
  };
}

export function applyEditorialClassifications(
  corpusRoot: string,
  inputPath: string,
): EditorialClassificationResult {
  const root = resolve(corpusRoot);
  const plan = planEditorialClassifications(root, inputPath);
  const result: EditorialClassificationResult = {
    batchId: plan.batchId,
    removed: [],
    unchanged: [],
    written: [],
  };

  for (const file of [...plan.records, plan.manifest]) {
    const absolutePath = resolve(root, ...file.path.split("/"));
    const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
    if (existing === file.contents) {
      result.unchanged.push(file.path);
      continue;
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.contents, "utf8");
    result.written.push(file.path);
  }
  for (const path of plan.staleManifests) {
    rmSync(resolve(root, ...path.split("/")));
    result.removed.push(path);
  }
  result.removed.sort(byString);
  result.unchanged.sort(byString);
  result.written.sort(byString);
  return result;
}

function usage(): never {
  console.error(
    "Usage: bun run scripts/records-classify.ts [editorial-file] [corpus-root]",
  );
  process.exit(2);
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 2) usage();
  const corpusRoot = resolve(arguments_[1] ?? ".");
  const inputPath = arguments_[0]
    ? resolve(arguments_[0])
    : resolve(corpusRoot, "classifications", "editorial.yaml");
  try {
    const result = applyEditorialClassifications(corpusRoot, inputPath);
    console.log(
      `Editorial batch ${result.batchId}: wrote ${result.written.length}, removed ${result.removed.length}, unchanged ${result.unchanged.length} file(s).`,
    );
    if (result.written.length === 0 && result.removed.length === 0) {
      console.log("Unchanged input issued no writes or removals.");
    }
  } catch (error) {
    if (error instanceof EditorialClassificationError) {
      console.error(`${error.name}: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
