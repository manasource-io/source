/**
 * What the family ledger publishes, and the vocabulary every step of it shares.
 *
 * A family is one substance and everything that is a version of it. It is a **view
 * over records**: nothing is merged, deleted or re-identified, and a family carries no
 * score, grade, claim or association. The ledger is one generated edge file, so a rule
 * change is one reviewable diff rather than a rewrite of 93,540 record files.
 */

export const FAMILY_ROLES = ["form", "product", "combination"] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

export const FAMILY_BASES = [
  "name_rule",
  "gsrs_relationship",
  "hc.lnhpd",
  "editorial",
] as const;
export type FamilyBasis = (typeof FAMILY_BASES)[number];

export type FamilyEdge = {
  base: string;
  member: string;
  role: FamilyRole;
  basis: FamilyBasis;
  /** A label for the form, from Health Canada's `source_material`. */
  form?: string;
};

export const FAMILIES_DIRECTORY = "families";
export const EDGES_FILE = "edges.jsonl";
export const OVERRIDES_FILE = "overrides.yaml";
export const REPORT_FILE = "report.json";

export const FAMILY_SOURCE_NAME = "manasource-families";
export const FAMILY_IMPORTER_VERSION = "families-1";

export class FamilyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyImportError";
  }
}

/** Codepoint order, so a sorted file is the same on every machine. */
export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const ROLE_ORDER: Record<FamilyRole, number> = {
  form: 0,
  product: 1,
  combination: 2,
};

export const compareEdges = (left: FamilyEdge, right: FamilyEdge): number =>
  compareText(left.base, right.base) ||
  ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
  compareText(left.member, right.member);

/** One line, with its keys in one order, so a rebuild moves no byte it need not. */
export const edgeLine = ({ base, member, role, basis, form }: FamilyEdge): string =>
  JSON.stringify({ base, member, role, basis, ...(form ? { form } : {}) });

export const parseEdges = (text: string): FamilyEdge[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FamilyEdge);
