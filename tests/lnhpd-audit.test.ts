import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DOSE_AUDIT_FIXTURE_PATH,
  DOSE_AUDIT_REPORT_KIND,
  DOSE_CLASS_DISQUALIFICATIONS,
  DOSE_ROW_CLASSES,
  DOSE_ROW_CLASS_DETAIL,
  DOSE_ROW_EXCLUSIONS,
  DOSE_ROW_EXCLUSION_DETAIL,
  DOSE_UNIT_BUCKETS,
  DOSE_UNIT_BUCKET_DETAIL,
  DOSE_UNIT_INVENTORY,
  auditLnhpdDoseQuantities,
  classifyDoseRow,
  doseUnitBucketFor,
} from "../src/lnhpd/audit.ts";
import type { DoseRowClass } from "../src/lnhpd/audit.ts";
import {
  LNHPD_COLUMNS,
  LNHPD_DOSE_UNITS,
  LNHPD_READ_COLUMNS,
  doseUnitFor,
} from "../src/lnhpd/format.ts";
import { readLnhpdIdentities } from "../src/lnhpd/identity.ts";
import { LNHPD_ACQUISITION_CONTRACT } from "../src/lnhpd/read.ts";
import type { LnhpdInputRow, LnhpdRowSet } from "../src/lnhpd/read.ts";

const ROOT = resolve(import.meta.dir, "..");

/** The raw feed rows the audit sampled, committed so this file needs no snapshot. */
const FIXTURE_ROWS = JSON.parse(
  readFileSync(resolve(ROOT, DOSE_AUDIT_FIXTURE_PATH), "utf8"),
) as Record<string, string | number | null>[];

/** The one committed audit report, found by its kind rather than by its id. */
function committedReport(): Record<string, any> {
  const directory = resolve(ROOT, "reports", "hc-lnhpd");
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(`-${DOSE_AUDIT_REPORT_KIND}.json`))
    .sort();
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(resolve(directory, files[0]!), "utf8")) as Record<
    string,
    any
  >;
}

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
    age: 0,
    age_minimum: 0,
    age_maximum: 0,
    frequency: 0,
    frequency_minimum: 0,
    frequency_maximum: 0,
    quantity_dose: 0,
    quantity_dose_minimum: 0,
    quantity_dose_maximum: 0,
    uom_type_desc_quantity_dose: "mg",
    ...overrides,
  };
}

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
    ...overrides,
  };
}

function inputRow(
  columns: Record<string, string | number | null>,
  index = 0,
): LnhpdInputRow {
  return { dataset: "productdose", index, columns };
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
      retrievedAt: "2026-08-13T17:29:39.000Z",
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
          servedAt: "2026-08-13T17:28:45.000Z",
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
          servedAt: "2026-08-13T17:29:39.000Z",
        },
      ],
    },
  };
}

const classOf = (overrides: Record<string, string | number | null>): DoseRowClass =>
  classifyDoseRow(inputRow(doseRow(overrides))).doseClass;

describe("audit vocabulary", () => {
  test("the unit inventory and the fact vocabulary do not overlap", () => {
    // `doseUnitFor` owns the mass and volume list. Restating a spelling here
    // would let the two disagree about a unit and make eligibility depend on
    // which one a reader consulted.
    for (const spelling of Object.keys(DOSE_UNIT_INVENTORY)) {
      expect(doseUnitFor(spelling)).toBeNull();
      expect(DOSE_UNIT_INVENTORY[spelling]).not.toBe("mass_or_volume");
    }
    for (const spelling of Object.keys(LNHPD_DOSE_UNITS)) {
      expect(doseUnitBucketFor(spelling)).toBe("mass_or_volume");
    }
  });

  test("every bucket, class and exclusion states why it exists", () => {
    for (const bucket of DOSE_UNIT_BUCKETS) {
      expect(DOSE_UNIT_BUCKET_DETAIL[bucket].length).toBeGreaterThan(0);
    }
    for (const doseClass of DOSE_ROW_CLASSES) {
      expect(DOSE_ROW_CLASS_DETAIL[doseClass].length).toBeGreaterThan(0);
    }
    for (const exclusion of DOSE_ROW_EXCLUSIONS) {
      expect(DOSE_ROW_EXCLUSION_DETAIL[exclusion].length).toBeGreaterThan(0);
    }
    expect(DOSE_CLASS_DISQUALIFICATIONS.length).toBeGreaterThan(0);
  });

  test("a spelling the inventory does not name is reported, never guessed at", () => {
    expect(doseUnitBucketFor("nanogrammes per fortnight")).toBe("unclassified");
    expect(classOf({ quantity_dose: 5, uom_type_desc_quantity_dose: "nanog" })).toBe(
      "fixed_quantity_unclassified_unit",
    );
  });

  test("the audit reads a column the importer deliberately does not", () => {
    expect(LNHPD_READ_COLUMNS.productdose).not.toContain("quantity_dose");
    expect(classifyDoseRow(inputRow(doseRow({ quantity_dose: 500 }))).quantity).toBe(
      500,
    );
  });
});

