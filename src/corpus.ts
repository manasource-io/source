import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseAllDocuments, stringify } from "yaml";

const CORPUS_DIRECTORIES = ["resources", "masteries", "records", "manifests"] as const;
const ENTITY_DIRECTORIES = new Set(["resources", "masteries", "records"]);
const SCHEMA_DIRECTORY = resolve(import.meta.dir, "..", "schemas");
const CROCKFORD = "[0123456789ABCDEFGHJKMNPQRSTVWXYZ]";
const TYPED_ID = new RegExp(`^(SI|SP|FD|DI|PI|CP|EX|HB|RS|CI|WB|AB|DT|XA)${CROCKFORD}{6}$`);
const SAFE_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXERCISE_SECTION = "resources/exercise/";

/**
 * Source publishes exercise as evidence types, not as an activity catalog. Named
 * sports, movements, equipment, routines, protocols, and non-exercise exposures
 * are app-owned log targets and never earn a resource here.
 */
export const EXERCISE_RESOURCE_SLUGS = [
  "aerobic-exercise",
  "balance-coordination",
  "strength-training",
  "stretching",
] as const;

const EXERCISE_SLUGS: ReadonlySet<string> = new Set(EXERCISE_RESOURCE_SLUGS);

export const TYPE_PREFIXES = {
  supplement_ingredient: "SI",
  supplement_product: "SP",
  food: "FD",
  drug_ingredient: "DI",
  precise_ingredient: "PI",
  compound: "CP",
  exercise: "EX",
  habit: "HB",
  restoration: "RS",
  circadian: "CI",
  wellbeing: "WB",
  abstinence: "AB",
  diet: "DT",
  app_synthetic: "XA",
} as const;

export const RECORD_TYPES = new Set([
  "supplement_ingredient",
  "supplement_product",
  "food",
  "drug_ingredient",
  "precise_ingredient",
  "compound",
]);

type CorpusKind = "resource" | "mastery" | "record" | "manifest";

export interface Diagnostic {
  code: string;
  message: string;
  path: string;
  /** JSON pointer into the document, when the diagnostic came from the schema. */
  pointer?: string;
}

export interface ValidationResult {
  diagnostics: Diagnostic[];
  filesChecked: number;
  ok: boolean;
  /**
   * Diagnostics the evidence-integrity suspension demoted. They are reported
   * and never gate. Empty once the suspension is lifted.
   */
  warnings: Diagnostic[];
}

/**
 * Evidence-integrity enforcement is suspended for pre-public development.
 *
 * Curated resources are being written faster than their citations can be
 * sourced, and the accuracy pass that restores every rule below is a single
 * planned effort before launch — not a per-entry tax on drafting. While this is
 * `true`, the checks still run and still report; they are demoted to warnings
 * instead of failing `corpus:validate`.
 *
 * Flip to `false` to restore fail-closed evidence integrity. Nothing else needs
 * to change: no check was deleted. See the monorepo's
 * `docs/specs/evidence-integrity-suspension.md` for the full inventory and the
 * restoration procedure.
 */
export const EVIDENCE_INTEGRITY_SUSPENDED = true;

/**
 * Non-schema diagnostic codes the suspension demotes: a claim citing a
 * reference the resource does not declare, and the whole reference-import
 * manifest family that exists to prove bibliographic identity came from Crossref
 * rather than from an author's memory. `manifest/reference-count` is not here:
 * a batch whose declared count disagrees with its own entries is broken
 * bookkeeping, not an unproven citation.
 */
const SUSPENDED_CODES: ReadonlySet<string> = new Set([
  "reference/broken-claim-link",
  "manifest/missing-reference",
  "manifest/missing-reference-coverage",
  "manifest/reference-authors-mismatch",
  "manifest/reference-container-title-mismatch",
  "manifest/reference-doi-mismatch",
]);

/**
 * Schema pointers the suspension demotes: a missing `references` list, an
 * incomplete reference entry, and a claim's citation list. Structural rules that
 * are not about evidence — duplicate IDs, ID shape, path layout, YAML validity —
 * stay fail-closed, because a corpus that cannot be read back is not a
 * verification problem.
 */
const SUSPENDED_POINTER = /(^|\/)(references)(\/|$)/;

function isSuspended(diagnostic: Diagnostic): boolean {
  if (!EVIDENCE_INTEGRITY_SUSPENDED) return false;
  if (SUSPENDED_CODES.has(diagnostic.code)) return true;
  if (!diagnostic.code.startsWith("schema/")) return false;
  const pointer = diagnostic.pointer ?? "";
  if (SUSPENDED_POINTER.test(pointer)) return true;
  // `/ must have required property 'references'` lands on the document root.
  return (
    (diagnostic.code === "schema/required" ||
      diagnostic.code === "schema/dependentRequired") &&
    /required property '?references'?/.test(diagnostic.message)
  );
}

