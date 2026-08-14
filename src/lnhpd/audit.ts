import {
  LNHPD_ATTRIBUTION,
  LNHPD_ID_PATTERN,
  LNHPD_LICENSE,
  LNHPD_SOURCE_NAME,
  LNHPD_SOURCE_NAMESPACE,
  byString,
  collapseSourceText,
  deriveBatchId,
  doseUnitFor,
} from "./format.ts";
import type { RecordFactUnit } from "./format.ts";
import { readLnhpdIdentities } from "./identity.ts";
import { REPORTS_DIRECTORY, REPORT_VERSION } from "./plan.ts";
import type { PlannedFile } from "./plan.ts";
import type { LnhpdInputRow, LnhpdRowSet } from "./read.ts";

/**
 * An audit, and only an audit: can LNHPD's fixed `quantity_dose` column support
 * an honest scalar attributed fact?
 *
 * Nothing here writes a record, changes a schema, widens what the importer
 * accepts or touches the corpus. It reads the same acquired snapshot the
 * importer reads, classifies **every** `productdose` row into one closed
 * vocabulary, and publishes the counts, the raw rows behind them and the
 * findings they support. A truthful "no" is the outcome this is built to be able
 * to reach — the report states what the feed does, not what the corpus should do
 * about it.
 *
 * **Why the question exists.** `format.ts` deliberately leaves `quantity_dose`
 * unread: the corpus fact kind is a *range*, and re-expressing a single stated
 * quantity as a range whose minimum equals its maximum would publish a range no
 * licence holder stated. That leaves the column unexamined rather than settled,
 * and a pre-audit counted 9,713 rows stating a fixed quantity in a unit the fact
 * vocabulary already holds. Whether those 9,713 are publishable is the question,
 * and it is answered from the canonical download rather than from that count.
 *
 * **Two levels of question, kept apart.** A *row-level* exclusion is about one
 * row: it states a frequency the envelope cannot carry, or its product is not
 * published. A *class-level* disqualification is about the column itself and
 * therefore about every row in the class at once — no count of surviving rows
 * rescues it. Reporting them in one merged list would let a reader trade the
 * second off against the first, which is exactly the trade this audit exists to
 * refuse.
 *
 * **The audit reads the feed on its own terms.** It re-derives its own cell
 * readers rather than borrowing the importer's, because it is auditing the data
 * and not the importer: if `identity.ts` later changed how it reads a cell, an
 * audit that inherited the change would silently restate its findings about a
 * feed that had not moved.
 */

/** Bump when a classification rule or the report shape changes. */
export const DOSE_AUDIT_VERSION = "hc-lnhpd-dose-quantity-1";

/** The report kind, as `reports/<source>/<id>-<kind>.json` spells it. */
export const DOSE_AUDIT_REPORT_KIND = "dose-quantity-audit";

/**
 * How many raw rows per class reach the report and the fixtures.
 *
 * Smaller than the import quarantine's 25 on purpose. The counts here are
 * complete and the unit inventory is published whole, so the samples are worked
 * examples rather than a summary — five is enough to settle a class by hand, and
 * every one of them is also a committed test fixture.
 */
export const DOSE_AUDIT_SAMPLE_SIZE = 5;

/** Where the sampled raw rows are committed so tests need no 74 MB snapshot. */
export const DOSE_AUDIT_FIXTURE_PATH =
  "tests/fixtures/lnhpd/productdose-audit-rows.json";

/**
 * What the unit column names, where it does not name a mass or a volume.
 *
 * **Explanatory only.** Eligibility turns on exactly one thing: whether
 * `doseUnitFor` maps the spelling onto a corpus fact unit. Every other bucket is
 * excluded either way, so a spelling filed under `imperial_measure` rather than
 * `activity_or_potency` changes the sentence a reader gets and nothing else.
 * That is deliberate: the buckets are here to explain 174,273 rows of "counted
 * in capsules" without asking a reviewer to read 179 spellings, not to decide
 * anything.
 */
export const DOSE_UNIT_BUCKETS = [
  "mass_or_volume",
  "dosage_form_count",
  "ratio_or_proportion",
  "activity_or_potency",
  "imperial_measure",
  "placeholder",
  "unstated",
  "unclassified",
] as const;

export type DoseUnitBucket = (typeof DOSE_UNIT_BUCKETS)[number];

export const DOSE_UNIT_BUCKET_DETAIL: Readonly<Record<DoseUnitBucket, string>> = {
  mass_or_volume:
    "A mass or a volume the closed corpus fact vocabulary holds. The only bucket a fact could be carried in.",
  dosage_form_count:
    "Counts a dosage form rather than measuring an amount: a capsule, a scoop, a spray, half a teaspoon. How much substance one of them holds is not on the row.",
  ratio_or_proportion:
    "States an amount per something else, or a percentage. It is a strength rather than an absolute quantity, and folding it onto its numerator would be wrong by whatever the denominator was.",
  activity_or_potency:
    "A biological-activity unit or a homeopathic dilution notation. It states potency rather than an amount of substance, and the corpus vocabulary has no member for it.",
  imperial_measure:
    "A real measure with no corpus member, and one whose mass or volume sense the row does not state.",
  placeholder:
    "The feed's own stand-in for a unit that was never entered. It names no measure at all.",
  unstated: "The row leaves the unit column empty, so its numbers measure nothing.",
  unclassified:
    "A spelling this audit's inventory does not name. Zero of these means the inventory still covers the feed; any of them means the feed has moved and the inventory is stale.",
};