describe("classification", () => {
  test("every declared class is reachable from a row", () => {
    const reached = new Set<DoseRowClass>([
      classOf({ lnhpd_id: 0 }),
      classOf({ dose_id: "not-an-id" }),
      classOf({ quantity_dose: "seven" }),
      classOf({ quantity_dose: -1 }),
      classOf({ quantity_dose: 5, quantity_dose_minimum: 1, quantity_dose_maximum: 2 }),
      classOf({ quantity_dose_minimum: 250, quantity_dose_maximum: 500 }),
      classOf({}),
      classOf({ quantity_dose: 500 }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "capsule" }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "g/kg" }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "USP units" }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "oz" }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "Quantity Unit TBA" }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "" }),
      classOf({ quantity_dose: 2, uom_type_desc_quantity_dose: "nanog" }),
    ]);
    expect([...reached].sort()).toEqual([...DOSE_ROW_CLASSES].sort());
  });

  test("a zero-only row states no quantity rather than a quantity of zero", () => {
    expect(classOf({})).toBe("no_quantity_stated");
    expect(classOf({ quantity_dose: 0, quantity_dose_maximum: 0 })).toBe(
      "no_quantity_stated",
    );
  });

  test("a partial range is still a range statement, not a fixed quantity", () => {
    expect(classOf({ quantity_dose_minimum: 250, quantity_dose_maximum: 0 })).toBe(
      "range_stated",
    );
    expect(classOf({ quantity_dose_minimum: 0, quantity_dose_maximum: 500 })).toBe(
      "range_stated",
    );
  });

  test("a row stating both a fixed quantity and a range is its own class", () => {
    // The only rows where the binding between the one unit column and
    // quantity_dose can be tested, so they are never folded into either side.
    expect(
      classOf({
        quantity_dose: 250,
        quantity_dose_minimum: 2,
        quantity_dose_maximum: 2,
      }),
    ).toBe("fixed_quantity_and_range_stated");
  });

  test("the class the importer already publishes from is never a candidate", () => {
    const rows = rowSet(
      [licenceRow()],
      [doseRow({ quantity_dose_minimum: 250, quantity_dose_maximum: 500 })],
    );
    const identities = readLnhpdIdentities(rows);
    expect(identities.identities).toHaveLength(1);
    expect(identities.identities[0]!.doseFacts).toHaveLength(1);
    expect(classifyDoseRow(rows.rows.productdose[0]!).doseClass).toBe("range_stated");
  });

  test("context the fact envelope has no field for is read off the row", () => {
    const bare = classifyDoseRow(inputRow(doseRow({ quantity_dose: 500 })));
    expect(bare.statesFrequency).toBe(false);
    expect(bare.statesAgeBound).toBe(false);
    expect(
      classifyDoseRow(inputRow(doseRow({ quantity_dose: 500, frequency: 3 })))
        .statesFrequency,
    ).toBe(true);
    expect(
      classifyDoseRow(inputRow(doseRow({ quantity_dose: 500, age_minimum: 19 })))
        .statesAgeBound,
    ).toBe(true);
  });
});

