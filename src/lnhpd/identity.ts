import {
  LICENCE_NUMBER_PATTERN,
  LNHPD_ID_PATTERN,
  byString,
  collapseSourceText,
  doseUnitFor,
  normalizeRecordName,
} from "./format.ts";
import type {
  LnhpdDataset,
  LnhpdDoseFact,
  LnhpdQuarantineEntry,
  LnhpdQuarantineReason,
  RecordFactUnit,
} from "./format.ts";
import type { LnhpdInputRow, LnhpdRowSet } from "./read.ts";

/**
 * What a batch says about identity: one identity per publishable LNHPD product,
 * the dose ranges that attach to it, and a counted quarantine entry for every
 * row that cannot become one.
 *
 * Nothing here reads a corpus or a clock. The order of questions is the order a
 * reviewer would ask them, so a held row reports the earliest thing that made it
 * unusable rather than whichever check happened to be written first:
 *
 * 1. **Is the product row usable on its own?** An LNHPD id, an eight-digit
 *    licence number, a product name.
 * 2. **Does the licence name one product?** LNHPD carries several name rows per
 *    licence and flags the primary ones. Exactly one distinct primary is an
 *    identity; none and several are both held, because picking one is an
 *    editorial call and a wrong one is unpickable once an ID is published.
 * 3. **Does the register confuse two products?** Two licences answering to one
 *    normalized name are held, and the question is asked across **every**
 *    resolved licence rather than only across the ones this batch publishes.
 *    That is deliberately stricter than scoping it to the batch: a name
 *    collision is a fact about LNHPD, and letting the slice decide it would make
 *    an identity depend on which products happened to carry a carryable dose.
 * 4. **Does a dose row attach, and can the corpus carry it?**
 *
 * **A product earns publication by carrying a fact.** A resolved licence whose
 * dose rows are all counted in capsules is held under `no_supported_dose_fact`
 * rather than emitted as a record asserting nothing. That is this batch's scope
 * written as a count instead of left to inference — see `format.ts`.
 */

export type LnhpdIdentity = {
  index: number;
  /** The LNHPD id, which is the source record id. */
  sourceRecordId: string;
  canonicalName: string;
  normalizedName: string;
  licenceNumber: string;
  dosageForm: string | null;
  companyName: string | null;
  /** The licence's non-primary name rows, reported rather than carried. */
  alternateNames: string[];
  /**
   * How many rows those names came from. Distinct from `alternateNames.length`,
   * which de-duplicates: the row arithmetic needs the rows.
   */
  alternateNameRows: number;
  /**
   * Every name row this licence owns, so whoever decides the licence's fate can
   * account for all of them. Only the corpus can reveal the last two ways a
   * licence fails, so `plan.ts` finishes this job and needs the rows to do it.
   */
  nameRows: { index: number; isPrimary: boolean }[];
  doseFacts: LnhpdDoseFact[];
  /** How many primary rows in this batch named this licence. Never zero. */
  occurrenceCount: number;
};

export type LnhpdIdentityResult = {
  /** One per publishable licence, in LNHPD-id order. */
  identities: LnhpdIdentity[];
  quarantine: LnhpdQuarantineEntry[];
  /** Licences that resolved to a clean identity, whether published or not. */
  resolvedLicences: number;
};

const textOrNull = (value: string | number | null): string | null => {
  if (value === null) return null;
  const collapsed = collapseSourceText(String(value));
  return collapsed === "" ? null : collapsed;
};

/**
 * A numeric cell as a number, or `null` when it is absent or is text that does
 * not spell one. The feed writes every quantity as a JSON number, so a string
 * here is a feed that has drifted from the shape it claims — but that is content
 * rather than contract, and the row is held rather than the batch.
 */
const numberOrNull = (value: string | number | null): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null) return null;
  const collapsed = collapseSourceText(value);
  if (collapsed === "") return null;
  const parsed = Number(collapsed);
  return Number.isFinite(parsed) ? parsed : null;
};

/** An id cell as the digits the corpus would carry. */
const idOrNull = (value: string | number | null): string | null => {
  const text = textOrNull(value);
  if (text === null) return null;
  return LNHPD_ID_PATTERN.test(text) ? text : null;
};

type HoldOptions = {
  index: number;
  dataset: LnhpdDataset;
  reason: LnhpdQuarantineReason;
  detail: string;
  sourceRecordId?: string | null;
  productName?: string | null;
  licenceNumber?: string | null;
  rowId?: string | null;
  unit?: string | null;
};

const hold = ({
  index,
  dataset,
  reason,
  detail,
  sourceRecordId = null,
  productName = null,
  licenceNumber = null,
  rowId = null,
  unit = null,
}: HoldOptions): LnhpdQuarantineEntry => ({
  index,
  dataset,
  sourceRecordId,
  productName,
  licenceNumber,
  rowId,
  unit,
  reason,
  detail,
});