/**
 * Every non-mass, non-volume spelling observed in `uom_type_desc_quantity_dose`
 * across the whole download, filed under what it names.
 *
 * An inventory, not a parser, for the reason `LNHPD_DOSE_UNITS` gives: these are
 * Health Canada's own strings, matched exactly, and a spelling that is not here
 * is reported as `unclassified` rather than guessed at. The mass and volume
 * spellings are deliberately absent — `doseUnitFor` already owns that list, and
 * restating it here would let the two disagree.
 */
export const DOSE_UNIT_INVENTORY: Readonly<Record<string, DoseUnitBucket>> = {
  "%": "ratio_or_proportion",
  "% (w/w)": "ratio_or_proportion",
  "-": "placeholder",
  "1/2 tablespoon": "dosage_form_count",
  "1/2 teaspoon": "dosage_form_count",
  "1/4 tablespoon": "dosage_form_count",
  "1/4 teaspoon": "dosage_form_count",
  "1X": "activity_or_potency",
  "3/4 teaspoon": "dosage_form_count",
  Aerosol: "dosage_form_count",
  Application: "dosage_form_count",
  Applicator: "dosage_form_count",
  "Aérosol": "dosage_form_count",
  Bag: "dosage_form_count",
  "Bagged granule": "dosage_form_count",
  Bar: "dosage_form_count",
  "Bar, soap": "dosage_form_count",
  "Billion colony forming units per gram": "ratio_or_proportion",
  Block: "dosage_form_count",
  "Block(s)": "dosage_form_count",
  Bottle: "dosage_form_count",
  C: "activity_or_potency",
  CH: "activity_or_potency",
  CHWGELU: "dosage_form_count",
  Can: "dosage_form_count",
  "Cap full, liquid": "dosage_form_count",
  "Capsule, delayed release": "dosage_form_count",
  "Capsule, soft": "dosage_form_count",
  Chew: "dosage_form_count",
  "Chewable gel": "dosage_form_count",
  Cleanser: "dosage_form_count",
  Cup: "dosage_form_count",
  D: "activity_or_potency",
  Dentifrice: "dosage_form_count",
  "Dosage Form": "placeholder",
  Douche: "dosage_form_count",
  "Drop(s)": "dosage_form_count",
  "Drop(s)/kg BW": "ratio_or_proportion",
  Droplettes: "dosage_form_count",
  Dropper: "dosage_form_count",
  "Dropper(s) full": "dosage_form_count",
  Droppers: "dosage_form_count",
  Drops: "dosage_form_count",
  Enema: "dosage_form_count",
  "Film strip": "dosage_form_count",
  Foam: "dosage_form_count",
  Foundation: "dosage_form_count",
  Gel: "dosage_form_count",
  Globules: "dosage_form_count",
  Granules: "dosage_form_count",
  Gum: "dosage_form_count",
  "Gum, chewing": "dosage_form_count",
  "Gum, resin": "dosage_form_count",
  "Gummy slice": "dosage_form_count",
  Inhalation: "dosage_form_count",
  Kit: "dosage_form_count",
  LU: "activity_or_potency",
  "LU/kg": "ratio_or_proportion",
  Liniment: "dosage_form_count",
  "Lollipop(s)": "dosage_form_count",
  Lotion: "dosage_form_count",
  Lozenge: "dosage_form_count",
  "Measuring Cup": "dosage_form_count",
  Mousse: "dosage_form_count",
  Oil: "dosage_form_count",
  Ointment: "dosage_form_count",
  Ovule: "dosage_form_count",
  Paste: "dosage_form_count",
  Pastille: "dosage_form_count",
  Pearl: "dosage_form_count",
  Pessary: "dosage_form_count",
  Pill: "dosage_form_count",
  Pouch: "dosage_form_count",
  Powder: "dosage_form_count",
  "Quantity Unit TBA": "placeholder",
  Salve: "dosage_form_count",
  Scrub: "dosage_form_count",
  Serving: "dosage_form_count",
  "Serving(s)": "dosage_form_count",
  Shampoo: "dosage_form_count",
  Shots: "dosage_form_count",
  "Single dosage": "dosage_form_count",
  Sleeve: "dosage_form_count",
  "Soap, liquid": "dosage_form_count",
  "Soft chew": "dosage_form_count",
  Softchew: "dosage_form_count",
  "Softgel capsule": "dosage_form_count",
  "Softgel, chewable": "dosage_form_count",
  Solid: "dosage_form_count",
  Solution: "dosage_form_count",
  "Sponge(s)": "dosage_form_count",
  Spoon: "dosage_form_count",
  "Spoon (provided in packaging)": "dosage_form_count",
  "Spoon with soup": "dosage_form_count",
  Spray: "dosage_form_count",
  Stick: "dosage_form_count",
  "Stick Pack": "dosage_form_count",
  "Sublingual tablet": "dosage_form_count",
  "Sugar-coated table": "dosage_form_count",
  Swab: "dosage_form_count",
  Syringe: "dosage_form_count",
  "Table spoon": "dosage_form_count",
  "Tbsp.": "dosage_form_count",
  "Thin layer": "dosage_form_count",
  Tray: "dosage_form_count",
  Truffle: "dosage_form_count",
  Tube: "dosage_form_count",
  "USP units": "activity_or_potency",
  Uni: "dosage_form_count",
  Unit: "dosage_form_count",
  "Vaginal injection(s)": "dosage_form_count",
  "Vapour from liquid": "dosage_form_count",
  "Vapour from solid": "dosage_form_count",
  Vcapsule: "dosage_form_count",
  Vitapak: "dosage_form_count",
  X: "activity_or_potency",
  ampoule: "dosage_form_count",
  "billion cfu": "activity_or_potency",
  bolus: "dosage_form_count",
  "cap full": "dosage_form_count",
  capful: "dosage_form_count",
  caplet: "dosage_form_count",
  capsule: "dosage_form_count",
  cartridge: "dosage_form_count",
  "chewable tablet": "dosage_form_count",
  container: "dosage_form_count",
  cord: "dosage_form_count",
  cream: "dosage_form_count",
  "delineated section": "dosage_form_count",
  "disc(s)": "dosage_form_count",
  dose: "dosage_form_count",
  each: "dosage_form_count",
  "g/g": "ratio_or_proportion",
  "g/kg": "ratio_or_proportion",
  "gel capsule": "dosage_form_count",
  globule: "dosage_form_count",
  granule: "dosage_form_count",
  gummies: "dosage_form_count",
  "half-tablespoon": "dosage_form_count",
  "half-teaspoon": "dosage_form_count",
  liquid: "dosage_form_count",
  mask: "dosage_form_count",
  "million CFU/g": "ratio_or_proportion",
  "mince couche": "dosage_form_count",
  "ml/kg": "ratio_or_proportion",
  "ounce(s)": "imperial_measure",
  oz: "imperial_measure",
  pack: "dosage_form_count",
  packet: "dosage_form_count",
  pad: "dosage_form_count",
  patch: "dosage_form_count",
  "pea-size": "dosage_form_count",
  pellet: "dosage_form_count",
  "piece(s)": "dosage_form_count",
  plaster: "dosage_form_count",
  pumps: "dosage_form_count",
  "quarter teaspoon": "dosage_form_count",
  sachet: "dosage_form_count",
  scoop: "dosage_form_count",
  softgel: "dosage_form_count",
  strip: "dosage_form_count",
  suppository: "dosage_form_count",
  tablespoons: "dosage_form_count",
  tablet: "dosage_form_count",
  "tea bag": "dosage_form_count",
  "tea spoon": "dosage_form_count",
  teaspoons: "dosage_form_count",
  vial: "dosage_form_count",
  wafer: "dosage_form_count",
  wipe: "dosage_form_count",
  "Ø": "activity_or_potency",
};

