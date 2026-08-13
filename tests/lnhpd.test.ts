import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { validateCorpus } from "../src/corpus.ts";
import { indexCorpus } from "../src/lnhpd/corpus.ts";
import { emitLnhpdImport, plannedPaths } from "../src/lnhpd/emit.ts";
import {
  LNHPD_COLUMNS,
  LNHPD_DOSE_UNITS,
  LNHPD_DOSE_URL_PLACEHOLDER,
  LNHPD_DOSE_URL_TEMPLATE,
  LNHPD_QUARANTINE_REASONS,
  LNHPD_READ_COLUMNS,
  LNHPD_SOURCE_NAMESPACE,
  LNHPD_URL_PLACEHOLDER,
  LNHPD_URL_TEMPLATE,
  LnhpdImportError,
  RECORD_FACT_UNITS,
  deriveBatchId,
  mintRecordId,
  normalizeRecordName,
  seededSuffixBytes,
  toSlug,
} from "../src/lnhpd/format.ts";
import { readLnhpdIdentities } from "../src/lnhpd/identity.ts";
import { planLnhpdImport } from "../src/lnhpd/plan.ts";
import {
  LNHPD_ACQUISITION_CONTRACT,
  readDatasetRows,
  readLnhpdSnapshot,
} from "../src/lnhpd/read.ts";
import type { LnhpdRowSet } from "../src/lnhpd/read.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** A productlicence row with every declared column present. */
function licenceRow(
  overrides: Record<string, string | number | null> = {},
): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};
  for (const column of LNHPD_COLUMNS.productlicence) row[column] = null;
  return {
    ...row,
    lnhpd_id: 3894930,
    licence_number: "02096870",
    product_name: "Primanol",
    dosage_form: "Capsule",
    company_name: "Jamieson Laboratories Ltd.",
    flag_primary_name: 1,
    flag_product_status: 1,
    ...overrides,
  };
}

/** A productdose row with every declared column present. */
function doseRow(
  overrides: Record<string, string | number | null> = {},
): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};
  for (const column of LNHPD_COLUMNS.productdose) row[column] = null;
  return {
    ...row,
    lnhpd_id: 3894930,
    dose_id: 5884617,
    population_type_desc: "Adults",
    quantity_dose: 0,
    quantity_dose_minimum: 250,
    quantity_dose_maximum: 500,
    uom_type_desc_quantity_dose: "mg",
    ...overrides,
  };
}

function rowSet(
  licences: Record<string, string | number | null>[],
  doses: Record<string, string | number | null>[],
): LnhpdRowSet {
  return {
    rows: {
      productlicence: licences.map((columns, index) => ({
        dataset: "productlicence" as const,
        index,
        columns,
      })),
      productdose: doses.map((columns, index) => ({
        dataset: "productdose" as const,
        index,
        columns,
      })),
    },
    acquisition: {
      contract: LNHPD_ACQUISITION_CONTRACT,
      retrievedAt: "2026-08-13T17:14:01.000Z",
      datasets: [
        {
          dataset: "productlicence",
          url: "https://health-products.canada.ca/api/natural-licences/productlicence/?lang=en&type=json",
          file: "productlicence.json",
          httpStatus: 200,
          declaredBytes: 100,
          observedBytes: 100,
          sha256: "a".repeat(64),
          rowCount: Math.max(licences.length, 1),
          servedAt: "2026-08-13T17:14:01.000Z",
        },
        {
          dataset: "productdose",
          url: "https://health-products.canada.ca/api/natural-licences/productdose/?lang=en&type=json",
          file: "productdose.json",
          httpStatus: 200,
          declaredBytes: 100,
          observedBytes: 100,
          sha256: "b".repeat(64),
          rowCount: Math.max(doses.length, 1),
          servedAt: "2026-08-13T17:13:17.000Z",
        },
      ],
    },
  };
}

function emptyIndex() {
  return { takenIds: new Set<string>(), byLnhpdId: new Map(), recordCount: 0 };
}

function reasons(quarantine: { reason: string }[]): string[] {
  return [...new Set(quarantine.map((entry) => entry.reason))].sort();
}