/** Split enforced errors from demoted evidence-integrity warnings. */
function partitionDiagnostics(diagnostics: Diagnostic[]): {
  errors: Diagnostic[];
  warnings: Diagnostic[];
} {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    (isSuspended(diagnostic) ? warnings : errors).push(diagnostic);
  }
  return { errors, warnings };
}

interface ParsedYaml {
  data: unknown;
  kind: CorpusKind;
  path: string;
  source: string;
}

interface ScannedCorpus {
  diagnostics: Diagnostic[];
  markdown: string[];
  yaml: string[];
}

interface EntityData {
  associations?: unknown;
  claims?: unknown;
  entity_type?: unknown;
  facts?: unknown;
  id?: unknown;
  identifiers?: unknown;
  kind?: unknown;
  links?: unknown;
  references?: unknown;
  slug?: unknown;
  sources?: unknown;
}

interface ManifestData {
  batch_id?: unknown;
  counts?: unknown;
  kind?: unknown;
  quarantine?: unknown;
  record_type?: unknown;
  records?: unknown;
  references?: unknown;
  source?: unknown;
  source_namespace?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function slashPath(value: string): string {
  return value.split(sep).join("/");
}

function relativePath(root: string, absolutePath: string): string {
  return slashPath(relative(root, absolutePath));
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message),
  );
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  path: string,
  code: string,
  message: string,
  pointer?: string,
): void {
  diagnostics.push(pointer === undefined ? { code, message, path } : { code, message, path, pointer });
}

function scanDirectory(root: string, directory: string, scanned: ScannedCorpus): void {
  const absoluteDirectory = resolve(root, directory);
  if (!existsSync(absoluteDirectory)) return;
  const directoryStats = lstatSync(absoluteDirectory);
  if (directoryStats.isSymbolicLink()) {
    addDiagnostic(scanned.diagnostics, directory, "path/symlink", "corpus paths must not be symbolic links");
    return;
  }
  if (!directoryStats.isDirectory()) {
    addDiagnostic(scanned.diagnostics, directory, "path/not-directory", "corpus directory path must be a directory");
    return;
  }

  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const absolutePath = resolve(absoluteDirectory, entry.name);
    const path = relativePath(root, absolutePath);

    if (entry.isSymbolicLink() || lstatSync(absolutePath).isSymbolicLink()) {
      addDiagnostic(scanned.diagnostics, path, "path/symlink", "corpus paths must not be symbolic links");
      continue;
    }
    if (entry.isDirectory()) {
      scanDirectory(root, path, scanned);
      continue;
    }
    if (!entry.isFile()) continue;

    if (path.endsWith(".yaml")) {
      scanned.yaml.push(path);
      continue;
    }
    if (path.endsWith(".md")) {
      scanned.markdown.push(path);
      continue;
    }
    addDiagnostic(
      scanned.diagnostics,
      path,
      path.endsWith(".yml") ? "path/non-canonical-extension" : "path/unsupported-file",
      path.endsWith(".yml")
        ? "corpus YAML files must use the .yaml extension"
        : "corpus directories may contain only canonical .yaml and same-stem .md files",
    );
  }
}

function scanCorpus(root: string): ScannedCorpus {
  const scanned: ScannedCorpus = { diagnostics: [], markdown: [], yaml: [] };
  if (!existsSync(root)) {
    addDiagnostic(scanned.diagnostics, ".", "root/missing", "corpus root does not exist");
    return scanned;
  }
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink()) {
    addDiagnostic(scanned.diagnostics, ".", "path/symlink", "corpus root must not be a symbolic link");
    return scanned;
  }
  if (!rootStats.isDirectory()) {
    addDiagnostic(scanned.diagnostics, ".", "root/not-directory", "corpus root must be a directory");
    return scanned;
  }
  for (const directory of CORPUS_DIRECTORIES) scanDirectory(root, directory, scanned);
  scanned.markdown.sort();
  scanned.yaml.sort();
  return scanned;
}

function readJsonSchema(name: string): object {
  return JSON.parse(readFileSync(resolve(SCHEMA_DIRECTORY, name), "utf8")) as object;
}

export function createSchemaValidators(): Readonly<Record<CorpusKind, ValidateFunction>> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(readJsonSchema("common.schema.json"));

  return {
    resource: ajv.compile(readJsonSchema("resource.schema.json")),
    mastery: ajv.compile(readJsonSchema("mastery.schema.json")),
    record: ajv.compile(readJsonSchema("record.schema.json")),
    manifest: ajv.compile(readJsonSchema("manifest.schema.json")),
  };
}