export const doseUnitBucketFor = (spelling: string): DoseUnitBucket => {
  if (spelling === "") return "unstated";
  if (doseUnitFor(spelling) !== null) return "mass_or_volume";
  return Object.hasOwn(DOSE_UNIT_INVENTORY, spelling)
    ? DOSE_UNIT_INVENTORY[spelling]!
    : "unclassified";
};

/**
 * What one dose row is, asked in the order a reviewer would ask it, so a row
 * reports the earliest thing that settles it.
 *
 * Exhaustive and mutually exclusive: every row of the download lands in exactly
 * one class and the counts total the download. `fixed_quantity_mass_or_volume`
 * is the candidate class — the only one a scalar fact could ever come from — and
 * every other class is here so that the candidate count is a residue that can be
 * checked rather than a filter that can be trusted.
 */
export const DOSE_ROW_CLASSES = [
  "invalid_product_identifier",
  "invalid_dose_identifier",
  "unreadable_quantity",
  "negative_quantity",
  "fixed_quantity_and_range_stated",
  "range_stated",
  "no_quantity_stated",
  "fixed_quantity_mass_or_volume",
  "fixed_quantity_dosage_form_count",
  "fixed_quantity_ratio_or_proportion",
  "fixed_quantity_activity_or_potency",
  "fixed_quantity_imperial_measure",
  "fixed_quantity_placeholder_unit",
  "fixed_quantity_unstated_unit",
  "fixed_quantity_unclassified_unit",
] as const;

export type DoseRowClass = (typeof DOSE_ROW_CLASSES)[number];

export const DOSE_ROW_CLASS_DETAIL: Readonly<Record<DoseRowClass, string>> = {
  invalid_product_identifier:
    "lnhpd_id is not a positive integer, so the row names no product.",
  invalid_dose_identifier:
    "dose_id is not a positive integer, so a fact could not cite the row it came from.",
  unreadable_quantity:
    "A quantity column holds something that is not a number, so the row states no quantity to read.",
  negative_quantity:
    "A quantity column is negative, which is not a quantity of anything.",
  fixed_quantity_and_range_stated:
    "The row states a fixed quantity_dose and a range under one unit column. Both cannot be the stated dose in that unit, so this class is where the unit binding can actually be tested.",
  range_stated:
    "quantity_dose is zero and a bound is stated, so the row is a range statement. A partial range with a zero bound is included: it is still a range rather than a fixed quantity, and the existing dose_range importer already decides its fate.",
  no_quantity_stated:
    "All three quantity columns are zero. Zero is this column set's not-stated sentinel, so the row states no quantity at all.",
  fixed_quantity_mass_or_volume:
    "quantity_dose alone is stated, under a unit spelling that names a mass or volume the corpus fact vocabulary holds. The candidate class.",
  fixed_quantity_dosage_form_count:
    "quantity_dose alone is stated, counting a dosage form rather than measuring an amount.",
  fixed_quantity_ratio_or_proportion:
    "quantity_dose alone is stated, under a ratio or a percentage rather than an absolute amount.",
  fixed_quantity_activity_or_potency:
    "quantity_dose alone is stated, under an activity unit or a homeopathic dilution notation.",
  fixed_quantity_imperial_measure:
    "quantity_dose alone is stated, under an imperial measure the corpus vocabulary has no member for.",
  fixed_quantity_placeholder_unit:
    "quantity_dose alone is stated, under the feed's own placeholder for a unit that was never entered.",
  fixed_quantity_unstated_unit:
    "quantity_dose alone is stated and the unit column is empty, so the number measures nothing.",
  fixed_quantity_unclassified_unit:
    "quantity_dose alone is stated, under a spelling this audit's inventory does not name.",
};