/** One product-list row, read far enough to group it by licence. */
type ProductRow = {
  index: number;
  lnhpdId: string;
  licenceNumber: string;
  productName: string;
  normalizedName: string;
  dosageForm: string | null;
  companyName: string | null;
  isPrimary: boolean;
};

const readProductRow = (
  row: LnhpdInputRow,
  quarantine: LnhpdQuarantineEntry[],
): ProductRow | null => {
  const lnhpdId = idOrNull(row.columns.lnhpd_id ?? null);
  const licenceNumber = textOrNull(row.columns.licence_number ?? null);
  const productName = textOrNull(row.columns.product_name ?? null);

  if (lnhpdId === null) {
    quarantine.push(
      hold({
        index: row.index,
        dataset: row.dataset,
        reason: "missing_identifier",
        detail: `The row carries lnhpd_id ${JSON.stringify(row.columns.lnhpd_id)}, which is not a positive integer.`,
        licenceNumber,
        productName,
      }),
    );
    return null;
  }

  if (licenceNumber === null || !LICENCE_NUMBER_PATTERN.test(licenceNumber)) {
    quarantine.push(
      hold({
        index: row.index,
        dataset: row.dataset,
        reason: "invalid_licence_number",
        detail:
          licenceNumber === null
            ? "The row carries no licence_number, so the product cannot be cited back to Health Canada's register."
            : `licence_number '${licenceNumber}' is not the eight digits a Natural Product Number is written as.`,
        sourceRecordId: lnhpdId,
        productName,
      }),
    );
    return null;
  }

  if (productName === null) {
    quarantine.push(
      hold({
        index: row.index,
        dataset: row.dataset,
        reason: "missing_name",
        detail: "The row carries no product_name.",
        sourceRecordId: lnhpdId,
        licenceNumber,
      }),
    );
    return null;
  }

  const normalizedName = normalizeRecordName(productName);
  if (normalizedName === "") {
    quarantine.push(
      hold({
        index: row.index,
        dataset: row.dataset,
        reason: "missing_name",
        detail: `product_name '${productName}' normalizes to nothing.`,
        sourceRecordId: lnhpdId,
        licenceNumber,
        productName,
      }),
    );
    return null;
  }

  return {
    index: row.index,
    lnhpdId,
    licenceNumber,
    productName,
    normalizedName,
    dosageForm: textOrNull(row.columns.dosage_form ?? null),
    companyName: textOrNull(row.columns.company_name ?? null),
    // Anything that is not the flag's `1` is not a primary name. The feed writes
    // 0 and 1, and a third value would be a claim this importer has not observed
    // the meaning of, so it is treated as "not flagged" rather than guessed at.
    isPrimary: numberOrNull(row.columns.flag_primary_name ?? null) === 1,
  };
};

/** Everything two primary rows for one licence must agree on to be one product. */
const primariesAgree = (left: ProductRow, right: ProductRow): boolean =>
  left.licenceNumber === right.licenceNumber &&
  left.productName === right.productName &&
  left.dosageForm === right.dosageForm &&
  left.companyName === right.companyName;

/**
 * Holds every row of one licence under a single reason.
 *
 * A licence is the unit of publication, so it is also the unit of holding: when
 * a licence cannot be published, each of its name rows is held rather than only
 * the row that revealed the problem. That is what keeps the row arithmetic
 * closed — `plan.ts` proves every input row is accounted for exactly once, and
 * a licence whose non-primary rows silently vanished would break the proof
 * instead of merely looking untidy.
 */
const holdLicence = (
  group: readonly ProductRow[],
  reason: LnhpdQuarantineReason,
  detail: string,
  quarantine: LnhpdQuarantineEntry[],
): void => {
  for (const entry of group) {
    quarantine.push(
      hold({
        index: entry.index,
        dataset: "productlicence",
        reason,
        detail,
        sourceRecordId: entry.lnhpdId,
        licenceNumber: entry.licenceNumber,
        productName: entry.productName,
      }),
    );
  }
};

/**
 * Turns one licence's rows into an identity, or holds the licence.
 *
 * The feed makes both failure shapes real rather than theoretical: of 152,330
 * licences, 442 carry more than one row flagged `flag_primary_name` and 9 carry
 * none. Where several primaries agree on every field this importer reads they
 * are one product stated twice and become one identity with an occurrence count;
 * where they disagree the licence is held, because which company published the
 * product is not something to settle by taking whichever row sorted first.
 *
 * Nothing is quarantined for a licence that survives this step. A duplicate
 * primary row is only a held row once the licence is actually published, and
 * whether it will be is not known until name ambiguity and dose facts have been
 * settled — so that decision belongs to the caller, which makes it once.
 */