describe("format", () => {
  test("normalized names fold accents, collapse whitespace and lowercase", () => {
    expect(normalizeRecordName("  Café   Vitamin\tC  ")).toBe("cafe vitamin c");
    expect(normalizeRecordName("Chewable Vitamin C 500 mg - Grape")).toBe(
      "chewable vitamin c 500 mg - grape",
    );
  });

  test("slugs are kebab-case and fall back to the record ID", () => {
    expect(toSlug("Chewable Vitamin C 500 mg - Grape", "SP000001")).toBe(
      "chewable-vitamin-c-500-mg-grape",
    );
    expect(toSlug("///", "SP000001")).toBe("sp000001");
  });

  test("the columns the importer reads are a subset of the ones it declares", () => {
    for (const dataset of ["productlicence", "productdose"] as const) {
      for (const column of LNHPD_READ_COLUMNS[dataset]) {
        expect(LNHPD_COLUMNS[dataset]).toContain(column);
      }
      // The declared set is wider on purpose: the whole observed shape is
      // checked so a renamed upstream column fails the batch, while only these
      // decide what is published.
      expect(LNHPD_READ_COLUMNS[dataset].length).toBeLessThan(
        LNHPD_COLUMNS[dataset].length,
      );
    }
    // A single stated quantity is not a range, so it is proven not to be read.
    expect(LNHPD_READ_COLUMNS.productdose).not.toContain("quantity_dose");
    expect(LNHPD_COLUMNS.productdose).toContain("quantity_dose");
  });

  test("every dose unit maps onto a unit the corpus fact contract holds", () => {
    for (const unit of Object.values(LNHPD_DOSE_UNITS)) {
      expect(RECORD_FACT_UNITS).toContain(unit);
    }
  });

  test("both citation templates carry their placeholder and are https", () => {
    expect(LNHPD_URL_TEMPLATE).toContain(LNHPD_URL_PLACEHOLDER);
    expect(LNHPD_URL_TEMPLATE.startsWith("https://")).toBe(true);
    expect(LNHPD_DOSE_URL_TEMPLATE).toContain(LNHPD_DOSE_URL_PLACEHOLDER);
    expect(LNHPD_DOSE_URL_TEMPLATE.startsWith("https://")).toBe(true);
  });

  test("minted IDs are a pure function of the seeded identity", () => {
    const mint = () =>
      mintRecordId("SP", () => false, seededSuffixBytes(`${LNHPD_SOURCE_NAMESPACE} 3894930`));
    expect(mint()).toBe(mint());
    expect(mint()).toMatch(/^SP[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  });

  test("a taken ID forces a fresh digest rather than a collision", () => {
    const seed = seededSuffixBytes("collide");
    const first = mintRecordId("SP", () => false, seededSuffixBytes("collide"));
    const second = mintRecordId("SP", (candidate) => candidate === first, seed);
    expect(second).not.toBe(first);
  });

  test("batch ids digest their input and change when it does", () => {
    expect(deriveBatchId("hc-lnhpd", { a: 1 })).toBe(deriveBatchId("hc-lnhpd", { a: 1 }));
    expect(deriveBatchId("hc-lnhpd", { a: 1 })).not.toBe(
      deriveBatchId("hc-lnhpd", { a: 2 }),
    );
  });
});

describe("read", () => {
  function snapshot(
    licences: unknown,
    doses: unknown,
    receiptOverrides: Record<string, unknown> = {},
  ): string {
    const root = temporary("lnhpd-snapshot-");
    const files = [
      ["productlicence", licences],
      ["productdose", doses],
    ] as const;
    const datasets = files.map(([dataset, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      writeFileSync(resolve(root, `${dataset}.json`), text, "utf8");
      return {
        dataset,
        url: `https://health-products.canada.ca/api/natural-licences/${dataset}/?lang=en&type=json`,
        file: `${dataset}.json`,
        httpStatus: 200,
        declaredBytes: Buffer.byteLength(text),
        observedBytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        rowCount: Array.isArray(value) ? value.length : 1,
        servedAt: "2026-08-13T17:14:01.000Z",
      };
    });
    writeFileSync(
      resolve(root, "acquisition.json"),
      JSON.stringify({
        contract: LNHPD_ACQUISITION_CONTRACT,
        retrievedAt: "2026-08-13T17:14:01.000Z",
        datasets,
        ...receiptOverrides,
      }),
      "utf8",
    );
    return root;
  }

  test("a whole snapshot reads into indexed rows", () => {
    const read = readLnhpdSnapshot(snapshot([licenceRow()], [doseRow()]));
    expect(read.rows.productlicence).toHaveLength(1);
    expect(read.rows.productdose).toHaveLength(1);
    expect(read.rows.productlicence[0]?.columns.product_name).toBe("Primanol");
    expect(read.acquisition.retrievedAt).toBe("2026-08-13T17:14:01.000Z");
  });

  test("an unknown column fails the batch closed", () => {
    const root = snapshot([{ ...licenceRow(), dateReceived: "2026-08-13" }], [doseRow()]);
    expect(() => readLnhpdSnapshot(root)).toThrow(/unknown column 'dateReceived'/);
  });

  test("a missing declared column fails the batch closed", () => {
    const row = licenceRow();
    delete row.revised_date;
    expect(() => readLnhpdSnapshot(snapshot([row], [doseRow()]))).toThrow(
      /missing declared column 'revised_date'/,
    );
  });

  test("a column of the wrong JSON type fails the batch closed", () => {
    const root = snapshot([{ ...licenceRow(), product_name: ["Primanol"] }], [doseRow()]);
    expect(() => readLnhpdSnapshot(root)).toThrow(/not a string or a number/);
  });

  test("a truncated download cannot be read", () => {
    const truncated = JSON.stringify([licenceRow()]).slice(0, 40);
    expect(() => readLnhpdSnapshot(snapshot(truncated, [doseRow()]))).toThrow(
      /not valid JSON/,
    );
  });

  test("a snapshot edited after acquisition is refused by its own digest", () => {
    const root = snapshot([licenceRow()], [doseRow()]);
    const path = resolve(root, "productdose.json");
    const edited = JSON.stringify([doseRow({ quantity_dose_maximum: 999 })]);
    writeFileSync(path, edited.padEnd(readFileSync(path, "utf8").length, " "), "utf8");
    expect(() => readLnhpdSnapshot(root)).toThrow(/digests to .* but the receipt records/);
  });

  test("a receipt whose byte counts disagree is a fragment", () => {
    const root = snapshot([licenceRow()], [doseRow()]);
    const receipt = JSON.parse(readFileSync(resolve(root, "acquisition.json"), "utf8"));
    receipt.datasets[0].declaredBytes += 1;
    writeFileSync(resolve(root, "acquisition.json"), JSON.stringify(receipt), "utf8");
    expect(() => readLnhpdSnapshot(root)).toThrow(/so the download is a fragment/);
  });

  test("a non-200 download is never read", () => {
    const root = snapshot([licenceRow()], [doseRow()]);
    const receipt = JSON.parse(readFileSync(resolve(root, "acquisition.json"), "utf8"));
    receipt.datasets[0].httpStatus = 206;
    writeFileSync(resolve(root, "acquisition.json"), JSON.stringify(receipt), "utf8");
    expect(() => readLnhpdSnapshot(root)).toThrow(/records HTTP 206/);
  });

  test("a snapshot missing a dataset is refused", () => {
    const root = snapshot([licenceRow()], [doseRow()]);
    const receipt = JSON.parse(readFileSync(resolve(root, "acquisition.json"), "utf8"));
    receipt.datasets = receipt.datasets.slice(0, 1);
    writeFileSync(resolve(root, "acquisition.json"), JSON.stringify(receipt), "utf8");
    expect(() => readLnhpdSnapshot(root)).toThrow(/carries no 'productdose' download/);
  });

  test("a receipt declaring another contract is refused", () => {
    const root = snapshot([licenceRow()], [doseRow()], { contract: "something/else" });
    expect(() => readLnhpdSnapshot(root)).toThrow(/declares contract "something\/else"/);
  });

  test("an empty dataset is refused rather than imported as a no-op", () => {
    expect(() => readDatasetRows("[]", "productdose", "productdose.json")).toThrow(
      /carries no rows/,
    );
    expect(() => readLnhpdSnapshot(snapshot([], [doseRow()]))).toThrow(LnhpdImportError);
  });

  test("a row count the receipt disagrees with is refused", () => {
    const root = snapshot([licenceRow()], [doseRow(), doseRow({ dose_id: 2 })]);
    const receipt = JSON.parse(readFileSync(resolve(root, "acquisition.json"), "utf8"));
    receipt.datasets[1].rowCount = 1;
    writeFileSync(resolve(root, "acquisition.json"), JSON.stringify(receipt), "utf8");
    expect(() => readLnhpdSnapshot(root)).toThrow(
      /carries 2 rows but the receipt records 1/,
    );
  });
});

describe("identity", () => {
  test("a clean licence with a carryable dose becomes one identity", () => {
    const read = readLnhpdIdentities(rowSet([licenceRow()], [doseRow()]));
    expect(read.identities).toHaveLength(1);
    expect(read.resolvedLicences).toBe(1);
    const identity = read.identities[0]!;
    expect(identity.sourceRecordId).toBe("3894930");
    expect(identity.licenceNumber).toBe("02096870");
    expect(identity.doseFacts).toEqual([
      {
        doseId: "5884617",
        rowIndex: 0,
        populationTypeDesc: "Adults",
        minimum: 250,
        maximum: 500,
        unit: "mg",
        sourceUnit: "mg",
      },
    ]);
    expect(read.quarantine).toHaveLength(0);
  });

  test("every declared quarantine reason is reachable from a row", () => {
    const cases: [string, LnhpdRowSet][] = [
      ["missing_identifier", rowSet([licenceRow({ lnhpd_id: 0 })], [doseRow()])],
      [
        "invalid_licence_number",
        rowSet([licenceRow({ licence_number: "123" })], [doseRow()]),
      ],
      ["missing_name", rowSet([licenceRow({ product_name: "   " })], [doseRow()])],
      [
        "missing_primary_name",
        rowSet([licenceRow({ flag_primary_name: 0 })], [doseRow()]),
      ],
      [
        "ambiguous_primary_name",
        rowSet(
          [licenceRow(), licenceRow({ company_name: "Another Co." })],
          [doseRow()],
        ),
      ],
      [
        "ambiguous_identity",
        rowSet(
          [
            licenceRow(),
            licenceRow({ lnhpd_id: 3894931, licence_number: "02096871" }),
          ],
          [doseRow()],
        ),
      ],
      [
        "unresolved_product",
        rowSet([licenceRow()], [doseRow(), doseRow({ lnhpd_id: 999, dose_id: 1 })]),
      ],
      [
        "invalid_identifier",
        rowSet([licenceRow()], [doseRow(), doseRow({ dose_id: 0 })]),
      ],
      [
        "unsupported_dose_unit",
        rowSet(
          [licenceRow()],
          [doseRow(), doseRow({ dose_id: 2, uom_type_desc_quantity_dose: "capsule" })],
        ),
      ],
      [
        "missing_dose_range",
        rowSet(
          [licenceRow()],
          [
            doseRow(),
            doseRow({ dose_id: 3, quantity_dose_minimum: 0, quantity_dose_maximum: 0 }),
          ],
        ),
      ],
      [
        "invalid_dose_range",
        rowSet(
          [licenceRow()],
          [
            doseRow(),
            doseRow({ dose_id: 4, quantity_dose_minimum: 900, quantity_dose_maximum: 5 }),
          ],
        ),
      ],
      [
        "no_supported_dose_fact",
        rowSet([licenceRow()], [doseRow({ uom_type_desc_quantity_dose: "tablet" })]),
      ],
    ];

    for (const [reason, rows] of cases) {
      expect(reasons(readLnhpdIdentities(rows).quarantine)).toContain(reason);
    }
  });

  test("the quarantine vocabulary carries no reason a row cannot reach", () => {
    const rowReasons = new Set([
      "missing_identifier",
      "invalid_identifier",
      "invalid_licence_number",
      "missing_name",
      "missing_primary_name",
      "ambiguous_primary_name",
      "ambiguous_identity",
      "unresolved_product",
      "missing_dose_range",
      "invalid_dose_range",
      "unsupported_dose_unit",
      "no_supported_dose_fact",
      // Reached by `plan`, which is where a licence's fate is finally known:
      // a repeated primary row is only a held row once the licence publishes,
      // and only a corpus can reveal the last two.
      "duplicate_source_row",
      "identifier_conflict",
      "record_type_conflict",
    ]);
    expect([...LNHPD_QUARANTINE_REASONS].sort()).toEqual(
      [...rowReasons].sort() as unknown as (typeof LNHPD_QUARANTINE_REASONS)[number][],
    );
  });

  test("identical repeated primary rows are one product counted twice", () => {
    const read = readLnhpdIdentities(rowSet([licenceRow(), licenceRow()], [doseRow()]));
    expect(read.identities).toHaveLength(1);
    expect(read.identities[0]?.occurrenceCount).toBe(2);
  });

  test("non-primary names are reported, never carried into the record", () => {
    const read = readLnhpdIdentities(
      rowSet(
        [licenceRow(), licenceRow({ flag_primary_name: 0, product_name: "Primanol Extra" })],
        [doseRow()],
      ),
    );
    expect(read.identities[0]?.alternateNames).toEqual(["Primanol Extra"]);
    expect(read.identities[0]?.canonicalName).toBe("Primanol");
  });

  test("a zero-to-zero range is not a dose of zero", () => {
    const read = readLnhpdIdentities(
      rowSet(
        [licenceRow()],
        [doseRow({ quantity_dose_minimum: 0, quantity_dose_maximum: 0 })],
      ),
    );
    expect(read.identities).toHaveLength(0);
    expect(reasons(read.quarantine)).toContain("missing_dose_range");
  });

  test("a ratio unit is held rather than folded onto its numerator", () => {
    for (const unit of ["g/kg", "ml/kg", "g/g", "oz", "USP units", "%"]) {
      const read = readLnhpdIdentities(
        rowSet([licenceRow()], [doseRow({ uom_type_desc_quantity_dose: unit })]),
      );
      expect(read.identities).toHaveLength(0);
      expect(reasons(read.quarantine)).toContain("unsupported_dose_unit");
    }
  });

  test("dose facts sort by their own upstream id, not by feed order", () => {
    const read = readLnhpdIdentities(
      rowSet(
        [licenceRow()],
        [doseRow({ dose_id: 900 }), doseRow({ dose_id: 100 }), doseRow({ dose_id: 500 })],
      ),
    );
    expect(read.identities[0]?.doseFacts.map((fact) => fact.doseId)).toEqual([
      "100",
      "500",
      "900",
    ]);
  });

  test("name ambiguity is decided across every resolved licence", () => {
    // The second licence carries no carryable dose, so a batch-scoped check would
    // publish the first as unambiguous. The register says otherwise.
    const read = readLnhpdIdentities(
      rowSet(
        [licenceRow(), licenceRow({ lnhpd_id: 3894931, licence_number: "02096871" })],
        [doseRow()],
      ),
    );
    expect(read.identities).toHaveLength(0);
    expect(reasons(read.quarantine)).toContain("ambiguous_identity");
  });
});

describe("plan", () => {
  test("a batch plans one record, one manifest and three reports", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    expect(plan.records).toHaveLength(1);
    expect(plan.reports.map((file) => file.path.split("-").at(-1))).toEqual([
      "acquisition.json",
      "quarantine.json",
      "products.json",
    ]);
    expect(plan.counts).toMatchObject({
      inputRows: 2,
      accepted: 1,
      facts: 1,
      quarantined: 0,
    });
  });

  test("the record carries an attributed dose_range fact and no invented identifier", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    const record = parse(plan.records[0]!.contents) as Record<string, unknown>;
    expect(record.entity_type).toBe("supplement_product");
    expect(record.identifiers).toEqual([]);
    expect(record.links).toEqual([]);
    expect(record.lifecycle).toBe("published");
    expect(record.sources).toEqual([
      {
        attribution: expect.stringContaining("Open Government Licence"),
        namespace: "hc.lnhpd",
        occurrence_count: 1,
        source_record_id: "3894930",
        url: "https://health-products.canada.ca/lnhpd-bdpsnh/info?licence=02096870&lang=eng",
      },
    ]);
    expect(record.facts).toEqual([
      {
        kind: "dose_range",
        range: { maximum: 500, minimum: 250, unit: "mg" },
        source: {
          attribution: expect.stringContaining("Health Canada"),
          namespace: "hc.lnhpd",
          occurrence_count: 1,
          source_record_id: "dose:5884617",
          // The dose dataset filtered to this product, not the product page:
          // a monograph-attested licence prints no numbers on its page.
          url: "https://health-products.canada.ca/api/natural-licences/productdose/?lang=en&type=json&id=3894930",
        },
      },
    ]);
  });

  test("a fact cites the dose dataset while its record cites the product page", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    const record = parse(plan.records[0]!.contents) as {
      facts: { source: { url: string } }[];
      sources: { url: string }[];
    };
    expect(record.sources[0]?.url).toContain("/lnhpd-bdpsnh/info?licence=");
    expect(record.facts[0]?.source.url).toContain("/api/natural-licences/productdose/");
    expect(record.facts[0]?.source.url).not.toBe(record.sources[0]?.url);
    for (const url of [record.sources[0]?.url, record.facts[0]?.source.url]) {
      expect(url?.startsWith("https://health-products.canada.ca/")).toBe(true);
    }
  });

  test("a dose template without its placeholder or scheme is refused", () => {
    expect(() =>
      planLnhpdImport({
        rows: rowSet([licenceRow()], [doseRow()]),
        index: emptyIndex(),
        doseUrlTemplate: "https://health-products.canada.ca/api/natural-licences/productdose/",
      }),
    ).toThrow(/dose URL template must contain/);
    expect(() =>
      planLnhpdImport({
        rows: rowSet([licenceRow()], [doseRow()]),
        index: emptyIndex(),
        doseUrlTemplate: `http://health-products.canada.ca/x?id=${LNHPD_DOSE_URL_PLACEHOLDER}`,
      }),
    ).toThrow(/dose URL template must be https/);
  });

  test("a fact cites its own dose row, so two doses do not collapse into one citation", () => {
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow(), doseRow({ dose_id: 7, quantity_dose_maximum: 750 })]),
      index: emptyIndex(),
    });
    const record = parse(plan.records[0]!.contents) as { facts: { source: { source_record_id: string } }[] };
    expect(record.facts.map((fact) => fact.source.source_record_id)).toEqual([
      "dose:5884617",
      "dose:7",
    ]);
  });

  test("the record path matches its ID shard", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    const record = parse(plan.records[0]!.contents) as { id: string };
    expect(plan.records[0]!.path).toBe(
      `records/supplement_product/${record.id.slice(2, 4)}/${record.id}.yaml`,
    );
  });

  test("the manifest counts what it lists and states OGL attribution", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    const manifest = parse(plan.manifest.contents) as Record<string, any>;
    expect(manifest.counts).toEqual({ records: 1, sources: 1 });
    expect(manifest.records).toHaveLength(1);
    expect(manifest.source_namespace).toBe("hc.lnhpd");
    expect(manifest.license).toContain("Open Government Licence");
    expect(manifest.notice).toContain("has been modified");
    expect(manifest.notice).toContain("not represented as an official version");
    expect(manifest.notice).toContain("medicinalingredient and productrisk datasets were not acquired");
    expect(manifest.retrieved_at).toBe("2026-08-13T17:14:01.000Z");
    expect(plan.manifest.path).toBe(`manifests/hc-lnhpd/${manifest.batch_id}.yaml`);
  });

  test("the quarantine total equals the reason counts", () => {
    const plan = planLnhpdImport({
      rows: rowSet(
        [licenceRow(), licenceRow({ lnhpd_id: 42, licence_number: "00000042", product_name: "Held" })],
        [doseRow(), doseRow({ dose_id: 9, lnhpd_id: 42, uom_type_desc_quantity_dose: "capsule" })],
      ),
      index: emptyIndex(),
    });
    const manifest = parse(plan.manifest.contents) as Record<string, any>;
    const summed = manifest.quarantine.reasons.reduce(
      (total: number, entry: { count: number }) => total + entry.count,
      0,
    );
    expect(manifest.quarantine.total).toBe(summed);
    expect(manifest.quarantine.total).toBe(plan.counts.quarantined);
  });

  test("planning twice from one snapshot yields identical bytes", () => {
    const rows = rowSet([licenceRow()], [doseRow()]);
    const first = planLnhpdImport({ rows, index: emptyIndex() });
    const second = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    expect(second.batchId).toBe(first.batchId);
    expect(second.records[0]?.contents).toBe(first.records[0]?.contents);
    expect(second.manifest.contents).toBe(first.manifest.contents);
    expect(second.reports.map((file) => file.contents)).toEqual(
      first.reports.map((file) => file.contents),
    );
  });

  test("feed order cannot change a record's bytes", () => {
    const forward = planLnhpdImport({
      rows: rowSet(
        [licenceRow(), licenceRow({ lnhpd_id: 5, licence_number: "00000005", product_name: "Beta" })],
        [doseRow(), doseRow({ lnhpd_id: 5, dose_id: 8 })],
      ),
      index: emptyIndex(),
    });
    const reversed = planLnhpdImport({
      rows: rowSet(
        [licenceRow({ lnhpd_id: 5, licence_number: "00000005", product_name: "Beta" }), licenceRow()],
        [doseRow({ lnhpd_id: 5, dose_id: 8 }), doseRow()],
      ),
      index: emptyIndex(),
    });
    expect(reversed.records.map((file) => file.contents)).toEqual(
      forward.records.map((file) => file.contents),
    );
    expect(reversed.batchId).toBe(forward.batchId);
  });

  test("a URL template without its placeholder is refused", () => {
    expect(() =>
      planLnhpdImport({
        rows: rowSet([licenceRow()], [doseRow()]),
        index: emptyIndex(),
        sourceUrlTemplate: "https://health-products.canada.ca/lnhpd-bdpsnh/info",
      }),
    ).toThrow(LnhpdImportError);
  });

  test("a non-https template is refused before a record is written", () => {
    expect(() =>
      planLnhpdImport({
        rows: rowSet([licenceRow()], [doseRow()]),
        index: emptyIndex(),
        sourceUrlTemplate: `http://health-products.canada.ca/x?licence=${LNHPD_URL_PLACEHOLDER}`,
      }),
    ).toThrow(/must be https/);
  });

  test("a repeated primary row is held only once the licence publishes", () => {
    const published = planLnhpdImport({
      rows: rowSet([licenceRow(), licenceRow()], [doseRow()]),
      index: emptyIndex(),
    });
    expect(published.records).toHaveLength(1);
    expect(reasons(published.quarantine)).toEqual(["duplicate_source_row"]);
    const record = parse(published.records[0]!.contents) as {
      sources: { occurrence_count: number }[];
    };
    expect(record.sources[0]?.occurrence_count).toBe(2);

    // The same repeat on a licence that never publishes is held under the reason
    // that stopped it, and is not also counted as a duplicate.
    const withheld = planLnhpdImport({
      rows: rowSet(
        [licenceRow(), licenceRow()],
        [doseRow({ uom_type_desc_quantity_dose: "capsule" })],
      ),
      index: emptyIndex(),
    });
    expect(withheld.records).toHaveLength(0);
    expect(reasons(withheld.quarantine)).toEqual([
      "no_supported_dose_fact",
      "unsupported_dose_unit",
    ]);
  });

  test("every input row is accounted for exactly once", () => {
    const plan = planLnhpdImport({
      rows: rowSet(
        [
          licenceRow(),
          licenceRow({ flag_primary_name: 0, product_name: "Primanol Extra" }),
          licenceRow({ lnhpd_id: 42, licence_number: "00000042", product_name: "Held" }),
          licenceRow({ lnhpd_id: 7, licence_number: "00000007", product_name: "Nameless", flag_primary_name: 0 }),
        ],
        [
          doseRow(),
          doseRow({ dose_id: 9, lnhpd_id: 42, uom_type_desc_quantity_dose: "capsule" }),
          doseRow({ dose_id: 11, lnhpd_id: 999 }),
        ],
      ),
      index: emptyIndex(),
    });
    const { accounting } = plan.counts;
    expect(
      accounting.acceptedProductRows +
        accounting.alternateNameRows +
        accounting.heldProductRows,
    ).toBe(accounting.productRows);
    expect(accounting.acceptedDoseRows + accounting.heldDoseRows).toBe(
      accounting.doseRows,
    );
    expect(accounting.productRows + accounting.doseRows).toBe(plan.counts.inputRows);
    expect(accounting.heldProductRows + accounting.heldDoseRows).toBe(
      plan.counts.quarantined,
    );
    expect(accounting.acceptedProductRows).toBe(1);
    expect(accounting.alternateNameRows).toBe(1);
  });

  test("a licence the corpus rejects accounts for its dose rows too", () => {
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow()]),
      index: {
        takenIds: new Set(["SP000001"]),
        byLnhpdId: new Map([
          [
            "3894930",
            {
              id: "SP000001",
              path: "records/supplement_product/00/SP000001.yaml",
              entityType: "supplement_product",
              data: {},
              sources: [
                { namespace: "hc.lnhpd", sourceRecordId: "3894930" },
                { namespace: "hc.lnhpd", sourceRecordId: "9999999" },
              ],
            },
          ],
        ]),
        recordCount: 1,
      },
    });
    expect(plan.records).toHaveLength(0);
    expect(reasons(plan.quarantine)).toEqual(["identifier_conflict"]);
    const { accounting } = plan.counts;
    expect(accounting.heldDoseRows).toBe(1);
    expect(accounting.acceptedDoseRows).toBe(0);
    expect(accounting.acceptedProductRows + accounting.alternateNameRows + accounting.heldProductRows).toBe(
      accounting.productRows,
    );
  });

  test("published dose facts carry no feed position", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    const report = JSON.parse(
      plan.reports.find((file) => file.path.endsWith("-products.json"))!.contents,
    );
    expect(report.products[0].doseFacts[0]).not.toHaveProperty("rowIndex");
  });

  test("an existing record of another type is held rather than retyped", () => {
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow()]),
      index: {
        takenIds: new Set(["FD000001"]),
        byLnhpdId: new Map([
          [
            "3894930",
            {
              id: "FD000001",
              path: "records/food/00/FD000001.yaml",
              entityType: "food",
              data: {},
              sources: [{ namespace: "hc.lnhpd", sourceRecordId: "3894930" }],
            },
          ],
        ]),
        recordCount: 1,
      },
    });
    expect(plan.records).toHaveLength(0);
    expect(reasons(plan.quarantine)).toContain("record_type_conflict");
  });

  test("a refresh replaces this namespace's facts and leaves others alone", () => {
    const foreignFact = {
      kind: "dose_range",
      range: { maximum: 10, minimum: 5, unit: "g" },
      source: {
        attribution: "Another dataset",
        namespace: "other.source",
        source_record_id: "x1",
        url: "https://example.org/x1",
      },
    };
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow({ dose_id: 4242 })]),
      index: {
        takenIds: new Set(["SP000001"]),
        byLnhpdId: new Map([
          [
            "3894930",
            {
              id: "SP000001",
              path: "records/supplement_product/00/SP000001.yaml",
              entityType: "supplement_product",
              data: {
                canonical_name: "Named by another importer",
                normalized_name: "named by another importer",
                slug: "named-by-another-importer",
                title: "Named by another importer",
                identifiers: [{ kind: "other_id", value: "7" }],
                links: [],
                lifecycle: "published",
                sources: [
                  {
                    attribution: "Another dataset",
                    namespace: "other.source",
                    source_record_id: "x1",
                    url: "https://example.org/x1",
                  },
                  {
                    attribution: "stale",
                    namespace: "hc.lnhpd",
                    source_record_id: "3894930",
                    url: "https://example.org/stale",
                  },
                ],
                facts: [
                  foreignFact,
                  {
                    kind: "dose_range",
                    range: { maximum: 1, minimum: 1, unit: "mg" },
                    source: {
                      attribution: "stale",
                      namespace: "hc.lnhpd",
                      source_record_id: "dose:999",
                      url: "https://example.org/stale",
                    },
                  },
                ],
              },
              sources: [
                { namespace: "other.source", sourceRecordId: "x1" },
                { namespace: "hc.lnhpd", sourceRecordId: "3894930" },
              ],
            },
          ],
        ]),
        recordCount: 1,
      },
    });

    const record = parse(plan.records[0]!.contents) as Record<string, any>;
    expect(record.id).toBe("SP000001");
    // The record was named by another importer, so this one does not rename it.
    expect(record.canonical_name).toBe("Named by another importer");
    expect(record.identifiers).toEqual([{ kind: "other_id", value: "7" }]);
    const factIds = record.facts.map((fact: any) => fact.source.source_record_id);
    expect(factIds).toEqual(["dose:4242", "x1"]);
    expect(record.facts.find((fact: any) => fact.source.namespace === "other.source")).toEqual(
      foreignFact,
    );
    const stale = record.sources.find((source: any) => source.namespace === "hc.lnhpd");
    expect(stale.url).toBe(
      "https://health-products.canada.ca/lnhpd-bdpsnh/info?licence=02096870&lang=eng",
    );
  });

  test("the quarantine report publishes complete counts beside bounded samples", () => {
    const doses = Array.from({ length: 40 }, (_unused, position) =>
      doseRow({ dose_id: position + 1, uom_type_desc_quantity_dose: "capsule" }),
    );
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow(), ...doses]),
      index: emptyIndex(),
      quarantineSampleSize: 5,
    });
    const report = JSON.parse(
      plan.reports.find((file) => file.path.endsWith("-quarantine.json"))!.contents,
    );
    expect(report.total).toBe(40);
    expect(report.reasons).toEqual([{ reason: "unsupported_dose_unit", count: 40 }]);
    expect(report.samples[0].entries).toHaveLength(5);
  });

  test("the acquisition report names what was not acquired", () => {
    const plan = planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: emptyIndex() });
    const report = JSON.parse(
      plan.reports.find((file) => file.path.endsWith("-acquisition.json"))!.contents,
    );
    expect(report.acquired.map((entry: any) => entry.dataset)).toEqual([
      "productdose",
      "productlicence",
    ]);
    expect(report.notAcquired.map((entry: any) => entry.dataset)).toEqual([
      "medicinalingredient",
      "productrisk",
    ]);
    expect(report.acquired[0].sha256).toHaveLength(64);
  });

  test("the product report is the durable home for what the envelope cannot carry", () => {
    const plan = planLnhpdImport({
      rows: rowSet(
        [licenceRow(), licenceRow({ flag_primary_name: 0, product_name: "Primanol Extra" })],
        [doseRow()],
      ),
      index: emptyIndex(),
    });
    const report = JSON.parse(
      plan.reports.find((file) => file.path.endsWith("-products.json"))!.contents,
    );
    expect(report.products[0]).toMatchObject({
      licenceNumber: "02096870",
      dosageForm: "Capsule",
      companyName: "Jamieson Laboratories Ltd.",
      alternateNames: ["Primanol Extra"],
    });
    expect(report.products[0].doseFacts[0].populationTypeDesc).toBe("Adults");
  });
});

