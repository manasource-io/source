import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  EDITORIAL_SOURCE_NAMESPACE,
  EDITORIAL_SOURCE_URL,
  EditorialClassificationError,
  applyEditorialClassifications,
  readEditorialEntries,
} from "../scripts/records-classify.ts";
import { formatYaml, validateCorpus } from "../src/corpus.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures", "valid");
const roots: string[] = [];

function fixture(): { root: string; input: string } {
  const root = mkdtempSync(join(tmpdir(), "records-classify-"));
  roots.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  const input = resolve(root, "classifications", "editorial.yaml");
  mkdirSync(dirname(input), { recursive: true });
  return { root, input };
}

function writeEntries(input: string, entries: unknown[]): void {
  writeFileSync(input, formatYaml(entries), "utf8");
}

function readYaml(root: string, path: string): Record<string, unknown> {
  return parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;
}

function facts(root: string, id: string): Array<Record<string, unknown>> {
  return (readYaml(root, `records/food/AB/${id}.yaml`).facts ?? []) as Array<
    Record<string, unknown>
  >;
}

function editorialFacts(root: string, id: string): Array<Record<string, unknown>> {
  return facts(root, id).filter(
    (fact) =>
      ((fact.source as Record<string, unknown> | undefined)?.namespace ?? null) ===
      EDITORIAL_SOURCE_NAMESPACE,
  );
}