describe("eligibility", () => {
  const published = () =>
    rowSet(
      [licenceRow()],
      [
        doseRow({ dose_id: 1, quantity_dose_minimum: 250, quantity_dose_maximum: 500 }),
        doseRow({ dose_id: 2, quantity_dose: 500 }),
      ],
    );

  test("a bare scalar on a published product carries no row-level exclusion", () => {
    const audit = auditLnhpdDoseQuantities({ rows: published() });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    expect(report.eligibility.candidates).toBe(1);
    expect(report.eligibility.rowLevelEligible).toBe(1);
  });

  test("the sentinel the second disqualification rests on is the importer's own rule", () => {
    // The report says zero is this column set's not-stated sentinel and that the
    // importer already relies on it. Pinned here so the claim cannot outlive the
    // rule it cites.
    const held = readLnhpdIdentities(
      rowSet(
        [licenceRow()],
        [doseRow({ quantity_dose_minimum: 0, quantity_dose_maximum: 0 })],
      ),
    );
    expect(held.identities).toHaveLength(0);
    expect(held.quarantine.map((entry) => entry.reason)).toContain("missing_dose_range");
    expect(
      DOSE_CLASS_DISQUALIFICATIONS.find(
        (entry) => entry.id === "absence_is_not_an_assertion",
      )?.statement,
    ).toContain("not-stated sentinel");
  });

  test("no row-level residue makes the class eligible", () => {
    // The whole point of keeping the two levels apart: a row that dodges every
    // row-level question is still not publishable, because the disqualification
    // is about the column rather than about the row.
    const audit = auditLnhpdDoseQuantities({ rows: published() });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    expect(report.eligibility.eligible).toBe(0);
    expect(audit.counts.eligible).toBe(0);
    expect(report.verdict.representable).toBe(false);
    expect(report.eligibility.classDisqualifications.length).toBeGreaterThan(0);
  });

  test("frequency, an unpublished product and a disagreeing sibling each exclude a row", () => {
    const audit = auditLnhpdDoseQuantities({
      rows: rowSet(
        [licenceRow()],
        [
          doseRow({ dose_id: 1, quantity_dose: 500, frequency: 3 }),
          doseRow({ dose_id: 2, quantity_dose: 250 }),
          doseRow({ dose_id: 3, lnhpd_id: 9999999, quantity_dose: 100 }),
        ],
      ),
    });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    const byReason = Object.fromEntries(
      (report.eligibility.rowLevelExclusions as { reason: string; rows: number }[]).map(
        (entry) => [entry.reason, entry.rows],
      ),
    );
    expect(byReason.context_not_representable).toBe(1);
    // Rows 1 and 2 sit on one product and state different quantities in one unit.
    expect(byReason.indistinguishable_scalars_on_one_product).toBe(2);
    // Row 3 names a product no licence row resolved, and rows 1 and 2 sit on a
    // product held because its only carryable statements are these scalars.
    expect(byReason.product_not_published_by_this_batch).toBe(3);
    expect(report.eligibility.rowLevelEligible).toBe(0);
  });

  test("the exclusion overlap accounts for every candidate row", () => {
    const audit = auditLnhpdDoseQuantities({
      rows: rowSet(
        [licenceRow()],
        [
          doseRow({ dose_id: 1, quantity_dose_minimum: 250, quantity_dose_maximum: 500 }),
          doseRow({ dose_id: 2, quantity_dose: 500 }),
          doseRow({ dose_id: 3, lnhpd_id: 9999999, quantity_dose: 100, frequency: 2 }),
        ],
      ),
    });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    const total = (
      report.eligibility.exclusionOverlap as { exclusions: number; rows: number }[]
    ).reduce((sum, entry) => sum + entry.rows, 0);
    expect(total).toBe(report.eligibility.candidates);
  });

  test("two identical scalars on one product are one statement, not a disagreement", () => {
    const audit = auditLnhpdDoseQuantities({
      rows: rowSet(
        [licenceRow()],
        [
          doseRow({ dose_id: 1, quantity_dose: 500 }),
          doseRow({ dose_id: 2, quantity_dose: 500 }),
        ],
      ),
    });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    const byReason = Object.fromEntries(
      (report.eligibility.rowLevelExclusions as { reason: string; rows: number }[]).map(
        (entry) => [entry.reason, entry.rows],
      ),
    );
    expect(byReason.indistinguishable_scalars_on_one_product).toBe(0);
  });
});

