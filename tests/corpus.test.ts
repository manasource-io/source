import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  EXERCISE_RESOURCE_SLUGS,
  checkCorpusFormatting,
  createSchemaValidators,
  formatCorpus,
  formatYaml,
  validateCorpus,
} from "../src/corpus.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures", "valid");
const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const temporaryRoots: string[] = [];

function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), "manasource-corpus-test-"));
  temporaryRoots.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function readYaml(root: string, path: string): Record<string, unknown> {
  return parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;
}

function writeYaml(root: string, path: string, value: unknown): void {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, formatYaml(value), "utf8");
}

function codes(root: string): string[] {
  return validateCorpus(root).diagnostics.map((diagnostic) => diagnostic.code);
}

function expectRequiredFields(
  kind: "manifest" | "mastery" | "record" | "resource",
  path: string,
  fields: string[],
): void {
  const validator = createSchemaValidators()[kind];
  const value = readYaml(FIXTURE, path);
  for (const field of fields) {
    const candidate = structuredClone(value);
    delete candidate[field];
    expect(validator(candidate)).toBe(false);
    expect(
      validator.errors?.some(
        (error) => error.keyword === "required" && error.params.missingProperty === field,
      ),
    ).toBe(true);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("schemas", () => {
  test("all schemas compile and a complete fixture validates", () => {
    expect(() => createSchemaValidators()).not.toThrow();
    const result = validateCorpus(FIXTURE);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("requires the resource-specific editorial fields and rejects legacy code", () => {
    expectRequiredFields("resource", "resources/exercise/aerobic-exercise.yaml", [
      "provenance",
      "category",
      "description",
      "score",
      "associations",
      "claims",
      "references",
    ]);
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.code = "EX1";
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    const diagnostics = validateCorpus(root).diagnostics;
    expect(diagnostics.some((item) => item.message.includes('unknown field "code"'))).toBe(true);
  });

  test("requires a score only once a resource leaves draft", () => {
    const validator = createSchemaValidators().resource;
    const resource = readYaml(FIXTURE, "resources/exercise/aerobic-exercise.yaml");
    delete resource.score;

    resource.lifecycle = "draft";
    expect(validator(resource)).toBe(true);

    for (const lifecycle of ["published", "retired"]) {
      resource.lifecycle = lifecycle;
      expect(validator(resource)).toBe(false);
      expect(
        validator.errors?.some(
          (error) => error.keyword === "required" && error.params.missingProperty === "score",
        ),
      ).toBe(true);
    }
  });

  test("accepts optional resource-local association claim targets and rejects malformed targets", () => {
    const validator = createSchemaValidators().resource;
    const resource = readYaml(FIXTURE, "resources/exercise/aerobic-exercise.yaml");
    const associations = resource.associations as Array<Record<string, unknown>>;
    associations[0]!.claims = ["aerobic-exercise-supports-health"];
    expect(validator(resource)).toBe(true);

    const withoutTargets = structuredClone(resource);
    const associationsWithoutTargets = withoutTargets.associations as Array<
      Record<string, unknown>
    >;
    delete associationsWithoutTargets[0]!.claims;
    expect(validator(withoutTargets)).toBe(true);

    const invalidTargets: Array<[unknown, string]> = [
      [[null], "type"],
      [[], "minItems"],
      [[""], "pattern"],
      [["other-resource/aerobic-exercise-supports-health"], "pattern"],
      [["aerobic-exercise-supports-health", "aerobic-exercise-supports-health"], "uniqueItems"],
    ];
    for (const [targets, keyword] of invalidTargets) {
      const candidate = structuredClone(resource);
      const candidateAssociations = candidate.associations as Array<Record<string, unknown>>;
      candidateAssociations[0]!.claims = targets;
      expect(validator(candidate)).toBe(false);
      expect(validator.errors?.some((error) => error.keyword === keyword)).toBe(true);
    }
  });

  test("accepts curated input type and pairing metadata", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.input_type = "score";
    const pairing = [
      {
        condition: "cooked",
        note: "Dietary fat increases lycopene absorption.",
        resource: "nutrition/food/olive-oil",
        type: "synergy",
      },
      { note: "Take with a meal containing dietary fat.", type: "requisite" },
    ];
    resource.pairing = pairing;
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    expect(validateCorpus(root).diagnostics).toEqual([]);

    delete (pairing[1] as Record<string, unknown>).note;
    (pairing[0] as Record<string, unknown>).strength = 3;
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("schema/additionalProperties");
    expect(resultCodes).toContain("schema/required");
  });

  test("requires mastery description and validates canonical association slugs", () => {
    expectRequiredFields("mastery", "masteries/basics/daily-movement.yaml", [
      "provenance",
      "description",
      "associations",
    ]);
    const root = corpus();
    const mastery = readYaml(root, "masteries/basics/daily-movement.yaml");
    mastery.associations = ["Not Canonical"];
    writeYaml(root, "masteries/basics/daily-movement.yaml", mastery);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("schema/pattern");
  });

  test("requires a complete source row for each imported record", () => {
    expectRequiredFields("record", "records/food/AB/FDAB0001.yaml", [
      "canonical_name",
      "normalized_name",
      "sources",
    ]);
    const root = corpus();
    const record = readYaml(root, "records/food/AB/FDAB0001.yaml");
    record.sources = [];
    writeYaml(root, "records/food/AB/FDAB0001.yaml", record);
    expect(codes(root)).toContain("schema/minItems");

    const source = {
      namespace: "example",
      source_record_id: "12345",
      url: "http://example.org/records/12345",
    };
    record.sources = [source];
    writeYaml(root, "records/food/AB/FDAB0001.yaml", record);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("schema/required");
    expect(resultCodes).toContain("schema/pattern");
  });

  test("accepts canonical source namespaces and rejects malformed namespaces", () => {
    const validator = createSchemaValidators().record;
    const record = readYaml(FIXTURE, "records/food/AB/FDAB0001.yaml");
    expect(record.provenance).toBeUndefined();

    const validNamespaces = [
      "fixture.synthetic",
      "usda.fdc",
      "simple",
      "source_name",
      "source-name",
    ];
    for (const namespace of validNamespaces) {
      const candidate = structuredClone(record);
      const sources = candidate.sources as Array<Record<string, unknown>>;
      sources[0]!.namespace = namespace;
      expect(validator(candidate)).toBe(true);
    }

    for (const namespace of ["USDA.fdc", "usda fdc", "usda..fdc", "usda.", ".usda"]) {
      const candidate = structuredClone(record);
      const sources = candidate.sources as Array<Record<string, unknown>>;
      sources[0]!.namespace = namespace;
      expect(validator(candidate)).toBe(false);
      expect(validator.errors?.some((error) => error.keyword === "pattern")).toBe(true);
    }
  });

  test("accepts independently attributed dose-range facts and preserves canonical YAML", () => {
    const validator = createSchemaValidators().record;
    const path = "records/food/AB/FDAB0001.yaml";
    const source = readFileSync(resolve(FIXTURE, path), "utf8");
    const record = readYaml(FIXTURE, path);

    expect(validator(record)).toBe(true);
    expect(formatYaml(record)).toBe(source);
  });

  test("rejects unknown fact kinds, units, and nested fields", () => {
    const validator = createSchemaValidators().record;
    const record = readYaml(FIXTURE, "records/food/AB/FDAB0001.yaml");

    const mutations = [
      (fact: Record<string, unknown>) => {
        fact.kind = "duration_range";
      },
      (fact: Record<string, unknown>) => {
        (fact.range as Record<string, unknown>).unit = "scoops";
      },
      (fact: Record<string, unknown>) => {
        fact.note = "unstructured prose";
      },
      (fact: Record<string, unknown>) => {
        (fact.range as Record<string, unknown>).average = 375;
      },
      (fact: Record<string, unknown>) => {
        (fact.source as Record<string, unknown>).publisher = "Example";
      },
    ];

    for (const mutate of mutations) {
      const candidate = structuredClone(record);
      const facts = candidate.facts as Array<Record<string, unknown>>;
      mutate(facts[0]!);
      expect(validator(candidate)).toBe(false);
    }
  });

  test("rejects invalid dose bounds and incomplete per-fact source attribution", () => {
    const validator = createSchemaValidators().record;
    const record = readYaml(FIXTURE, "records/food/AB/FDAB0001.yaml");

    const invalidBounds: Array<["maximum" | "minimum", unknown]> = [
      ["minimum", -1],
      ["maximum", -1],
      ["minimum", "250"],
      ["maximum", "500"],
    ];
    for (const [bound, value] of invalidBounds) {
      const candidate = structuredClone(record);
      const facts = candidate.facts as Array<Record<string, unknown>>;
      (facts[0]!.range as Record<string, unknown>)[bound] = value;
      expect(validator(candidate)).toBe(false);
    }

    for (const field of ["namespace", "source_record_id", "url", "attribution"]) {
      const candidate = structuredClone(record);
      const facts = candidate.facts as Array<Record<string, unknown>>;
      delete (facts[0]!.source as Record<string, unknown>)[field];
      expect(validator(candidate)).toBe(false);
      expect(
        validator.errors?.some(
          (error) => error.keyword === "required" && error.params.missingProperty === field,
        ),
      ).toBe(true);
    }

    const invalidSourceValues: Array<[string, unknown]> = [
      ["namespace", "Example Source"],
      ["source_record_id", ""],
      ["url", "http://example.org/records/12345/dose"],
      ["attribution", ""],
    ];
    for (const [field, value] of invalidSourceValues) {
      const candidate = structuredClone(record);
      const facts = candidate.facts as Array<Record<string, unknown>>;
      (facts[0]!.source as Record<string, unknown>)[field] = value;
      expect(validator(candidate)).toBe(false);
    }
  });

  test("rejects reversed dose-range bounds", () => {
    const root = corpus();
    const path = "records/food/AB/FDAB0001.yaml";
    const record = readYaml(root, path);
    const facts = record.facts as Array<Record<string, unknown>>;
    const range = facts[0]!.range as Record<string, unknown>;
    range.minimum = 501;
    range.maximum = 500;
    writeYaml(root, path, record);

    expect(codes(root)).toContain("fact/range-order");
  });

  test("keeps record facts outside evidence semantics", () => {
    const validator = createSchemaValidators().record;
    const record = readYaml(FIXTURE, "records/food/AB/FDAB0001.yaml");

    for (const field of ["association", "claim", "evidence_score", "grade", "ranking", "score"]) {
      const candidate = structuredClone(record);
      const facts = candidate.facts as Array<Record<string, unknown>>;
      facts[0]![field] = 1;
      expect(validator(candidate)).toBe(false);
    }
  });

  test("requires paired match metadata on typed links", () => {
    const validator = createSchemaValidators().resource;
    const resource = readYaml(FIXTURE, "resources/exercise/aerobic-exercise.yaml");
    const links = resource.links as Array<Record<string, unknown>>;
    expect(validator(resource)).toBe(true);

    links[0]!.match_type = "curated";
    expect(validator(resource)).toBe(false);
    expect(validator.errors?.some((error) => error.keyword === "dependentRequired")).toBe(true);

    delete links[0]!.match_type;
    links[0]!.confidence = 1;
    expect(validator(resource)).toBe(false);
    expect(validator.errors?.some((error) => error.keyword === "dependentRequired")).toBe(true);

    links[0]!.match_type = "curated";
    expect(validator(resource)).toBe(true);
  });

  test("requires manifest batch metadata and validates semantic counts", () => {
    expectRequiredFields("manifest", "manifests/example/2026-08-02.yaml", [
      "source_namespace",
      "importer_version",
      "normalization_version",
      "counts",
      "quarantine",
    ]);
    const root = corpus();
    const manifest = readYaml(root, "manifests/example/2026-08-02.yaml");
    manifest.counts = { records: 2, sources: 1 };
    manifest.quarantine = {
      reasons: [
        { count: 1, reason: "missing_name" },
        { count: 2, reason: "invalid_identifier" },
      ],
      total: 4,
    };
    writeYaml(root, "manifests/example/2026-08-02.yaml", manifest);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("manifest/record-count");
    expect(resultCodes).toContain("manifest/quarantine-total");
  });
});

describe("corpus invariants", () => {
  test("accepts a YAML-only entity and a YAML plus Markdown pair", () => {
    const result = validateCorpus(FIXTURE);
    expect(result.ok).toBe(true);
    expect(result.filesChecked).toBe(5);
  });

  test("accepts nested canonical resource section paths", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    const markdown = readFileSync(resolve(root, "resources/exercise/aerobic-exercise.md"), "utf8");
    writeYaml(root, "resources/nutrition/food/aerobic-exercise.yaml", resource);
    writeFileSync(resolve(root, "resources/nutrition/food/aerobic-exercise.md"), markdown, "utf8");
    rmSync(resolve(root, "resources/exercise/aerobic-exercise.yaml"));
    rmSync(resolve(root, "resources/exercise/aerobic-exercise.md"));
    expect(validateCorpus(root).diagnostics).toEqual([]);
  });

  test("accepts every published exercise type slug", () => {
    for (const slug of EXERCISE_RESOURCE_SLUGS) {
      const root = corpus();
      const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
      const markdown = readFileSync(resolve(root, "resources/exercise/aerobic-exercise.md"), "utf8");
      rmSync(resolve(root, "resources/exercise/aerobic-exercise.yaml"));
      rmSync(resolve(root, "resources/exercise/aerobic-exercise.md"));
      resource.slug = slug;
      writeYaml(root, `resources/exercise/${slug}.yaml`, resource);
      writeFileSync(resolve(root, `resources/exercise/${slug}.md`), markdown, "utf8");
      expect(validateCorpus(root).diagnostics).toEqual([]);
    }
  });

  test("rejects exercise resources outside the published type allowlist", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.id = "EX000003";
    resource.slug = "running";
    resource.title = "Running";
    resource.identifiers = [];
    writeYaml(root, "resources/exercise/running.yaml", resource);
    writeFileSync(resolve(root, "resources/exercise/running.md"), "# Running\n", "utf8");

    expect(
      validateCorpus(root).diagnostics.filter((item) => item.code === "path/exercise-boundary"),
    ).toEqual([
      {
        code: "path/exercise-boundary",
        message:
          'exercise resources are limited to the published types "aerobic-exercise", "balance-coordination", "strength-training", "stretching"; named activities are app-owned',
        path: "resources/exercise/running.yaml",
      },
    ]);
  });

  test("rejects allowed exercise slugs nested below the exercise section", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.id = "EX000004";
    resource.identifiers = [];
    writeYaml(root, "resources/exercise/cardio/aerobic-exercise.yaml", resource);
    expect(codes(root)).toContain("path/exercise-boundary");
  });

  test("rejects duplicate typed IDs", () => {
    const root = corpus();
    const duplicate = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    duplicate.slug = "strength-training";
    duplicate.title = "Strength training";
    duplicate.identifiers = [];
    writeYaml(root, "resources/exercise/strength-training.yaml", duplicate);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("id/duplicate");
    expect(resultCodes).not.toContain("path/exercise-boundary");
  });

  test("rejects invalid type prefixes and cross-domain IDs", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.id = "FDAB0002";
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    const record = readYaml(root, "records/food/AB/FDAB0001.yaml");
    record.id = "EXAB0001";
    writeYaml(root, "records/food/AB/FDAB0001.yaml", record);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("id/type-prefix");
    expect(resultCodes.filter((code) => code === "schema/pattern").length).toBeGreaterThanOrEqual(2);
  });

  test("rejects unknown fields, malformed URLs, and malformed dates", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.unexpected = true;
    const references = resource.references as Array<Record<string, unknown>>;
    references[0]!.url = "not a url";
    const provenance = resource.provenance as Record<string, unknown>;
    provenance.created_at = "2026-02-30";
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    const result = validateCorpus(root);
    expect(result.diagnostics.some((item) => item.message.includes("unknown field"))).toBe(true);
    expect(result.diagnostics.filter((item) => item.code === "schema/format")).toHaveLength(2);
  });

  test("rejects duplicate authoritative identifiers by kind and value", () => {
    const root = corpus();
    const mastery = readYaml(root, "masteries/basics/daily-movement.yaml");
    mastery.identifiers = [{ kind: "source_slug", value: "exercise:aerobic-exercise" }];
    writeYaml(root, "masteries/basics/daily-movement.yaml", mastery);
    expect(codes(root)).toContain("identifier/duplicate");
  });

  test("rejects broken cross-entity links", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.links = [{ entity_id: "EX00000Z", relationship: "related_to" }];
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    expect(codes(root)).toContain("link/broken");
  });

  test("rejects unsafe paths and slug mismatches", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    resource.slug = "different-slug";
    writeYaml(root, "resources/Bad_Path/aerobic-exercise.yaml", resource);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("path/non-canonical");
    expect(resultCodes).toContain("path/slug-mismatch");
  });

  test("rejects incorrect record type, shard, and filename paths", () => {
    const root = corpus();
    const record = readYaml(root, "records/food/AB/FDAB0001.yaml");
    writeYaml(root, "records/compound/ZZ/FDAB0002.yaml", record);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("path/record-type-mismatch");
    expect(resultCodes).toContain("path/shard-mismatch");
    expect(resultCodes).toContain("path/id-mismatch");
  });

  test("rejects orphan Markdown and structured frontmatter", () => {
    const root = corpus();
    writeFileSync(resolve(root, "resources/exercise/orphan.md"), "# Orphan\n", "utf8");
    writeFileSync(
      resolve(root, "resources/exercise/aerobic-exercise.md"),
      "---\ntitle: Duplicated\n---\n\n# Aerobic exercise\n",
      "utf8",
    );
    const resultCodes = codes(root);
    expect(resultCodes).toContain("pairing/orphan-markdown");
    expect(resultCodes).toContain("markdown/frontmatter");
  });

  test("rejects multiple logical entities in one YAML file", () => {
    const root = corpus();
    const path = resolve(root, "resources/exercise/aerobic-exercise.yaml");
    const source = readFileSync(path, "utf8");
    writeFileSync(path, `${source}---\n${source}`, "utf8");
    expect(codes(root)).toContain("yaml/document-count");
  });

  test("rejects broken local claim references", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    const claims = resource.claims as Array<Record<string, unknown>>;
    claims[0]!.references = ["missing-study"];
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    expect(codes(root)).toContain("reference/broken-claim-link");
  });

  test("rejects association targets that do not resolve to resource-local claims", () => {
    const root = corpus();
    const path = "resources/exercise/aerobic-exercise.yaml";
    const resource = readYaml(root, path);
    const associations = resource.associations as Array<Record<string, unknown>>;
    associations[0]!.claims = ["missing-claim"];
    writeYaml(root, path, resource);

    expect(
      validateCorpus(root).diagnostics.filter(
        (diagnostic) => diagnostic.code === "association/broken-claim-link",
      ),
    ).toEqual([
      {
        code: "association/broken-claim-link",
        message:
          'association "cardio-health" targets missing local claim "missing-claim"',
        path,
      },
    ]);
  });

  test("validates optional local reference IDs only when citations are present", () => {
    const root = corpus();
    const resource = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    const claims = resource.claims as Array<Record<string, unknown>>;
    const references = resource.references as Array<Record<string, unknown>>;
    references[0]!.id = "example-study";
    claims[0]!.references = ["example-study"];
    writeYaml(root, "resources/exercise/aerobic-exercise.yaml", resource);
    expect(validateCorpus(root).ok).toBe(true);
  });

  test("rejects manifests that list absent or wrong-type records", () => {
    const root = corpus();
    const manifest = readYaml(root, "manifests/example/2026-08-02.yaml");
    manifest.records = ["CPZZ0001"];
    writeYaml(root, "manifests/example/2026-08-02.yaml", manifest);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("manifest/missing-record");
    expect(resultCodes).toContain("manifest/record-type");
  });

  test("links record sources to manifests by namespace and record ID", () => {
    const root = corpus();
    const record = readYaml(root, "records/food/AB/FDAB0001.yaml");
    const sources = record.sources as Array<Record<string, unknown>>;
    sources[0]!.namespace = "fixture.synthetic";
    writeYaml(root, "records/food/AB/FDAB0001.yaml", record);
    const manifest = readYaml(root, "manifests/example/2026-08-02.yaml");
    manifest.source_namespace = "fixture.synthetic";
    writeYaml(root, "manifests/example/2026-08-02.yaml", manifest);
    expect(validateCorpus(root).diagnostics).toEqual([]);
  });

  test("rejects duplicate source identifiers across records", () => {
    const root = corpus();
    const duplicate = readYaml(root, "records/food/AB/FDAB0001.yaml");
    duplicate.id = "FDCD0002";
    duplicate.slug = "other-food";
    duplicate.title = "Other food";
    duplicate.identifiers = [];
    writeYaml(root, "records/food/CD/FDCD0002.yaml", duplicate);
    const manifest = readYaml(root, "manifests/example/2026-08-02.yaml");
    manifest.records = ["FDAB0001", "FDCD0002"];
    manifest.counts = { records: 2, sources: 2 };
    writeYaml(root, "manifests/example/2026-08-02.yaml", manifest);

    const diagnostics = validateCorpus(root).diagnostics.filter(
      (item) => item.code === "source/duplicate-identifier",
    );
    expect(diagnostics.map((item) => item.path)).toEqual([
      "records/food/AB/FDAB0001.yaml",
      "records/food/CD/FDCD0002.yaml",
    ]);
  });

  test("rejects record sources without matching manifest coverage", () => {
    const root = corpus();
    const record = readYaml(root, "records/food/AB/FDAB0001.yaml");
    const sources = record.sources as Array<Record<string, unknown>>;
    sources[0]!.namespace = "uncovered.source";
    writeYaml(root, "records/food/AB/FDAB0001.yaml", record);
    expect(codes(root)).toContain("manifest/missing-source-coverage");
  });

  test("validates manifest source counts against matching source entries", () => {
    const root = corpus();
    const manifest = readYaml(root, "manifests/example/2026-08-02.yaml");
    manifest.counts = { records: 1, sources: 2 };
    writeYaml(root, "manifests/example/2026-08-02.yaml", manifest);
    expect(codes(root)).toContain("manifest/source-count");
  });

  test("returns stable path-sorted diagnostics", () => {
    const root = corpus();
    writeFileSync(resolve(root, "resources/exercise/zeta.md"), "# Zeta\n", "utf8");
    writeFileSync(resolve(root, "resources/exercise/alpha.md"), "# Alpha\n", "utf8");
    const first = validateCorpus(root).diagnostics;
    const second = validateCorpus(root).diagnostics;
    expect(first).toEqual(second);
    expect(first.map((item) => item.path)).toEqual([
      "resources/exercise/alpha.md",
      "resources/exercise/zeta.md",
    ]);
  });

  test("fails missing and non-directory corpus roots", () => {
    const parent = mkdtempSync(join(tmpdir(), "manasource-corpus-root-test-"));
    temporaryRoots.push(parent);
    const missing = resolve(parent, "missing");
    expect(validateCorpus(missing).diagnostics.map((item) => item.code)).toEqual(["root/missing"]);
    expect(checkCorpusFormatting(missing).ok).toBe(false);
    expect(formatCorpus(missing).ok).toBe(false);

    const file = resolve(parent, "corpus.yaml");
    writeFileSync(file, "kind: not-a-root\n", "utf8");
    expect(validateCorpus(file).diagnostics.map((item) => item.code)).toEqual(["root/not-directory"]);
  });

  test("rejects unsupported regular files with stable path diagnostics", () => {
    const root = corpus();
    writeFileSync(resolve(root, "resources/exercise/notes.txt"), "not corpus data\n", "utf8");
    writeFileSync(resolve(root, "records/food/AB/legacy.yml"), "legacy: true\n", "utf8");
    const diagnostics = validateCorpus(root).diagnostics.filter((item) => item.path.endsWith("notes.txt") || item.path.endsWith("legacy.yml"));
    expect(diagnostics).toEqual([
      {
        code: "path/non-canonical-extension",
        message: "corpus YAML files must use the .yaml extension",
        path: "records/food/AB/legacy.yml",
      },
      {
        code: "path/unsupported-file",
        message: "corpus directories may contain only canonical .yaml and same-stem .md files",
        path: "resources/exercise/notes.txt",
      },
    ]);
  });

  test("rejects symbolic-link corpus directories", () => {
    const root = corpus();
    rmSync(resolve(root, "resources"), { recursive: true });
    symlinkSync("masteries", resolve(root, "resources"));
    expect(validateCorpus(root).diagnostics).toContainEqual({
      code: "path/symlink",
      message: "corpus paths must not be symbolic links",
      path: "resources",
    });
  });
});