/** The three columns whose one shared unit column is the whole question. */
const QUANTITY_COLUMNS = [
  "quantity_dose",
  "quantity_dose_minimum",
  "quantity_dose_maximum",
] as const;

const textOrNull = (value: string | number | null): string | null => {
  if (value === null) return null;
  const collapsed = collapseSourceText(String(value));
  return collapsed === "" ? null : collapsed;
};

const numberOrNull = (value: string | number | null): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null) return null;
  const collapsed = collapseSourceText(value);
  if (collapsed === "") return null;
  const parsed = Number(collapsed);
  return Number.isFinite(parsed) ? parsed : null;
};

const idOrNull = (value: string | number | null): string | null => {
  const text = textOrNull(value);
  if (text === null) return null;
  return LNHPD_ID_PATTERN.test(text) ? text : null;
};

/** Zero and absent are the same statement in this feed: nothing was entered. */
const stated = (value: string | number | null): boolean =>
  (numberOrNull(value) ?? 0) !== 0;

export type DoseRowClassification = {
  doseClass: DoseRowClass;
  lnhpdId: string | null;
  doseId: string | null;
  /** The unit spelling as the feed wrote it, whitespace collapsed. */
  unitSpelling: string;
  unitBucket: DoseUnitBucket;
  /** The corpus unit the spelling maps onto, where one exists. */
  factUnit: RecordFactUnit | null;
  quantity: number | null;
  minimum: number | null;
  maximum: number | null;
  /** Context the fact envelope has no field for. */
  statesFrequency: boolean;
  statesAgeBound: boolean;
  population: string | null;
};

export const classifyDoseRow = (row: LnhpdInputRow): DoseRowClassification => {
  const columns = row.columns;
  const unitSpelling = collapseSourceText(
    String(columns.uom_type_desc_quantity_dose ?? ""),
  );
  const unitBucket = doseUnitBucketFor(unitSpelling);
  const quantity = numberOrNull(columns.quantity_dose ?? null);
  const minimum = numberOrNull(columns.quantity_dose_minimum ?? null);
  const maximum = numberOrNull(columns.quantity_dose_maximum ?? null);

  const base = {
    lnhpdId: idOrNull(columns.lnhpd_id ?? null),
    doseId: idOrNull(columns.dose_id ?? null),
    unitSpelling,
    unitBucket,
    factUnit: doseUnitFor(unitSpelling),
    quantity,
    minimum,
    maximum,
    statesFrequency:
      stated(columns.frequency ?? null) ||
      stated(columns.frequency_minimum ?? null) ||
      stated(columns.frequency_maximum ?? null),
    statesAgeBound:
      stated(columns.age ?? null) ||
      stated(columns.age_minimum ?? null) ||
      stated(columns.age_maximum ?? null),
    population: textOrNull(columns.population_type_desc ?? null),
  };

  const at = (doseClass: DoseRowClass): DoseRowClassification => ({
    ...base,
    doseClass,
  });

  if (base.lnhpdId === null) return at("invalid_product_identifier");
  if (base.doseId === null) return at("invalid_dose_identifier");

  const numbers = QUANTITY_COLUMNS.map((column) =>
    numberOrNull(columns[column] ?? null),
  );
  if (numbers.some((value) => value === null)) return at("unreadable_quantity");
  if (numbers.some((value) => (value ?? 0) < 0)) return at("negative_quantity");

  const hasRange = (minimum ?? 0) > 0 || (maximum ?? 0) > 0;
  const hasFixed = (quantity ?? 0) > 0;
  if (hasFixed && hasRange) return at("fixed_quantity_and_range_stated");
  if (hasRange) return at("range_stated");
  if (!hasFixed) return at("no_quantity_stated");

  switch (unitBucket) {
    case "mass_or_volume":
      return at("fixed_quantity_mass_or_volume");
    case "dosage_form_count":
      return at("fixed_quantity_dosage_form_count");
    case "ratio_or_proportion":
      return at("fixed_quantity_ratio_or_proportion");
    case "activity_or_potency":
      return at("fixed_quantity_activity_or_potency");
    case "imperial_measure":
      return at("fixed_quantity_imperial_measure");
    case "placeholder":
      return at("fixed_quantity_placeholder_unit");
    case "unstated":
      return at("fixed_quantity_unstated_unit");
    case "unclassified":
      return at("fixed_quantity_unclassified_unit");
  }
};

/**
 * Why one candidate row could not become a fact, asked per row.
 *
 * Deliberately **overlapping**: a row can fail several of these at once and the
 * report says so, because collapsing them into a first-blocking reason would
 * make each reason's reach depend on the order they happen to be listed in. The
 * arithmetic still closes — the report publishes how many rows carry zero, one,
 * two or three of them.
 */
export const DOSE_ROW_EXCLUSIONS = [
  "context_not_representable",
  "indistinguishable_scalars_on_one_product",
  "product_not_published_by_this_batch",
] as const;

export type DoseRowExclusion = (typeof DOSE_ROW_EXCLUSIONS)[number];

export const DOSE_ROW_EXCLUSION_DETAIL: Readonly<
  Record<DoseRowExclusion, string>