function kindFromPath(path: string): CorpusKind {
  if (path.startsWith("resources/")) return "resource";
  if (path.startsWith("masteries/")) return "mastery";
  if (path.startsWith("records/")) return "record";
  return "manifest";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = asRecord(value);
  if (!record) return value;

  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function formatYaml(value: unknown): string {
  return stringify(canonicalValue(value), {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: true,
  });
}

function parseYaml(
  root: string,
  path: string,
  diagnostics: Diagnostic[],
  checkCanonical: boolean,
): ParsedYaml | undefined {
  const source = readFileSync(resolve(root, path), "utf8");
  const documents = parseAllDocuments(source, {
    merge: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });

  if (documents.length !== 1) {
    addDiagnostic(
      diagnostics,
      path,
      "yaml/document-count",
      `expected exactly one YAML document, found ${documents.length}`,
    );
    return undefined;
  }

  const document = documents[0];
  if (!document) return undefined;
  for (const error of [...document.errors, ...document.warnings]) {
    addDiagnostic(diagnostics, path, "yaml/parse", error.message.split(" at line ")[0] ?? error.message);
  }
  if (document.errors.length > 0) return undefined;

  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    addDiagnostic(
      diagnostics,
      path,
      "yaml/parse",
      error instanceof Error ? error.message : "could not parse YAML",
    );
    return undefined;
  }

  if (checkCanonical && source !== formatYaml(data)) {
    addDiagnostic(
      diagnostics,
      path,
      "format/non-canonical",
      "YAML is not in canonical form; run bun run corpus:format",
    );
  }

  return { data, kind: kindFromPath(path), path, source };
}

function schemaErrorMessage(error: ErrorObject): string {
  const location = error.instancePath || "/";
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    return `${location} contains unknown field ${JSON.stringify(property)}`;
  }
  if (error.keyword === "unevaluatedProperties") {
    const property = String(error.params.unevaluatedProperty);
    return `${location} contains unknown field ${JSON.stringify(property)}`;
  }
  return `${location} ${error.message ?? `failed ${error.keyword}`}`;
}

function validateSchema(
  parsed: ParsedYaml,
  validator: ValidateFunction,
  diagnostics: Diagnostic[],
): void {
  if (validator(parsed.data)) return;
  for (const error of validator.errors ?? []) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      `schema/${error.keyword}`,
      schemaErrorMessage(error),
      error.instancePath,
    );
  }
}

function validateSafeSegment(
  diagnostics: Diagnostic[],
  path: string,
  segment: string | undefined,
  label: string,
): void {
  if (!segment || !SAFE_SEGMENT.test(segment)) {
    addDiagnostic(
      diagnostics,
      path,
      "path/non-canonical",
      `${label} must be lowercase kebab-case`,
    );
  }
}

function validateEntityPath(parsed: ParsedYaml, diagnostics: Diagnostic[]): void {
  const parts = parsed.path.split("/");
  const data = asRecord(parsed.data) as EntityData | undefined;

  if (parsed.kind === "resource") {
    if (parts.length < 3) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "path/layout",
        "resource paths must be resources/<section>[/<section>...]/<slug>.yaml",
      );
      return;
    }
    for (const section of parts.slice(1, -1)) {
      validateSafeSegment(diagnostics, parsed.path, section, "section path segment");
    }
    const stem = parts.at(-1)?.replace(/\.ya?ml$/, "");
    validateSafeSegment(diagnostics, parsed.path, stem, "filename stem");
    if (typeof data?.slug === "string" && stem !== data.slug) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "path/slug-mismatch",
        `filename stem ${JSON.stringify(stem)} does not match slug ${JSON.stringify(data.slug)}`,
      );
    }
    return;
  }

  if (parsed.kind === "mastery") {
    if (parts.length !== 3) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "path/layout",
        "mastery paths must be masteries/<group>/<slug>.yaml",
      );
      return;
    }
    validateSafeSegment(diagnostics, parsed.path, parts[1], "group path segment");
    const stem = parts[2]?.replace(/\.ya?ml$/, "");
    validateSafeSegment(diagnostics, parsed.path, stem, "filename stem");
    if (typeof data?.slug === "string" && stem !== data.slug) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "path/slug-mismatch",
        `filename stem ${JSON.stringify(stem)} does not match slug ${JSON.stringify(data.slug)}`,
      );
    }
    return;
  }

  if (parsed.kind === "record") {
    if (parts.length !== 4) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "path/layout",
        "record paths must be records/<record_type>/<id-shard>/<id>.yaml",
      );
      return;
    }
    const [_, recordType, shard, filename] = parts;
    const stem = filename?.replace(/\.ya?ml$/, "");
    if (typeof data?.entity_type === "string" && recordType !== data.entity_type) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "path/record-type-mismatch",
        `path record type ${JSON.stringify(recordType)} does not match entity_type ${JSON.stringify(data.entity_type)}`,
      );
    }
    if (typeof data?.id === "string") {
      if (stem !== data.id) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "path/id-mismatch",
          `filename stem ${JSON.stringify(stem)} does not match id ${JSON.stringify(data.id)}`,
        );
      }
      const expectedShard = data.id.slice(2, 4);
      if (shard !== expectedShard) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "path/shard-mismatch",
          `path shard ${JSON.stringify(shard)} does not match ID shard ${JSON.stringify(expectedShard)}`,
        );
      }
    }
    return;
  }

  if (parts.length !== 3) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      "path/layout",
      "manifest paths must be manifests/<source>/<batch-id>.yaml",
    );
    return;
  }
  const manifest = asRecord(parsed.data) as ManifestData | undefined;
  const source = parts[1];
  const batchId = parts[2]?.replace(/\.ya?ml$/, "");
  validateSafeSegment(diagnostics, parsed.path, source, "manifest source path segment");
  validateSafeSegment(diagnostics, parsed.path, batchId, "manifest batch filename");
  if (typeof manifest?.source === "string" && source !== manifest.source) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      "path/source-mismatch",
      `path source ${JSON.stringify(source)} does not match source ${JSON.stringify(manifest.source)}`,
    );
  }
  if (typeof manifest?.batch_id === "string" && batchId !== manifest.batch_id) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      "path/batch-mismatch",
      `filename ${JSON.stringify(batchId)} does not match batch_id ${JSON.stringify(manifest.batch_id)}`,
    );
  }
}