describe("published exercise types", () => {
  test("the committed corpus holds exactly the four allowed YAML/Markdown pairs", () => {
    const entries = readdirSync(resolve(REPOSITORY_ROOT, "resources", "exercise")).sort();
    expect(entries).toEqual(
      [...EXERCISE_RESOURCE_SLUGS]
        .flatMap((slug) => [`${slug}.md`, `${slug}.yaml`])
        .sort(),
    );
  });

  test("the committed type resources keep their immutable typed IDs and slugs", () => {
    const expected: Record<string, string> = {
      "aerobic-exercise": "EX1V3KF3",
      "balance-coordination": "EX68YE08",
      "strength-training": "EX309HCG",
      stretching: "EX01Y5Z7",
    };

    for (const slug of EXERCISE_RESOURCE_SLUGS) {
      const resource = readYaml(REPOSITORY_ROOT, `resources/exercise/${slug}.yaml`);
      expect(resource.slug).toBe(slug);
      expect(resource.id).toBe(expected[slug]);
      expect(resource.identifiers).toContainEqual({
        kind: "source_slug",
        value: `exercise:${slug}`,
      });
    }
  });

  test("every committed type claim cites resource-local reference IDs", () => {
    for (const slug of EXERCISE_RESOURCE_SLUGS) {
      const resource = readYaml(REPOSITORY_ROOT, `resources/exercise/${slug}.yaml`);
      const references = resource.references as Array<Record<string, unknown>>;
      const referenceIds = new Set(references.map((reference) => reference.id));

      for (const claim of resource.claims as Array<Record<string, unknown>>) {
        const cited = claim.references as string[] | undefined;
        expect(cited?.length ?? 0).toBeGreaterThan(0);
        for (const referenceId of cited ?? []) expect(referenceIds).toContain(referenceId);
      }

      for (const association of resource.associations as Array<Record<string, unknown>>) {
        expect((association.claims as string[] | undefined)?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("a committed type with no curated evidence scores 0", () => {
    for (const slug of EXERCISE_RESOURCE_SLUGS) {
      const resource = readYaml(REPOSITORY_ROOT, `resources/exercise/${slug}.yaml`);
      if (resource.lifecycle === "draft") continue;

      const curated = (["claims", "references", "associations"] as const).some(
        (field) => (resource[field] as unknown[]).length > 0,
      );
      if (curated) continue;

      expect(resource.score).toBe(0);
    }
  });
});

describe("canonical formatting", () => {
  test("detects and fixes non-canonical YAML deterministically", () => {
    const root = corpus();
    const path = resolve(root, "resources/exercise/aerobic-exercise.yaml");
    const value = readYaml(root, "resources/exercise/aerobic-exercise.yaml");
    writeFileSync(path, `title: Aerobic exercise\n${formatYaml(value).replace("title: Aerobic exercise\n", "")}`, "utf8");

    expect(codes(root)).toContain("format/non-canonical");
    const formatted = formatCorpus(root);
    expect(formatted.ok).toBe(true);
    expect(formatted.filesFormatted).toBe(1);
    expect(checkCorpusFormatting(root).ok).toBe(true);
    expect(validateCorpus(root).ok).toBe(true);
  });
});