> = {
  context_not_representable:
    "The row states a frequency, an age bound, or both. The record fact envelope has no field for either, so the quantity would be published stripped of the thing that says how often it is taken and by whom.",
  indistinguishable_scalars_on_one_product:
    "The product carries two or more fixed mass or volume rows stating different quantities, separated in the feed only by population or age. On one record they would land as several bare scalars with nothing to tell an infant's from an adult's.",
  product_not_published_by_this_batch:
    "The row's lnhpd_id does not resolve to a product this batch publishes, so there is no record for the quantity to attach to. Publishing it would mean minting records on the strength of the quantity alone.",
};

/**
 * Why the class fails as a class, whatever any individual row does.
 *
 * These are not counted per row because counting them would invite the trade
 * this audit refuses: no number of rows that dodge the row-level exclusions
 * makes a column mean something it does not mean.
 *
 * The statements carry no observed values. What the download shows is attached
 * at audit time from the rows that show it, so a snapshot in which the feed had
 * moved could not publish a disqualification illustrated by rows it no longer
 * holds.
 */
export const DOSE_CLASS_DISQUALIFICATIONS = [
  {
    id: "unverifiable_unit_binding",
    statement:
      "One uom_type_desc_quantity_dose column serves three quantity columns, so nothing on a row says which of them the unit describes. Where the binding can be checked at all — the rows stating both a fixed quantity and a range — the download is observed to break it. A fixed-only row carries no second value to check against, so reading it as 'N <unit>' asserts a binding this download shows is not always there.",
  },
  {
    id: "absence_is_not_an_assertion",
    statement:
      "The fixed-only shape is defined by two zeros rather than by anything the licence holder stated. Zero is this column set's not-stated sentinel — the importer already relies on that to refuse a zero maximum — and the feed carries no flag saying a dose is fixed. So 'fixed' here is the absence of a range, which is not the same statement as a dose that is fixed.",
  },
] as const;

export type LnhpdDoseAuditOptions = {
  rows: LnhpdRowSet;
  sampleSize?: number;
};

export type LnhpdDoseAudit = {
  auditId: string;
  retrievedAt: string;
  /** The report and the committed fixtures it samples, in path order. */
  files: PlannedFile[];
  report: PlannedFile;
  fixtures: PlannedFile;
  classifications: DoseRowClassification[];
  counts: { doseRows: number; candidates: number; eligible: number };
};

type ClassifiedRow = {
  classification: DoseRowClassification;
  columns: Record<string, string | number | null>;
};

/** A total order that never consults feed position, so feed order cannot reach a file. */
const bySampleKey = (left: ClassifiedRow, right: ClassifiedRow): number => {
  const leftId = Number(left.classification.doseId ?? Number.MAX_SAFE_INTEGER);
  const rightId = Number(right.classification.doseId ?? Number.MAX_SAFE_INTEGER);
  if (leftId !== rightId) return leftId - rightId;
  return byString(JSON.stringify(left.columns), JSON.stringify(right.columns));
};

/** Raw columns, key-sorted, exactly as the feed published the values. */
const verbatim = (
  columns: Record<string, string | number | null>,
): Record<string, string | number | null> => {
  const ordered: Record<string, string | number | null> = {};
  for (const key of Object.keys(columns).sort(byString)) {
    ordered[key] = columns[key] ?? null;
  }
  return ordered;
};

/**
 * The upper of the two middle values where the count is even, rather than their
 * average. Every number this audit publishes is then one the column actually
 * holds: interpolating would put a quantity in a Health Canada report that no
 * licence holder stated, which is the one thing a reproduction must not do.
 */
const medianObserved = (sorted: readonly number[]): number =>
  sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);

const serializeReport = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

/**
 * The audit's own OGL notice. The report reproduces raw Health Canada rows
 * verbatim, so it carries the licence's conditions the same way a manifest does,
 * and then says what this file is: an audit that publishes nothing.
 */
export const DOSE_AUDIT_NOTICE =
  "This Information has been modified from the original published by Health Canada only by selection: rows are counted and a bounded sample of them is reproduced verbatim, with whitespace collapsed in the unit and population strings that are quoted in prose. It is not represented as an official version of the Information, nor as one endorsed by Health Canada or by the Government of Canada. This file is an audit of an acquired snapshot, not an import: it publishes no record, no fact and no manifest, it changed no schema, no importer rule and no corpus file, and the id it carries is an audit id that no manifest names. Nothing in it is a recommendation, an intake target, an upper limit, an evidence claim or a statement about a safe dose; the quantities quoted are reproduced to show what the column contains, not to say what anyone should take.";

export const DOSE_AUDIT_QUESTION =
  "Can LNHPD's fixed quantity_dose column support an honest scalar attributed fact in this corpus?";

/**
 * Classifies the whole download and reports what it found.
 *
 * Pure: no clock, no filesystem, no corpus. `retrieved_at` comes from the
 * acquisition receipt and every ordering is by upstream id, so two runs over one
 * snapshot emit identical bytes and a snapshot whose rows arrive in a different
 * order emits identical bytes too.
 */