const resolveLicence = (
  group: readonly ProductRow[],
  quarantine: LnhpdQuarantineEntry[],
): LnhpdIdentity | null => {
  const primaries = group.filter((entry) => entry.isPrimary);

  if (primaries.length === 0) {
    holdLicence(
      group,
      "missing_primary_name",
      `lnhpd_id ${group[0]?.lnhpdId} carries ${group.length} name row${group.length > 1 ? "s" : ""} ` +
        `and none is flagged flag_primary_name, so nothing says which name the product is published under.`,
      quarantine,
    );
    return null;
  }

  const [first, ...rest] = primaries;
  if (!first) return null;
  if (rest.some((entry) => !primariesAgree(first, entry))) {
    holdLicence(
      group,
      "ambiguous_primary_name",
      `lnhpd_id ${first.lnhpdId} carries ${primaries.length} rows flagged flag_primary_name that disagree ` +
        `about the product, so which one names it is an editorial call rather than an importer's.`,
      quarantine,
    );
    return null;
  }

  // The non-primary rows are the licence's alternate names — normal data rather
  // than a defect, so they are reported rather than quarantined. The envelope
  // has no `aliases` field, so they reach the product report and never a record.
  const alternates = group.filter((entry) => !entry.isPrimary);
  const alternateNames = [
    ...new Set(alternates.map((entry) => entry.productName)),
  ].sort(byString);

  return {
    alternateNames,
    alternateNameRows: alternates.length,
    nameRows: group.map((entry) => ({
      index: entry.index,
      isPrimary: entry.isPrimary,
    })),
    index: first.index,
    sourceRecordId: first.lnhpdId,
    canonicalName: first.productName,
    normalizedName: first.normalizedName,
    licenceNumber: first.licenceNumber,
    dosageForm: first.dosageForm,
    companyName: first.companyName,
    doseFacts: [],
    occurrenceCount: primaries.length,
  };
};

/**
 * Reads one dose row into a range, or the reason it cannot become a fact.
 *
 * A `dose_range` fact is the strongest thing this importer emits, so the bar is
 * the highest: the unit has to be one the corpus vocabulary actually holds, the
 * bounds have to be present and ordered, and the range has to describe a
 * quantity rather than a placeholder. The feed writes `0.0` into both bounds for
 * the great majority of rows — that is "not stated", not "a dose of zero", and a
 * fact asserting a zero-to-zero range would be an assertion the licence holder
 * never made.
 */
const readDoseRow = (
  row: LnhpdInputRow,
  resolved: ReadonlySet<string>,
  quarantine: LnhpdQuarantineEntry[],
): { lnhpdId: string; fact: LnhpdDoseFact } | null => {
  const lnhpdId = idOrNull(row.columns.lnhpd_id ?? null);
  const doseId = idOrNull(row.columns.dose_id ?? null);
  const sourceUnit = textOrNull(row.columns.uom_type_desc_quantity_dose ?? null);
  const minimum = numberOrNull(row.columns.quantity_dose_minimum ?? null);
  const maximum = numberOrNull(row.columns.quantity_dose_maximum ?? null);
  const populationTypeDesc = textOrNull(row.columns.population_type_desc ?? null);

  const held = (reason: LnhpdQuarantineReason, detail: string): null => {
    quarantine.push(
      hold({
        index: row.index,
        dataset: row.dataset,
        reason,
        detail,
        sourceRecordId: lnhpdId,
        rowId: doseId,
        unit: sourceUnit,
      }),
    );
    return null;
  };

  if (lnhpdId === null) {
    return held(
      "missing_identifier",
      `The dose row carries lnhpd_id ${JSON.stringify(row.columns.lnhpd_id)}, which is not a positive integer.`,
    );
  }
  if (doseId === null) {
    return held(
      "invalid_identifier",
      `The dose row carries dose_id ${JSON.stringify(row.columns.dose_id)}, which is not a positive integer, so the fact could not cite the row it came from.`,
    );
  }
  if (!resolved.has(lnhpdId)) {
    return held(
      "unresolved_product",
      `No product in this batch resolved to lnhpd_id ${lnhpdId}, so this dose has no product to attach to.`,
    );
  }

  if (sourceUnit === null) {
    return held(
      "unsupported_dose_unit",
      "The dose row states no uom_type_desc_quantity_dose, so the numbers on it measure nothing.",
    );
  }

  const unit: RecordFactUnit | null = doseUnitFor(sourceUnit);
  if (unit === null) {
    return held(
      "unsupported_dose_unit",
      `uom_type_desc_quantity_dose '${sourceUnit}' is not one this importer maps onto a corpus fact unit. Most LNHPD doses are counted in dosage forms such as capsules, and a ratio such as 'g/kg' is deliberately not folded onto 'g'.`,
    );
  }

  if (minimum === null || maximum === null) {
    return held(
      "missing_dose_range",
      "The dose row does not state both quantity_dose_minimum and quantity_dose_maximum as numbers.",
    );
  }
  if (minimum < 0 || maximum < 0) {
    return held(
      "invalid_dose_range",
      `The dose range ${minimum}-${maximum} ${unit} is negative, which the corpus fact contract rejects.`,
    );
  }
  if (minimum > maximum) {
    return held(
      "invalid_dose_range",
      `The dose range states a minimum of ${minimum} above its maximum of ${maximum}.`,
    );
  }
  if (maximum === 0) {
    return held(
      "missing_dose_range",
      "The dose row states a zero maximum, which the feed writes where no quantity was given rather than to assert a dose of zero.",
    );
  }

  return {
    lnhpdId,
    fact: {
      doseId,
      rowIndex: row.index,
      populationTypeDesc,
      minimum,
      maximum,
      unit,
      sourceUnit,
    },
  };
};