describe("the audit report", () => {
  const sample = () =>
    rowSet(
      [licenceRow()],
      [
        doseRow({ dose_id: 1, quantity_dose_minimum: 250, quantity_dose_maximum: 500 }),
        doseRow({ dose_id: 2, quantity_dose: 500, frequency: 3 }),
        doseRow({ dose_id: 3, quantity_dose: 2, uom_type_desc_quantity_dose: "capsule" }),
      ],
    );

  test("auditing twice from one snapshot yields identical bytes", () => {
    const first = auditLnhpdDoseQuantities({ rows: sample() });
    const second = auditLnhpdDoseQuantities({ rows: sample() });
    expect(second.auditId).toBe(first.auditId);
    expect(second.report.contents).toBe(first.report.contents);
    expect(second.fixtures.contents).toBe(first.fixtures.contents);
  });

  test("feed order cannot change the audit's bytes", () => {
    const forward = auditLnhpdDoseQuantities({ rows: sample() });
    const reversed = sample();
    reversed.rows.productdose = [...reversed.rows.productdose]
      .reverse()
      .map((row, index) => ({ ...row, index }));
    const backward = auditLnhpdDoseQuantities({ rows: reversed });
    expect(backward.auditId).toBe(forward.auditId);
    expect(backward.report.contents).toBe(forward.report.contents);
    expect(backward.fixtures.contents).toBe(forward.fixtures.contents);
  });

  test("the audit id changes when what the audit found changes", () => {
    const other = auditLnhpdDoseQuantities({
      rows: rowSet([licenceRow()], [doseRow({ dose_id: 1, quantity_dose: 7 })]),
    });
    expect(other.auditId).not.toBe(auditLnhpdDoseQuantities({ rows: sample() }).auditId);
  });

  test("every dose row lands in exactly one class and the counts total the rows", () => {
    const audit = auditLnhpdDoseQuantities({ rows: sample() });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    const classes = report.classification.classes as { class: string; rows: number }[];
    expect(classes.map((entry) => entry.class)).toEqual([...DOSE_ROW_CLASSES]);
    expect(classes.reduce((sum, entry) => sum + entry.rows, 0)).toBe(
      report.classification.doseRows,
    );
    expect(report.classification.doseRows).toBe(3);
  });

  test("the report writes into reports/hc-lnhpd and touches no corpus directory", () => {
    const audit = auditLnhpdDoseQuantities({ rows: sample() });
    expect(audit.report.path).toBe(
      `reports/hc-lnhpd/${audit.auditId}-${DOSE_AUDIT_REPORT_KIND}.json`,
    );
    for (const file of audit.files) {
      expect(file.path).not.toMatch(/^(records|resources|masteries|manifests|schemas)\//);
    }
    expect(audit.files.map((file) => file.path).sort()).toEqual([
      audit.report.path,
      DOSE_AUDIT_FIXTURE_PATH,
    ]);
  });

  test("the report carries the OGL terms the raw rows it quotes come with", () => {
    const report = JSON.parse(
      auditLnhpdDoseQuantities({ rows: sample() }).report.contents,
    ) as Record<string, any>;
    expect(report.license).toContain("Open Government Licence");
    expect(report.attribution).toContain("Health Canada");
    expect(report.notice).toContain("not represented as an official version");
    expect(report.notice).toContain("no record, no fact and no manifest");
  });

  test("the report states a verdict without stating a dose", () => {
    const report = JSON.parse(
      auditLnhpdDoseQuantities({ rows: sample() }).report.contents,
    ) as Record<string, any>;
    expect(report.verdict.representable).toBe(false);
    expect(report.verdict.note).toContain("not a health claim");
    expect(report.changed).toEqual({
      schemas: 0,
      importerRules: 0,
      corpusFiles: 0,
      manifests: 0,
      note: expect.any(String),
    });
  });

  test("sampled rows are reproduced verbatim, with every declared column", () => {
    const audit = auditLnhpdDoseQuantities({ rows: sample() });
    const report = JSON.parse(audit.report.contents) as Record<string, any>;
    const rows = (report.samples.byClass as { rows: Record<string, unknown>[] }[])
      .flatMap((entry) => entry.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...LNHPD_COLUMNS.productdose].sort());
    }
  });
});