export const auditLnhpdDoseQuantities = ({
  rows,
  sampleSize = DOSE_AUDIT_SAMPLE_SIZE,
}: LnhpdDoseAuditOptions): LnhpdDoseAudit => {
  const classified: ClassifiedRow[] = rows.rows.productdose.map((row) => ({
    classification: classifyDoseRow(row),
    columns: verbatim(row.columns),
  }));

  // Which products this batch would publish, from the same snapshot and the same
  // rules the importer uses. The corpus is deliberately not consulted: an audit
  // whose numbers moved with the corpus could not be reproduced from canonical
  // inputs alone, and this one changes nothing in the corpus to be reconciled
  // against.
  const published = new Set(
    readLnhpdIdentities(rows).identities.map(
      (identity) => identity.sourceRecordId,
    ),
  );

  const candidates = classified.filter(
    (entry) => entry.classification.doseClass === "fixed_quantity_mass_or_volume",
  );

  // A product whose candidate rows do not agree on one quantity. Keyed by the
  // pair a fact would actually publish, so two rows stating the same amount are
  // one statement repeated rather than a disagreement.
  const quantitiesByProduct = new Map<string, Set<string>>();
  for (const { classification } of candidates) {
    const key = `${classification.quantity} ${classification.factUnit}`;
    const held = quantitiesByProduct.get(classification.lnhpdId ?? "");
    if (held) held.add(key);
    else quantitiesByProduct.set(classification.lnhpdId ?? "", new Set([key]));
  }

  const exclusionsFor = (row: DoseRowClassification): DoseRowExclusion[] => {
    const found: DoseRowExclusion[] = [];
    if (row.statesFrequency || row.statesAgeBound) {
      found.push("context_not_representable");
    }
    if ((quantitiesByProduct.get(row.lnhpdId ?? "")?.size ?? 0) > 1) {
      found.push("indistinguishable_scalars_on_one_product");
    }
    if (!published.has(row.lnhpdId ?? "")) {
      found.push("product_not_published_by_this_batch");
    }
    return found;
  };

  const excluded = candidates.map((entry) => ({
    entry,
    exclusions: exclusionsFor(entry.classification),
  }));

  const exclusionCounts = DOSE_ROW_EXCLUSIONS.map((reason) => ({
    reason,
    rows: excluded.filter((held) => held.exclusions.includes(reason)).length,
    detail: DOSE_ROW_EXCLUSION_DETAIL[reason],
  }));

  const overlap = [0, 1, 2, 3].map((count) => ({
    exclusions: count,
    rows: excluded.filter((held) => held.exclusions.length === count).length,
  }));

  const rowLevelEligible = excluded.filter(
    (held) => held.exclusions.length === 0,
  );

  const classCounts = DOSE_ROW_CLASSES.map((doseClass) => ({
    class: doseClass,
    rows: classified.filter((entry) => entry.classification.doseClass === doseClass)
      .length,
    detail: DOSE_ROW_CLASS_DETAIL[doseClass],
  }));

  // Every spelling the column holds, with what it was filed under. Published
  // whole rather than sampled: it is the only part of this audit a reviewer
  // cannot re-derive from the counts, and it is what makes the inventory
  // checkable against the feed instead of taken on trust.
  const spellingRows = new Map<string, number>();
  for (const { classification } of classified) {
    spellingRows.set(
      classification.unitSpelling,
      (spellingRows.get(classification.unitSpelling) ?? 0) + 1,
    );
  }
  const spellings = [...spellingRows.keys()].sort(byString).map((spelling) => ({
    spelling,
    bucket: doseUnitBucketFor(spelling),
    rows: spellingRows.get(spelling) ?? 0,
  }));

  const buckets = DOSE_UNIT_BUCKETS.map((bucket) => ({
    bucket,
    spellings: spellings.filter((entry) => entry.bucket === bucket).length,
    rows: spellings
      .filter((entry) => entry.bucket === bucket)
      .reduce((total, entry) => total + entry.rows, 0),
    detail: DOSE_UNIT_BUCKET_DETAIL[bucket],
  }));

  // What one unit spans once quantity_dose is read under the row's unit column.
  // Reported as observation, not judgement: the audit says how far apart the
  // numbers are, and says nothing about what quantity would be safe.
  const distribution = [...new Set(candidates.map((e) => e.classification.factUnit))]
    .filter((unit): unit is RecordFactUnit => unit !== null)
    .sort(byString)
    .map((unit) => {
      const values = candidates
        .filter((entry) => entry.classification.factUnit === unit)
        .map((entry) => entry.classification.quantity ?? 0)
        .sort((left, right) => left - right);
      return {
        unit,
        rows: values.length,
        minimum: values[0] ?? 0,
        medianObserved: medianObserved(values),
        maximum: values[values.length - 1] ?? 0,
      };
    });

  // The rows where the unit binding can actually be tested, and the ones that
  // fail the test. This is the whole evidential basis of the first class-level
  // disqualification, so it is counted rather than asserted.
  const costated = classified.filter(
    (entry) =>
      entry.classification.doseClass === "fixed_quantity_and_range_stated",
  );
  // Sorted so the rows in mass and volume units come first. The disqualification
  // is about the unit column as a whole, but a reviewer weighing it against the
  // candidate class is owed the contradictions in the candidate class's own
  // units rather than five rows counted in capsules.
  const contradicting = costated
    .filter((entry) => {
      const { quantity, minimum, maximum } = entry.classification;
      if (quantity === null || minimum === null || maximum === null) return false;
      if (maximum === 0) return false;
      return quantity < minimum || quantity > maximum;
    })
    .sort(
      (left, right) =>
        Number(right.classification.factUnit !== null) -
          Number(left.classification.factUnit !== null) || bySampleKey(left, right),
    );

  const contradictingInFactUnits = contradicting.filter(
    (entry) => entry.classification.factUnit !== null,
  );

  // What the broken binding looks like, taken from the rows that broke it rather
  // than written into the disqualification as prose that could go stale.
  const observedBreaks = contradicting.slice(0, sampleSize).map((entry) => {
    const { doseId, quantity, minimum, maximum, unitSpelling } = entry.classification;
    return {
      doseId,
      statedQuantity: quantity,
      statedRange: [minimum, maximum],
      unitSpelling,
    };
  });

  const disqualifications = DOSE_CLASS_DISQUALIFICATIONS.map((entry) =>
    entry.id === "unverifiable_unit_binding"
      ? {
          ...entry,
          testableRows: costated.length,
          brokenRows: contradicting.length,
          brokenRowsInFactUnits: contradictingInFactUnits.length,
          observed: observedBreaks,
        }
      : entry,
  );

  const productsWithCandidates = quantitiesByProduct.size;
  const publishedProductsWithCandidates = [...quantitiesByProduct.keys()].filter(
    (lnhpdId) => published.has(lnhpdId),
  ).length;
  const disagreeingProducts = [...quantitiesByProduct.values()].filter(
    (set) => set.size > 1,
  ).length;

  const samplesByClass = DOSE_ROW_CLASSES.map((doseClass) => ({
    class: doseClass,
    rows: classified
      .filter((entry) => entry.classification.doseClass === doseClass)
      .sort(bySampleKey)
      .slice(0, sampleSize)
      .map((entry) => entry.columns),
  })).filter((entry) => entry.rows.length > 0);

  const evidenceRows = [
    ...contradicting.slice(0, sampleSize).map((entry) => entry.columns),
    ...rowLevelEligible.map((held) => held.entry.columns),
  ];

  const findings = [
    {
      id: "unit_binding_fails_where_it_can_be_tested",
      statement:
        `Of ${costated.length} rows stating both a fixed quantity and a range under one unit column, ` +
        `${contradicting.length} put quantity_dose outside the range stated under that same unit, and ` +
        `${contradictingInFactUnits.length} of those are in a mass or volume unit the corpus fact ` +
        `vocabulary holds. Those rows are the only place in the download where the binding between the ` +
        `unit column and quantity_dose can be tested at all, and it does not hold there.`,
      rows: contradicting.length,
      evidence: contradicting
        .slice(0, sampleSize)
        .map((entry) => entry.classification.doseId),
    },
    {
      id: "the_candidate_class_carries_no_second_value",
      statement:
        `All ${candidates.length} candidate rows state quantity_dose with both range bounds at zero, so none ` +
        `of them carries the second value that would let the unit binding be checked. The pre-audit count ` +
        `of 9,713 is reproduced here from the canonical download; what it counts is rows whose reading is ` +
        `unverifiable, not rows that are ready.`,
      rows: candidates.length,
      evidence: [],
    },
    {
      id: "context_the_fact_envelope_cannot_carry",
      statement:
        `${exclusionCounts.find((entry) => entry.reason === "context_not_representable")?.rows ?? 0} of ` +
        `${candidates.length} candidate rows state a frequency, an age bound or both. A scalar published ` +
        `from one of them would lose how often the quantity is taken and who it is for.`,
      rows:
        exclusionCounts.find((entry) => entry.reason === "context_not_representable")
          ?.rows ?? 0,
      evidence: [],
    },
    {
      id: "one_product_several_irreconcilable_scalars",
      statement:
        `${disagreeingProducts} of ${productsWithCandidates} products carrying candidate rows state more than ` +
        `one quantity in one unit, separated only by population or age. On a record those become several bare ` +
        `scalars with nothing to say which reader each belongs to.`,
      rows:
        exclusionCounts.find(
          (entry) => entry.reason === "indistinguishable_scalars_on_one_product",
        )?.rows ?? 0,
      evidence: [],
    },
    {
      id: "almost_nothing_attaches_to_a_published_product",
      statement:
        `${publishedProductsWithCandidates} of ${productsWithCandidates} products carrying candidate rows are ` +
        `published by this batch. Accepting the class would either add a fact to a handful of existing records ` +
        `or mint thousands of new ones on the strength of the quantity alone.`,
      rows:
        candidates.length -
        (exclusionCounts.find(
          (entry) => entry.reason === "product_not_published_by_this_batch",
        )?.rows ?? 0),
      evidence: [],
    },
    {
      id: "one_unit_spans_orders_of_magnitude",
      statement:
        `Read under the row's own unit column, the candidate quantities span ` +
        distribution
          .map(
            (entry) =>
              `${entry.unit} ${entry.minimum} to ${entry.maximum} over ${entry.rows} ` +
              `row${entry.rows === 1 ? "" : "s"}`,
          )
          .join(", ") +
        `. The audit states the spread and draws no conclusion about what quantity would be appropriate; ` +
        `it is reported because a column whose readings scatter this far is what an unverifiable unit ` +
        `binding looks like from outside.`,
      rows: candidates.length,
      evidence: [],
    },
  ];

  const acquisition = rows.acquisition.datasets
    .map((entry) => ({
      dataset: entry.dataset,
      url: entry.url,
      declaredBytes: entry.declaredBytes,
      observedBytes: entry.observedBytes,
      sha256: entry.sha256,
      rowCount: entry.rowCount,
      servedAt: entry.servedAt,
    }))
    .sort((left, right) => byString(left.dataset, right.dataset));

  const auditId = deriveBatchId(LNHPD_SOURCE_NAME, {
    audit: DOSE_AUDIT_VERSION,
    sourceNamespace: LNHPD_SOURCE_NAMESPACE,
    retrievedAt: rows.acquisition.retrievedAt,
    acquisition,
    classes: classCounts,
    spellings,
    exclusions: exclusionCounts,
    overlap,
    distribution,
    disqualifications,
    findings,
  });

  const fixtureRows = [
    ...samplesByClass.flatMap((entry) => entry.rows),
    ...evidenceRows,
  ];
  const deduped = new Map<string, Record<string, string | number | null>>();
  for (const columns of fixtureRows) {
    deduped.set(JSON.stringify(columns), columns);
  }
  const fixtures = [...deduped.values()].sort((left, right) =>
    Number(left.dose_id ?? 0) - Number(right.dose_id ?? 0) ||
    byString(JSON.stringify(left), JSON.stringify(right)),
  );

  const report: PlannedFile = {
    path: `${REPORTS_DIRECTORY}/${LNHPD_SOURCE_NAME}/${auditId}-${DOSE_AUDIT_REPORT_KIND}.json`,
    contents: serializeReport({
      version: REPORT_VERSION,
      kind: "dose_quantity_audit",
      auditId,
      auditVersion: DOSE_AUDIT_VERSION,
      sourceNamespace: LNHPD_SOURCE_NAMESPACE,
      retrievedAt: rows.acquisition.retrievedAt,
      license: LNHPD_LICENSE,
      attribution: LNHPD_ATTRIBUTION,
      notice: DOSE_AUDIT_NOTICE,
      question: DOSE_AUDIT_QUESTION,
      changed: {
        schemas: 0,
        importerRules: 0,
        corpusFiles: 0,
        manifests: 0,
        note:
          "An audit reads. This run wrote this report and the committed fixtures it samples, and nothing else.",
      },
      reproduce: {
        command: "bun run src/lnhpd/audit-cli.ts <snapshot-dir> [corpus-root]",
        note:
          "The snapshot is the same acquisition the importer reads, verified against its receipt by byte count and SHA-256 before a row is classified. Re-running over the files this produced writes nothing.",
      },
      input: acquisition,
      classification: {
        doseRows: classified.length,
        note:
          "Every productdose row lands in exactly one class and the counts total the rows read.",
        classes: classCounts,
      },
      unitColumn: {
        distinctSpellings: spellings.length,
        note:
          "Row counts here are per spelling and cover every row carrying it, whatever class the row landed " +
          "in, so they do not match the fixed_quantity_* class counts above and are not meant to. Eligibility " +
          "turns only on whether a spelling maps onto a corpus fact unit; the other buckets explain rather " +
          "than decide.",
        buckets,
        spellings,
      },
      candidates: {
        rows: candidates.length,
        products: productsWithCandidates,
        publishedProducts: publishedProductsWithCandidates,
        productsStatingMoreThanOneQuantity: disagreeingProducts,
        quantityDistributionNote:
          "Every value here is one the column holds. medianObserved takes the upper of the two middle " +
          "values rather than averaging them, so this profile invents no quantity. It describes the spread " +
          "of the column and says nothing about what quantity would be appropriate for anyone.",
        quantityDistribution: distribution,
      },
      eligibility: {
        candidates: candidates.length,
        eligible: 0,
        rowLevelEligible: rowLevelEligible.length,
        note:
          "rowLevelEligible counts the candidate rows that survive every row-level exclusion. eligible is zero " +
          "regardless, because the class-level disqualifications below are about the column and hold for every " +
          "row in it. The two numbers are reported apart so the second is not read as a discount on the first.",
        rowLevelExclusions: exclusionCounts,
        exclusionOverlap: overlap,
        classDisqualifications: disqualifications,
      },
      findings,
      verdict: {
        representable: false,
        statement:
          "No. A scalar fact read from quantity_dose would assert a unit binding this download shows is not " +
          "always present, on a shape that is defined by absence rather than by anything a licence holder " +
          "stated, stripped of the frequency and population that give the number its meaning. The row-level " +
          "residue is small enough to make the point on its own, but it is not what decides this: no count of " +
          "surviving rows makes the column mean something it does not mean. The corpus fact vocabulary is " +
          "unchanged, the importer still reads only quantity_dose_minimum and quantity_dose_maximum, and " +
          "quantity_dose stays unread.",
        note:
          "This is a finding about representability in this corpus. It is not a health claim, a recommendation, " +
          "an evidence grade or a statement about any product.",
      },
      samples: {
        sampleSize,
        note:
          `Counts above are complete. Below are up to ${sampleSize} raw rows per class, reproduced exactly as ` +
          `Health Canada published them and ordered by dose_id so the position a row happened to occupy in the ` +
          `download cannot change these bytes. The same rows are committed at ${DOSE_AUDIT_FIXTURE_PATH}.`,
        byClass: samplesByClass,
        unitBindingEvidence: contradicting
          .slice(0, sampleSize)
          .map((entry) => entry.columns),
        rowLevelEligibleRows: rowLevelEligible.map((held) => held.entry.columns),
      },
    }),
  };

  const fixtureFile: PlannedFile = {
    path: DOSE_AUDIT_FIXTURE_PATH,
    contents: `${JSON.stringify(fixtures, null, 2)}\n`,
  };

  return {
    auditId,
    retrievedAt: rows.acquisition.retrievedAt,
    files: [report, fixtureFile].sort((left, right) =>
      byString(left.path, right.path),
    ),
    report,
    fixtures: fixtureFile,
    classifications: classified.map((entry) => entry.classification),
    counts: {
      doseRows: classified.length,
      candidates: candidates.length,
      eligible: 0,
    },
  };
};
