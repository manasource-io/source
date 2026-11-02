import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { familyKey } from "./forms.ts";
import {
  EDGES_FILE,
  FAMILIES_DIRECTORY,
  FAMILY_BASES,
  FAMILY_ROLES,
  OVERRIDES_FILE,
  compareEdges,
} from "./format.ts";
import type { FamilyEdge } from "./format.ts";

const EDGES_PATH = `${FAMILIES_DIRECTORY}/${EDGES_FILE}`;
const OVERRIDES_PATH = `${FAMILIES_DIRECTORY}/${OVERRIDES_FILE}`;
const RECORD_PATH = /^records\/([a-z_]+)\/[^/]+\/([A-Z]{2}[0-9A-Z]{6})\.yaml$/;
const ROLES: ReadonlySet<string> = new Set(FAMILY_ROLES);
const BASES: ReadonlySet<string> = new Set(FAMILY_BASES);

const OVERRIDE_LISTS: ReadonlySet<string> = new Set(["forms", "rejected", "aliases", "display"]);
const AUDIT_FIELDS = ["note", "decided_at", "decided_by"] as const;

export type ReportDiagnostic = (code: string, message: string) => void;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every override is a person's decision, so each must say who, when and why. */
const validateOverrides = (
  root: string,
  records: ReadonlySet<string>,
  report: ReportDiagnostic,
): void => {
  const path = resolve(root, OVERRIDES_PATH);
  if (!existsSync(path)) return;

  let overrides: unknown;
  try {
    overrides = parse(readFileSync(path, "utf8"));
  } catch {
    report("family/malformed-overrides", `${OVERRIDES_FILE} is not YAML`);
    return;
  }
  if (!isObject(overrides)) {
    report("family/malformed-overrides", `${OVERRIDES_FILE} is not a mapping`);
    return;
  }

  const spellings = new Set<string>();
  for (const [list, entries] of Object.entries(overrides)) {
    if (!OVERRIDE_LISTS.has(list) || !Array.isArray(entries)) {
      report("family/malformed-overrides", `${list} is not one of the four closed lists`);
      continue;
    }
    for (const entry of entries as unknown[]) {
      if (!isObject(entry)) {
        report("family/malformed-overrides", `${list} holds an entry that is not a mapping`);
        continue;
      }
      const name = `${list} ${String(entry.name ?? entry.member ?? entry.base)}`;
      for (const field of AUDIT_FIELDS) {
        if (typeof entry[field] !== "string" || !entry[field]) {
          report("family/unaudited-override", `${name} has no ${field}`);
        }
      }
      for (const id of [entry.base, entry.member]) {
        if (id !== undefined && !records.has(String(id))) {
          report("family/unknown-record", `${name} names ${String(id)}, which is not a record`);
        }
      }
      if (String(entry.base).startsWith("SP")) {
        report("family/product-as-base", `${name} uses a product as a base`);
      }
      if (list === "aliases") {
        const key = familyKey(String(entry.name ?? ""));
        if (!key) report("family/malformed-overrides", `${name} has no name`);
        if (spellings.has(key)) report("family/duplicate-alias", `${name} appears twice`);
        spellings.add(key);
      }
    }
  }
};

/**
 * Structural checks on the edge file, which fail closed and stay on through the
 * evidence-integrity suspension: a family states nothing about evidence, and a broken
 * file would quietly bring the search noise back. `families/` is optional, so a
 * fixture root may omit it.
 */
export const validateFamilies = (
  root: string,
  corpusPaths: readonly string[],
  report: ReportDiagnostic,
): void => {
  const records = new Set<string>();
  for (const corpusPath of corpusPaths) {
    const match = RECORD_PATH.exec(corpusPath);
    if (match?.[2]) records.add(match[2]);
  }

  validateOverrides(root, records, report);

  const path = resolve(root, EDGES_PATH);
  if (!existsSync(path)) return;

  const edges: FamilyEdge[] = [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      edges.push(JSON.parse(line) as FamilyEdge);
    } catch {
      report("family/malformed", `line ${index + 1} is not JSON`);
    }
  }

  const bases = new Set(edges.map(({ base }) => base));
  const seen = new Set<string>();
  let previous: FamilyEdge | null = null;

  for (const edge of edges) {
    const name = `${edge.base} -> ${edge.member}`;
    if (!ROLES.has(edge.role)) {
      report("family/unknown-role", `${name} has role ${String(edge.role)}`);
    }
    if (!BASES.has(edge.basis)) {
      report("family/unknown-basis", `${name} has basis ${String(edge.basis)}`);
    }
    for (const id of [edge.base, edge.member]) {
      if (!records.has(id)) {
        report("family/unknown-record", `${name} names ${id}, which is not a record`);
      }
    }
    if (edge.base.startsWith("SP")) {
      report("family/product-as-base", `${name} uses a product as a base`);
    }
    if (bases.has(edge.member)) {
      report("family/base-is-member", `${edge.member} is both a base and a member`);
    }
    const key = `${edge.base}\0${edge.member}`;
    if (seen.has(key)) report("family/duplicate-edge", `${name} appears twice`);
    seen.add(key);
    if (previous && compareEdges(previous, edge) > 0) {
      report("family/unsorted", `${name} is out of order`);
    }
    previous = edge;
  }
};