function validateExerciseBoundary(parsed: ParsedYaml, diagnostics: Diagnostic[]): void {
  if (parsed.kind !== "resource" || !parsed.path.startsWith(EXERCISE_SECTION)) return;
  const stem = parsed.path.slice(EXERCISE_SECTION.length).replace(/\.ya?ml$/, "");
  if (EXERCISE_SLUGS.has(stem)) return;

  const allowed = EXERCISE_RESOURCE_SLUGS.map((slug) => JSON.stringify(slug)).join(", ");
  addDiagnostic(
    diagnostics,
    parsed.path,
    "path/exercise-boundary",
    `exercise resources are limited to the published types ${allowed}; named activities are app-owned`,
  );
}

function validateTypedId(parsed: ParsedYaml, diagnostics: Diagnostic[]): void {
  if (parsed.kind === "manifest") return;
  const data = asRecord(parsed.data) as EntityData | undefined;
  if (typeof data?.id !== "string" || typeof data.entity_type !== "string") return;

  const expectedPrefix = TYPE_PREFIXES[data.entity_type as keyof typeof TYPE_PREFIXES];
  if (expectedPrefix && !data.id.startsWith(expectedPrefix)) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      "id/type-prefix",
      `entity_type ${JSON.stringify(data.entity_type)} requires ID prefix ${expectedPrefix}`,
    );
  }

  const isRecordType = RECORD_TYPES.has(data.entity_type);
  if (parsed.kind === "record" && !isRecordType) {
    addDiagnostic(diagnostics, parsed.path, "id/domain", "record entities must use a record-domain type and ID");
  }
  if ((parsed.kind === "resource" || parsed.kind === "mastery") && isRecordType) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      "id/domain",
      `${parsed.kind} entities must use a curated-domain type and ID`,
    );
  }
  if (!TYPED_ID.test(data.id)) {
    addDiagnostic(
      diagnostics,
      parsed.path,
      "id/format",
      "ID must be a registered two-character prefix followed by six Crockford Base32 characters",
    );
  }
}

function validateLocalReferences(parsed: ParsedYaml, diagnostics: Diagnostic[]): void {
  if (parsed.kind === "manifest") return;
  const data = asRecord(parsed.data) as EntityData | undefined;
  const references = Array.isArray(data?.references) ? data.references : [];
  const referenceIds = new Set<string>();
  for (const reference of references) {
    const id = asRecord(reference)?.id;
    if (typeof id !== "string") continue;
    if (referenceIds.has(id)) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "reference/duplicate-id",
        `reference ID ${JSON.stringify(id)} is duplicated within the entity`,
      );
    }
    referenceIds.add(id);
  }

  const claimIds = new Set<string>();
  const claims = Array.isArray(data?.claims) ? data.claims : [];
  for (const claim of claims) {
    const record = asRecord(claim);
    const id = record?.id;
    if (typeof id === "string") {
      if (claimIds.has(id)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "claim/duplicate-id",
          `claim ID ${JSON.stringify(id)} is duplicated within the entity`,
        );
      }
      claimIds.add(id);
    }
    const cited = Array.isArray(record?.references) ? record.references : [];
    for (const referenceId of cited) {
      if (typeof referenceId === "string" && !referenceIds.has(referenceId)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "reference/broken-claim-link",
          `claim references missing local reference ${JSON.stringify(referenceId)}`,
        );
      }
    }
  }
}