describe("the committed audit", () => {
  const report = committedReport();

  test("it classifies the whole download and the classes total it", () => {
    const classes = report.classification.classes as { class: string; rows: number }[];
    expect(report.classification.doseRows).toBe(207190);
    expect(classes.reduce((sum, entry) => sum + entry.rows, 0)).toBe(207190);
    const input = (report.input as { dataset: string; rowCount: number }[]).find(
      (entry) => entry.dataset === "productdose",
    );
    expect(input?.rowCount).toBe(207190);
  });

  test("it verifies the pre-audit's 9,713 rather than restating it", () => {
    const candidates = (
      report.classification.classes as { class: string; rows: number }[]
    ).find((entry) => entry.class === "fixed_quantity_mass_or_volume");
    expect(candidates?.rows).toBe(9713);
    expect(report.candidates.rows).toBe(9713);
    expect(report.eligibility.candidates).toBe(9713);
  });

  test("it concludes that no scalar fact is representable", () => {
    expect(report.eligibility.eligible).toBe(0);
    expect(report.verdict.representable).toBe(false);
  });

  test("its unit inventory still covers the download", () => {
    const unclassified = (
      report.unitColumn.buckets as { bucket: string; rows: number }[]
    ).find((entry) => entry.bucket === "unclassified");
    expect(unclassified?.rows).toBe(0);
    const spellings = report.unitColumn.spellings as { spelling: string; rows: number }[];
    expect(spellings).toHaveLength(report.unitColumn.distinctSpellings);
    expect(spellings.reduce((sum, entry) => sum + entry.rows, 0)).toBe(207190);
  });

  test("its exclusion overlap accounts for every candidate row", () => {
    const total = (
      report.eligibility.exclusionOverlap as { exclusions: number; rows: number }[]
    ).reduce((sum, entry) => sum + entry.rows, 0);
    expect(total).toBe(report.eligibility.candidates);
  });

  test("every committed fixture is a raw feed row the report sampled", () => {
    expect(FIXTURE_ROWS.length).toBeGreaterThan(0);
    const sampled = new Set(
      [
        ...(report.samples.byClass as { rows: Record<string, unknown>[] }[]).flatMap(
          (entry) => entry.rows,
        ),
        ...(report.samples.unitBindingEvidence as Record<string, unknown>[]),
        ...(report.samples.rowLevelEligibleRows as Record<string, unknown>[]),
      ].map((row) => JSON.stringify(row)),
    );
    for (const row of FIXTURE_ROWS) {
      expect(Object.keys(row).sort()).toEqual([...LNHPD_COLUMNS.productdose].sort());
      expect(sampled.has(JSON.stringify(row))).toBe(true);
    }
  });

  test("the fixtures classify as the report filed them", () => {
    const expected = new Map<string, string>();
    for (const entry of report.samples.byClass as {
      class: string;
      rows: Record<string, string | number | null>[];
    }[]) {
      for (const row of entry.rows) expected.set(JSON.stringify(row), entry.class);
    }
    let checked = 0;
    for (const row of FIXTURE_ROWS) {
      const filed = expected.get(JSON.stringify(row));
      if (filed === undefined) continue;
      expect(classifyDoseRow(inputRow(row)).doseClass).toBe(filed as DoseRowClass);
      checked += 1;
    }
    expect(checked).toBe(expected.size);
  });

  test("the class-level disqualification is illustrated by rows the download holds", () => {
    const binding = (
      report.eligibility.classDisqualifications as {
        id: string;
        statement: string;
        testableRows?: number;
        brokenRows?: number;
        observed?: { doseId: string; statedQuantity: number; statedRange: number[] }[];
      }[]
    ).find((entry) => entry.id === "unverifiable_unit_binding");
    expect(binding?.brokenRows).toBeGreaterThan(0);
    expect(binding?.testableRows).toBeGreaterThanOrEqual(binding!.brokenRows!);
    // No observed value is written into the statement itself; each one is
    // attached from a row, and every row it names is a row the report sampled.
    expect(binding?.statement).not.toMatch(/[0-9]/);
    const sampled = new Set(
      (report.samples.unitBindingEvidence as Record<string, string | number | null>[]).map(
        (row) => String(row.dose_id),
      ),
    );
    for (const entry of binding?.observed ?? []) {
      expect(sampled.has(entry.doseId)).toBe(true);
      const [minimum, maximum] = entry.statedRange;
      expect(
        entry.statedQuantity < minimum! || entry.statedQuantity > maximum!,
      ).toBe(true);
    }
    expect(binding?.observed?.length).toBeGreaterThan(0);
  });

  test("the unit-binding evidence really does contradict its own row", () => {
    const evidence = report.samples.unitBindingEvidence as Record<
      string,
      string | number | null
    >[];
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) {
      const read = classifyDoseRow(inputRow(row));
      expect(read.doseClass).toBe("fixed_quantity_and_range_stated");
      const { quantity, minimum, maximum } = read;
      expect(quantity).not.toBeNull();
      expect(maximum).toBeGreaterThan(0);
      // One unit column, two numbers it cannot both describe.
      expect(quantity! < minimum! || quantity! > maximum!).toBe(true);
    }
  });

  test("the audit changed nothing it audits", () => {
    expect(report.changed.schemas).toBe(0);
    expect(report.changed.importerRules).toBe(0);
    expect(report.changed.corpusFiles).toBe(0);
    expect(report.changed.manifests).toBe(0);
    // The audit id is derived like a batch id but names no batch: no manifest
    // lists it, and nothing in the corpus points at this file.
    const manifests = readdirSync(resolve(ROOT, "manifests", "hc-lnhpd"));
    expect(manifests).not.toContain(`${report.auditId}.yaml`);
  });
});