describe("emit", () => {
  function corpusRoot(): string {
    const root = temporary("lnhpd-corpus-");
    mkdirSync(resolve(root, "records"), { recursive: true });
    return root;
  }

  test("an import writes its files, and re-running it writes nothing", () => {
    const root = corpusRoot();
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow()]),
      index: indexCorpus(root),
    });
    const first = emitLnhpdImport(root, plan);
    expect(first.written).toHaveLength(5);
    expect(first.written).toEqual(plannedPaths(plan));
    expect(first.unchanged).toHaveLength(0);

    const replan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow()]),
      index: indexCorpus(root),
    });
    expect(replan.batchId).toBe(plan.batchId);
    const second = emitLnhpdImport(root, replan);
    expect(second.written).toHaveLength(0);
    expect(second.unchanged).toHaveLength(5);
  });

  test("two clean roots receive byte-identical corpora", () => {
    const rows = () => rowSet([licenceRow()], [doseRow()]);
    const left = corpusRoot();
    const right = corpusRoot();
    emitLnhpdImport(left, planLnhpdImport({ rows: rows(), index: indexCorpus(left) }));
    emitLnhpdImport(right, planLnhpdImport({ rows: rows(), index: indexCorpus(right) }));

    const plan = planLnhpdImport({ rows: rows(), index: emptyIndex() });
    for (const file of [...plan.records, plan.manifest, ...plan.reports]) {
      expect(readFileSync(resolve(right, file.path), "utf8")).toBe(
        readFileSync(resolve(left, file.path), "utf8"),
      );
    }
  });

  test("the emitted corpus passes full validation", () => {
    const root = corpusRoot();
    const plan = planLnhpdImport({
      rows: rowSet([licenceRow()], [doseRow()]),
      index: indexCorpus(root),
    });
    emitLnhpdImport(root, plan);
    const result = validateCorpus(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a record the importer no longer owns keeps its own reconciliation", () => {
    const root = corpusRoot();
    emitLnhpdImport(
      root,
      planLnhpdImport({ rows: rowSet([licenceRow()], [doseRow()]), index: indexCorpus(root) }),
    );
    const reread = indexCorpus(root);
    expect(reread.byLnhpdId.get("3894930")).toBeDefined();
    expect(reread.byLnhpdId.get("3894930")?.entityType).toBe("supplement_product");
  });
});