function entry(record_id: string, classification: string): Record<string, unknown> {
  return {
    class: classification,
    decided_at: "2026-10-01",
    decided_by: "fixture-reviewer",
    note: `Fixture decision for ${record_id}.`,
    record_id,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("editorial record classifications", () => {
  test("adds two facts, emits a joining manifest, and performs zero writes on rerun", () => {
    const { root, input } = fixture();
    writeEntries(input, [entry("FDAB0002", "peptide"), entry("FDAB0001", "nootropic")]);

    const beforeOtherFacts = new Map([
      ["FDAB0001", formatYaml(facts(root, "FDAB0001"))],
      ["FDAB0002", formatYaml(facts(root, "FDAB0002"))],
    ]);
    const first = applyEditorialClassifications(root, input);

    expect(first.written).toContain("records/food/AB/FDAB0001.yaml");
    expect(first.written).toContain("records/food/AB/FDAB0002.yaml");
    expect(editorialFacts(root, "FDAB0001")).toEqual([
      {
        code: "nootropic",
        kind: "classification",
        scheme: "manasource_editorial",
        source: {
          attribution: "Manasource editorial",
          namespace: "manasource.editorial",
          source_record_id: "FDAB0001:nootropic",
          url: EDITORIAL_SOURCE_URL,
        },
      },
    ]);
    expect(editorialFacts(root, "FDAB0002")[0]?.code).toBe("peptide");

    for (const id of ["FDAB0001", "FDAB0002"]) {
      const otherFacts = facts(root, id).filter(
        (fact) =>
          (fact.source as Record<string, unknown> | undefined)?.namespace !==
          EDITORIAL_SOURCE_NAMESPACE,
      );
      expect(formatYaml(otherFacts)).toBe(beforeOtherFacts.get(id)!);
    }

    const manifestPath = `manifests/manasource-editorial/${first.batchId}.yaml`;
    const manifest = readYaml(root, manifestPath);
    expect(manifest.records).toEqual(["FDAB0001", "FDAB0002"]);
    expect(
      (manifest.classifications as Array<Record<string, unknown>>).map(
        (classification) => `${classification.record_id}:${classification.class}`,
      ),
    ).toEqual(["FDAB0001:nootropic", "FDAB0002:peptide"]);
    expect(validateCorpus(root).diagnostics).toEqual([]);

    const ownedPaths = [...first.written].sort();
    const old = new Date("2001-01-01T00:00:00.000Z");
    for (const path of ownedPaths) utimesSync(resolve(root, path), old, old);
    const mtimes = ownedPaths.map((path) => statSync(resolve(root, path)).mtimeMs);

    const second = applyEditorialClassifications(root, input);
    expect(second).toEqual({
      batchId: first.batchId,
      removed: [],
      unchanged: ownedPaths,
      written: [],
    });
    expect(ownedPaths.map((path) => statSync(resolve(root, path)).mtimeMs)).toEqual(mtimes);
  });

  test("removing an entry removes only its editorial fact and replaces the manifest", () => {
    const { root, input } = fixture();
    writeEntries(input, [entry("FDAB0001", "nootropic"), entry("FDAB0002", "drug")]);
    const first = applyEditorialClassifications(root, input);
    const retainedNonEditorial = formatYaml(
      facts(root, "FDAB0001").filter(
        (fact) =>
          (fact.source as Record<string, unknown> | undefined)?.namespace !==
          EDITORIAL_SOURCE_NAMESPACE,
      ),
    );
    const untouchedRecord = readFileSync(
      resolve(root, "records/food/AB/FDAB0002.yaml"),
      "utf8",
    );

    writeEntries(input, [entry("FDAB0002", "drug")]);
    const second = applyEditorialClassifications(root, input);

    expect(editorialFacts(root, "FDAB0001")).toEqual([]);
    expect(
      formatYaml(
        facts(root, "FDAB0001").filter(
          (fact) =>
            (fact.source as Record<string, unknown> | undefined)?.namespace !==
            EDITORIAL_SOURCE_NAMESPACE,
        ),
      ),
    ).toBe(retainedNonEditorial);
    expect(readFileSync(resolve(root, "records/food/AB/FDAB0002.yaml"), "utf8")).toBe(
      untouchedRecord,
    );
    expect(second.removed).toEqual([
      `manifests/manasource-editorial/${first.batchId}.yaml`,
    ]);
    expect(second.written).toEqual([
      `manifests/manasource-editorial/${second.batchId}.yaml`,
      "records/food/AB/FDAB0001.yaml",
    ]);
    expect(readYaml(root, `manifests/manasource-editorial/${second.batchId}.yaml`).records).toEqual([
      "FDAB0002",
    ]);
    expect(validateCorpus(root).diagnostics).toEqual([]);
  });

  test("rejects unknown record IDs and classes with useful diagnostics", () => {
    const { root, input } = fixture();
    writeEntries(input, [entry("CPZZZZZZ", "peptide")]);
    expect(() => applyEditorialClassifications(root, input)).toThrow(
      "CPZZZZZZ:peptide targets an unknown record ID",
    );

    writeEntries(input, [entry("FDAB0001", "vitamin")]);
    expect(() => readEditorialEntries(input)).toThrow(
      "class must be one of nootropic, drug, peptide",
    );
    expect(() => readEditorialEntries(input)).toThrow(EditorialClassificationError);
  });

  test("validation rejects a classification manifest that no longer joins to its fact", () => {
    const { root, input } = fixture();
    writeEntries(input, [entry("FDAB0001", "nootropic")]);
    applyEditorialClassifications(root, input);
    const path = "records/food/AB/FDAB0001.yaml";
    const record = readYaml(root, path);
    record.facts = facts(root, "FDAB0001").filter(
      (fact) =>
        (fact.source as Record<string, unknown> | undefined)?.namespace !==
        EDITORIAL_SOURCE_NAMESPACE,
    );
    writeFileSync(resolve(root, path), formatYaml(record), "utf8");

    expect(validateCorpus(root).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "manifest/classification-fact-count",
    );
  });

  test("validation checks the declared record count against unique classified records", () => {
    const { root, input } = fixture();
    writeEntries(input, [
      entry("FDAB0001", "nootropic"),
      entry("FDAB0001", "peptide"),
    ]);
    const result = applyEditorialClassifications(root, input);
    const manifestPath = `manifests/manasource-editorial/${result.batchId}.yaml`;
    const manifest = readYaml(root, manifestPath);
    (manifest.counts as Record<string, unknown>).records = 2;
    writeFileSync(resolve(root, manifestPath), formatYaml(manifest), "utf8");

    expect(validateCorpus(root).diagnostics).toContainEqual({
      code: "manifest/classification-record-count",
      message: "counts.records is 2, but classifications name 1 unique record(s)",
      path: manifestPath,
    });
  });
});