function validateAssociationClaims(parsed: ParsedYaml, diagnostics: Diagnostic[]): void {
  if (parsed.kind !== "resource") return;
  const data = asRecord(parsed.data) as EntityData | undefined;
  const localClaimIds = new Set(
    (Array.isArray(data?.claims) ? data.claims : [])
      .map((claim) => asRecord(claim)?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const associations = Array.isArray(data?.associations) ? data.associations : [];

  for (const item of associations) {
    const association = asRecord(item);
    const associationId = association?.id;
    const targets = Array.isArray(association?.claims) ? association.claims : [];
    const targetIds = new Set(targets.filter((id): id is string => typeof id === "string"));
    for (const claimId of targetIds) {
      if (localClaimIds.has(claimId)) continue;
      addDiagnostic(
        diagnostics,
        parsed.path,
        "association/broken-claim-link",
        `association ${JSON.stringify(associationId)} targets missing local claim ${JSON.stringify(claimId)}`,
      );
    }
  }
}

function validateRecordFacts(parsed: ParsedYaml, diagnostics: Diagnostic[]): void {
  if (parsed.kind !== "record") return;
  const facts = (asRecord(parsed.data) as EntityData | undefined)?.facts;
  if (!Array.isArray(facts)) return;

  for (const item of facts) {
    const fact = asRecord(item);
    if (fact?.kind !== "dose_range") continue;
    const range = asRecord(fact.range);
    if (typeof range?.minimum !== "number" || typeof range.maximum !== "number") continue;
    if (range.minimum <= range.maximum) continue;
    addDiagnostic(
      diagnostics,
      parsed.path,
      "fact/range-order",
      `dose range minimum ${range.minimum} must not exceed maximum ${range.maximum}`,
    );
  }
}

function validateMarkdownPairing(
  root: string,
  scanned: ScannedCorpus,
  diagnostics: Diagnostic[],
): void {
  const yamlPaths = new Set(scanned.yaml.filter((path) => path.endsWith(".yaml")));
  for (const markdownPath of scanned.markdown) {
    const topLevel = markdownPath.split("/", 1)[0] ?? "";
    if (!ENTITY_DIRECTORIES.has(topLevel)) {
      addDiagnostic(
        diagnostics,
        markdownPath,
        "pairing/unsupported-markdown",
        "import manifests cannot have Markdown bodies",
      );
      continue;
    }

    const yamlPath = markdownPath.replace(/\.md$/, ".yaml");
    if (!yamlPaths.has(yamlPath)) {
      addDiagnostic(
        diagnostics,
        markdownPath,
        "pairing/orphan-markdown",
        `Markdown body requires same-stem YAML peer ${JSON.stringify(yamlPath)}`,
      );
      continue;
    }

    const markdown = readFileSync(resolve(root, markdownPath), "utf8");
    if (/^(?:\uFEFF)?---[\t ]*(?:\r?\n|$)/.test(markdown)) {
      addDiagnostic(
        diagnostics,
        markdownPath,
        "markdown/frontmatter",
        "Markdown owns narrative body only and must not contain YAML frontmatter",
      );
    }
  }
}

function validateGlobalInvariants(parsedFiles: ParsedYaml[], diagnostics: Diagnostic[]): void {
  const entities = parsedFiles.filter((parsed) => parsed.kind !== "manifest");
  const ids = new Map<string, string[]>();
  const identifiers = new Map<string, string[]>();
  const recordsById = new Map<string, EntityData[]>();
  const sourceOccurrences = new Map<
    string,
    Array<{ entityId: string; namespace: string; path: string; sourceRecordId: string }>
  >();

  for (const parsed of entities) {
    const data = asRecord(parsed.data) as EntityData | undefined;
    if (typeof data?.id === "string") {
      const paths = ids.get(data.id) ?? [];
      paths.push(parsed.path);
      ids.set(data.id, paths);
      if (parsed.kind === "record") {
        const records = recordsById.get(data.id) ?? [];
        records.push(data);
        recordsById.set(data.id, records);
      }
    }
    const entityIdentifiers = Array.isArray(data?.identifiers) ? data.identifiers : [];
    for (const item of entityIdentifiers) {
      const identifier = asRecord(item);
      if (typeof identifier?.kind !== "string" || typeof identifier.value !== "string") continue;
      const key = `${identifier.kind}\u0000${identifier.value}`;
      const paths = identifiers.get(key) ?? [];
      paths.push(parsed.path);
      identifiers.set(key, paths);
    }

    if (parsed.kind !== "record" || typeof data?.id !== "string" || !Array.isArray(data.sources)) {
      continue;
    }
    for (const item of data.sources) {
      const source = asRecord(item);
      if (typeof source?.namespace !== "string" || typeof source.source_record_id !== "string") {
        continue;
      }
      const key = `${source.namespace}\u0000${source.source_record_id}`;
      const occurrences = sourceOccurrences.get(key) ?? [];
      occurrences.push({
        entityId: data.id,
        namespace: source.namespace,
        path: parsed.path,
        sourceRecordId: source.source_record_id,
      });
      sourceOccurrences.set(key, occurrences);
    }
  }

  for (const [id, paths] of ids) {
    if (paths.length < 2) continue;
    const locations = [...paths].sort().join(", ");
    for (const path of paths) {
      addDiagnostic(
        diagnostics,
        path,
        "id/duplicate",
        `typed ID ${JSON.stringify(id)} is duplicated across: ${locations}`,
      );
    }
  }

  for (const [key, paths] of identifiers) {
    if (paths.length < 2) continue;
    const [kind, value] = key.split("\u0000");
    const locations = [...paths].sort().join(", ");
    for (const path of paths) {
      addDiagnostic(
        diagnostics,
        path,
        "identifier/duplicate",
        `authoritative identifier ${JSON.stringify(`${kind}:${value}`)} is duplicated across: ${locations}`,
      );
    }
  }

  for (const [key, occurrences] of sourceOccurrences) {
    if (occurrences.length < 2) continue;
    const [namespace, sourceRecordId] = key.split("\u0000");
    const locations = [...new Set(occurrences.map((item) => item.path))].sort();
    const sourceIdentifier = JSON.stringify(`${namespace}:${sourceRecordId}`);
    for (const path of locations) {
      addDiagnostic(
        diagnostics,
        path,
        "source/duplicate-identifier",
        `source identifier ${sourceIdentifier} is duplicated across: ${locations.join(", ")}`,
      );
    }
  }

  const knownIds = new Set(ids.keys());
  for (const parsed of entities) {
    const links = (asRecord(parsed.data) as EntityData | undefined)?.links;
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      const entityId = asRecord(link)?.entity_id;
      if (typeof entityId === "string" && !knownIds.has(entityId)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "link/broken",
          `cross-entity link targets missing entity ${JSON.stringify(entityId)}`,
        );
      }
    }
  }

  const manifests = parsedFiles.filter((item) => item.kind === "manifest");
  const manifestCoverage = new Set<string>();
  for (const parsed of manifests) {
    const manifest = asRecord(parsed.data) as ManifestData | undefined;
    if (typeof manifest?.source_namespace !== "string" || !Array.isArray(manifest.records)) {
      continue;
    }
    for (const recordId of manifest.records) {
      if (typeof recordId === "string") {
        manifestCoverage.add(`${manifest.source_namespace}\u0000${recordId}`);
      }
    }
  }

  for (const occurrences of sourceOccurrences.values()) {
    const reported = new Set<string>();
    for (const occurrence of occurrences) {
      const coverageKey = `${occurrence.namespace}\u0000${occurrence.entityId}`;
      const diagnosticKey = `${occurrence.path}\u0000${coverageKey}`;
      if (manifestCoverage.has(coverageKey) || reported.has(diagnosticKey)) continue;
      reported.add(diagnosticKey);
      const sourceIdentifier = JSON.stringify(
        `${occurrence.namespace}:${occurrence.sourceRecordId}`,
      );
      addDiagnostic(
        diagnostics,
        occurrence.path,
        "manifest/missing-source-coverage",
        `source ${sourceIdentifier} is not covered by a matching source_namespace manifest listing record ${JSON.stringify(occurrence.entityId)}`,
      );
    }
  }

  for (const parsed of manifests) {
    const manifest = asRecord(parsed.data) as ManifestData | undefined;
    const records = Array.isArray(manifest?.records) ? manifest.records : [];
    const counts = asRecord(manifest?.counts);
    if (typeof counts?.records === "number" && counts.records !== records.length) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "manifest/record-count",
        `counts.records is ${counts.records}, but records lists ${records.length} record(s)`,
      );
    }

    if (typeof counts?.sources === "number" && typeof manifest?.source_namespace === "string") {
      let matchingSources = 0;
      for (const recordId of records) {
        if (typeof recordId !== "string") continue;
        for (const record of recordsById.get(recordId) ?? []) {
          if (!Array.isArray(record.sources)) continue;
          matchingSources += record.sources.filter(
            (item) => asRecord(item)?.namespace === manifest.source_namespace,
          ).length;
        }
      }
      if (counts.sources !== matchingSources) {
        const entryLabel = matchingSources === 1 ? "entry" : "entries";
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/source-count",
          `counts.sources is ${counts.sources}, but listed records contain ${matchingSources} source ${entryLabel} for namespace ${JSON.stringify(manifest.source_namespace)}`,
        );
      }
    }

    const quarantine = asRecord(manifest?.quarantine);
    const reasons = Array.isArray(quarantine?.reasons) ? quarantine.reasons : [];
    const reasonCount = reasons.reduce((total, item) => {
      const count = asRecord(item)?.count;
      return typeof count === "number" ? total + count : total;
    }, 0);
    if (typeof quarantine?.total === "number" && quarantine.total !== reasonCount) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "manifest/quarantine-total",
        `quarantine.total is ${quarantine.total}, but reason counts sum to ${reasonCount}`,
      );
    }

    const expectedPrefix =
      typeof manifest?.record_type === "string"
        ? TYPE_PREFIXES[manifest.record_type as keyof typeof TYPE_PREFIXES]
        : undefined;
    for (const recordId of records) {
      if (typeof recordId !== "string") continue;
      if (!knownIds.has(recordId)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/missing-record",
          `manifest lists missing record ${JSON.stringify(recordId)}`,
        );
      }
      if (expectedPrefix && !recordId.startsWith(expectedPrefix)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/record-type",
          `manifest record_type requires ID prefix ${expectedPrefix}, received ${JSON.stringify(recordId)}`,
        );
      }
    }
  }
}