/**
 * Reads a whole batch: one identity per publishable licence, with its dose
 * ranges attached, plus everything that was held.
 *
 * Attached doses are sorted by their own upstream id rather than kept in feed
 * order, so the order rows arrived in cannot change a record's bytes.
 */
export const readLnhpdIdentities = (rowSet: LnhpdRowSet): LnhpdIdentityResult => {
  const quarantine: LnhpdQuarantineEntry[] = [];

  const grouped = new Map<string, ProductRow[]>();
  for (const row of rowSet.rows.productlicence) {
    const product = readProductRow(row, quarantine);
    if (!product) continue;
    const group = grouped.get(product.lnhpdId);
    if (group) group.push(product);
    else grouped.set(product.lnhpdId, [product]);
  }

  const licences: LnhpdIdentity[] = [];
  for (const group of grouped.values()) {
    const identity = resolveLicence(group, quarantine);
    if (identity) licences.push(identity);
  }

  // Name ambiguity is asked across every resolved licence, not only the ones
  // this batch would publish — see the module note.
  const claimants = new Map<string, string[]>();
  for (const identity of licences) {
    const claiming = claimants.get(identity.normalizedName);
    if (claiming) claiming.push(identity.sourceRecordId);
    else claimants.set(identity.normalizedName, [identity.sourceRecordId]);
  }

  const unambiguous: LnhpdIdentity[] = [];
  for (const identity of licences) {
    const others = (claimants.get(identity.normalizedName) ?? [])
      .filter((id) => id !== identity.sourceRecordId)
      .sort(byString);
    if (others.length === 0) {
      unambiguous.push(identity);
      continue;
    }
    holdLicence(
      grouped.get(identity.sourceRecordId) ?? [],
      "ambiguous_identity",
      `'${identity.normalizedName}' also names lnhpd_id ${others.join(" and ")}.`,
      quarantine,
    );
  }

  const byLnhpdId = new Map(
    unambiguous.map((identity) => [identity.sourceRecordId, identity]),
  );
  const resolvedIds = new Set(byLnhpdId.keys());

  for (const row of rowSet.rows.productdose) {
    const read = readDoseRow(row, resolvedIds, quarantine);
    if (read) byLnhpdId.get(read.lnhpdId)?.doseFacts.push(read.fact);
  }

  const identities: LnhpdIdentity[] = [];
  for (const identity of unambiguous) {
    const group = grouped.get(identity.sourceRecordId) ?? [];
    if (identity.doseFacts.length === 0) {
      holdLicence(
        group,
        "no_supported_dose_fact",
        `lnhpd_id ${identity.sourceRecordId} resolved to one product but no dose row on it ` +
          `states a range in a unit the corpus fact vocabulary holds, so this batch has no ` +
          `attributed fact to publish for it.`,
        quarantine,
      );
      continue;
    }

    identity.doseFacts.sort((left, right) => byString(left.doseId, right.doseId));
    identities.push(identity);
  }

  return {
    identities: identities.sort((left, right) =>
      byString(left.sourceRecordId, right.sourceRecordId),
    ),
    quarantine,
    resolvedLicences: unambiguous.length,
  };
};

/** Holds an identity back, for the reasons only a corpus can reveal. */
export const toQuarantineEntry = (
  identity: LnhpdIdentity,
  reason: LnhpdQuarantineReason,
  detail: string,
): LnhpdQuarantineEntry => ({
  index: identity.index,
  dataset: "productlicence",
  sourceRecordId: identity.sourceRecordId,
  productName: identity.canonicalName,
  licenceNumber: identity.licenceNumber,
  rowId: null,
  unit: null,
  reason,
  detail,
});