/**
 * The fields a resource reference may carry only through a reference import
 * manifest. Bibliographic identity is third-party metadata, and the
 * contribution contract forbids hand-transcribing it into YAML — so a
 * reference carrying any of these must be covered by a manifest entry stating
 * the exact same imported identity, including the exact absence of authors or
 * container title when Crossref omitted one. Every manifest entry must resolve
 * to a real local reference. Title, date, and URL stay curated and are not
 * checked here.
 */
const IMPORTED_REFERENCE_FIELDS = ["doi", "authors", "container_title"] as const;

function validateReferenceEnrichment(
  parsedFiles: ParsedYaml[],
  diagnostics: Diagnostic[],
): void {
  const referencesByResource = new Map<string, Map<string, Record<string, unknown>>>();
  for (const parsed of parsedFiles) {
    if (parsed.kind !== "resource") continue;
    const data = asRecord(parsed.data) as EntityData | undefined;
    if (typeof data?.id !== "string") continue;
    const references =
      referencesByResource.get(data.id) ?? new Map<string, Record<string, unknown>>();
    for (const item of Array.isArray(data.references) ? data.references : []) {
      const reference = asRecord(item);
      if (typeof reference?.id !== "string") continue;
      references.set(reference.id, reference);
    }
    referencesByResource.set(data.id, references);
  }

  const sameOptionalAuthors = (
    local: Record<string, unknown>,
    imported: Record<string, unknown>,
  ): boolean => {
    const localPresent = Object.hasOwn(local, "authors");
    const importedPresent = Object.hasOwn(imported, "authors");
    if (localPresent !== importedPresent) return false;
    if (!localPresent) return true;
    const localAuthors = local.authors;
    const importedAuthors = imported.authors;
    if (!Array.isArray(localAuthors) || !Array.isArray(importedAuthors)) return false;
    return (
      localAuthors.length === importedAuthors.length &&
      localAuthors.every((author, index) => author === importedAuthors[index])
    );
  };
  const sameOptionalContainer = (
    local: Record<string, unknown>,
    imported: Record<string, unknown>,
  ): boolean =>
    Object.hasOwn(local, "container_title") === Object.hasOwn(imported, "container_title") &&
    (!Object.hasOwn(local, "container_title") ||
      local.container_title === imported.container_title);
  const describeField = (value: Record<string, unknown>, field: string): string =>
    Object.hasOwn(value, field) ? (JSON.stringify(value[field]) ?? "an invalid value") : "none";

  const coverage = new Set<string>();
  for (const parsed of parsedFiles) {
    if (parsed.kind !== "manifest") continue;
    const manifest = asRecord(parsed.data) as ManifestData | undefined;
    if (manifest?.kind !== "reference_import_manifest") continue;

    const entries = Array.isArray(manifest.references) ? manifest.references : [];
    const resourceIds = new Set<string>();
    for (const item of entries) {
      const entry = asRecord(item);
      if (!entry) continue;
      const resourceId = entry?.resource_id;
      const referenceId = entry?.reference_id;
      const doi = entry?.doi;
      if (
        typeof resourceId !== "string" ||
        typeof referenceId !== "string" ||
        typeof doi !== "string"
      ) {
        continue;
      }
      resourceIds.add(resourceId);
      const label = JSON.stringify(`${resourceId}:${referenceId}`);
      const localReferences = referencesByResource.get(resourceId);
      if (!localReferences?.has(referenceId)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/missing-reference",
          `manifest lists missing resource reference ${label}`,
        );
        continue;
      }
      const local = localReferences.get(referenceId)!;
      let exactMatch = true;
      if (local.doi !== doi) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/reference-doi-mismatch",
          `manifest states DOI ${JSON.stringify(doi)} for reference ${label}, but the resource carries ${describeField(local, "doi")}`,
        );
        exactMatch = false;
      }
      if (!sameOptionalAuthors(local, entry)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/reference-authors-mismatch",
          `manifest states authors ${describeField(entry, "authors")} for reference ${label}, but the resource carries ${describeField(local, "authors")}`,
        );
        exactMatch = false;
      }
      if (!sameOptionalContainer(local, entry)) {
        addDiagnostic(
          diagnostics,
          parsed.path,
          "manifest/reference-container-title-mismatch",
          `manifest states container_title ${describeField(entry, "container_title")} for reference ${label}, but the resource carries ${describeField(local, "container_title")}`,
        );
        exactMatch = false;
      }
      if (exactMatch) coverage.add(`${resourceId}\u0000${referenceId}\u0000${doi}`);
    }

    const counts = asRecord(manifest.counts);
    if (typeof counts?.references === "number" && counts.references !== entries.length) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "manifest/reference-count",
        `counts.references is ${counts.references}, but references lists ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
      );
    }
    if (typeof counts?.resources === "number" && counts.resources !== resourceIds.size) {
      addDiagnostic(
        diagnostics,
        parsed.path,
        "manifest/resource-count",
        `counts.resources is ${counts.resources}, but references cover ${resourceIds.size} resource(s)`,
      );
    }
  }

  for (const parsed of parsedFiles) {
    if (parsed.kind !== "resource") continue;
    const data = asRecord(parsed.data) as EntityData | undefined;
    if (typeof data?.id !== "string") continue;
    for (const item of Array.isArray(data.references) ? data.references : []) {
      const reference = asRecord(item);
      if (!reference || !IMPORTED_REFERENCE_FIELDS.some((field) => field in reference)) {
        continue;
      }
      const referenceId = typeof reference.id === "string" ? reference.id : undefined;
      const doi = typeof reference.doi === "string" ? reference.doi : undefined;
      if (
        referenceId !== undefined &&
        doi !== undefined &&
        coverage.has(`${data.id}\u0000${referenceId}\u0000${doi}`)
      ) {
        continue;
      }
      addDiagnostic(
        diagnostics,
        parsed.path,
        "manifest/missing-reference-coverage",
        `reference ${JSON.stringify(referenceId ?? "(without id)")} carries imported bibliographic identity not covered by a reference import manifest entry stating its DOI`,
      );
    }
  }
}

export function validateCorpus(rootPath: string): ValidationResult {
  const root = resolve(rootPath);
  const scanned = scanCorpus(root);
  const diagnostics = [...scanned.diagnostics];
  const parsedFiles: ParsedYaml[] = [];
  const validators = createSchemaValidators();

  for (const path of scanned.yaml) {
    const parsed = parseYaml(root, path, diagnostics, true);
    if (!parsed) continue;
    parsedFiles.push(parsed);
    validateSchema(parsed, validators[parsed.kind], diagnostics);
    validateEntityPath(parsed, diagnostics);
    validateExerciseBoundary(parsed, diagnostics);
    validateTypedId(parsed, diagnostics);
    validateLocalReferences(parsed, diagnostics);
    validateAssociationClaims(parsed, diagnostics);
    validateRecordFacts(parsed, diagnostics);
  }

  validateMarkdownPairing(root, scanned, diagnostics);
  validateGlobalInvariants(parsedFiles, diagnostics);
  validateReferenceEnrichment(parsedFiles, diagnostics);
  sortDiagnostics(diagnostics);
  const { errors, warnings } = partitionDiagnostics(diagnostics);
  return {
    diagnostics: errors,
    filesChecked: scanned.yaml.length + scanned.markdown.length,
    ok: errors.length === 0,
    warnings,
  };
}

export function checkCorpusFormatting(rootPath: string): ValidationResult {
  const root = resolve(rootPath);
  const scanned = scanCorpus(root);
  const diagnostics = [...scanned.diagnostics];
  for (const path of scanned.yaml) parseYaml(root, path, diagnostics, true);
  sortDiagnostics(diagnostics);
  return {
    diagnostics,
    filesChecked: scanned.yaml.length,
    ok: diagnostics.length === 0,
    warnings: [],
  };
}

export function formatCorpus(rootPath: string): ValidationResult & { filesFormatted: number } {
  const root = resolve(rootPath);
  const scanned = scanCorpus(root);
  const diagnostics = [...scanned.diagnostics];
  let filesFormatted = 0;

  for (const path of scanned.yaml) {
    if (path.endsWith(".yml")) continue;
    const parsed = parseYaml(root, path, diagnostics, false);
    if (!parsed) continue;
    const canonical = formatYaml(parsed.data);
    if (canonical !== parsed.source) {
      writeFileSync(resolve(root, path), canonical, "utf8");
      filesFormatted += 1;
    }
  }

  sortDiagnostics(diagnostics);
  return {
    diagnostics,
    filesChecked: scanned.yaml.length,
    filesFormatted,
    ok: diagnostics.length === 0,
    warnings: [],
  };
}
