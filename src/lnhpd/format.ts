import { createHash } from "node:crypto";

/**
 * What a Health Canada LNHPD import publishes into this corpus, and the
 * vocabulary every step of it shares.
 *
 * This is the first importer to live in the source repository rather than to
 * hand it finished files, and the first to emit a `dose_range` fact rather than
 * an identity row. Both raise the bar rather than lower it. A labeled,
 * attributed, source-cited dose range is reference data a reader may see on a
 * detail page, and it is **still not evidence**: nothing here converts a fact
 * into a score, a grade, a ranking, an association or a recommendation, and the
 * promotion path into evidence remains a curated resource.
 *
 * **The input is the real LNHPD feed.** Health Canada publishes `productlicence`
 * and `productdose` as complete bulk JSON arrays over
 * `https://health-products.canada.ca/api/natural-licences/`. Both are acquired
 * whole, verified against the declared `content-length`, digested, and read from
 * a snapshot on disk. What this importer does **not** read is `medicinalingredient`
 * and `productrisk`: those endpoints are paginated at 100 rows across 8,265 and
 * 2,613 pages respectively, were not acquired here, and nothing in this batch
 * claims a potency, an ingredient quantity or a risk statement.
 *
 * **A batch must wholly hold what it claims.** The bulk endpoints carry no
 * pagination block to reason about, so wholeness is proven by arithmetic on the
 * transfer instead: the response declares a `content-length`, the snapshot on
 * disk must be exactly that many bytes, and the body must parse as a JSON array.
 * A truncated download fails all three — a short read of `productdose` ends
 * mid-object and will not parse — so a fragment cannot reach the importer and be
 * written up as a dataset.
 */

/** The source namespace this importer writes under. */
export const LNHPD_SOURCE_NAMESPACE = "hc.lnhpd";

/** The manifest directory name, and the prefix on derived batch ids. */
export const LNHPD_SOURCE_NAME = "hc-lnhpd";

/** Bump when the emitted record shape or the reconciliation rules change. */
export const LNHPD_IMPORTER_VERSION = "hc-lnhpd-1";

/** Bump when `normalizeRecordName` changes, which re-derives every name. */
export const LNHPD_NORMALIZATION_VERSION = "1.0.0";

/**
 * An LNHPD licence names a finished, licensed natural health product, so every
 * record this importer mints is a `supplement_product`. It never emits a second
 * type: a record type change mints a new ID by contract, so an importer that
 * could choose between two would make the choice unpickable later.
 */
export const LNHPD_RECORD_TYPE = "supplement_product";

/** The typed-ID prefix `LNHPD_RECORD_TYPE` maps to. */
export const LNHPD_ID_PREFIX = "SP";

/** Crockford base32, as `schemas/common.schema.json` spells it. */
export const RECORD_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECORD_ID_SUFFIX_LENGTH = 6;

/** The API base every acquired URL is built from. */
export const LNHPD_API_BASE =
  "https://health-products.canada.ca/api/natural-licences";

/**
 * The two bulk datasets this importer reads, in the order a reviewer meets
 * them: a product is an identity, and a dose hangs off one.
 */
export const LNHPD_DATASETS = ["productlicence", "productdose"] as const;

export type LnhpdDataset = (typeof LNHPD_DATASETS)[number];

export const isLnhpdDataset = (value: string): value is LnhpdDataset =>
  (LNHPD_DATASETS as readonly string[]).includes(value);

/**
 * The datasets Health Canada also publishes and this batch deliberately does
 * **not** hold. Named rather than left unmentioned: a reader who finds an LNHPD
 * record here is entitled to know that its potency and risk statements were not
 * read, instead of inferring absence from silence.
 */
export const LNHPD_DATASETS_NOT_ACQUIRED = [
  {
    dataset: "medicinalingredient",
    reason:
      "Paginated at 100 rows per page across 8,265 pages (826,412 rows observed). Not acquired in this batch, so no potency, ingredient quantity or source material is claimed.",
  },
  {
    dataset: "productrisk",
    reason:
      "Paginated at 100 rows per page across 2,613 pages (261,238 rows observed). Not acquired in this batch, so no caution, contra-indication or adverse-reaction statement is claimed.",
  },
] as const;

/**
 * The **complete** observed column set per dataset, in LNHPD's own spellings.
 *
 * Complete rather than a projection, and that is the deliberate difference from
 * the fixture-shaped importer this logic is adapted from. That one declared only
 * the columns it read so that a real response — which carries more — would fail
 * closed and could not be mistaken for a supported input. This importer *does*
 * read the real response, so the whole shape is the checkable thing: a column
 * LNHPD adds or renames fails the batch here rather than being silently ignored,
 * and `LNHPD_READ_COLUMNS` states separately which of them reach a record.
 */
export const LNHPD_COLUMNS: Readonly<Record<LnhpdDataset, readonly string[]>> = {
  productlicence: [
    "company_id",
    "company_name",
    "company_name_id",
    "date_start",
    "dosage_form",
    "flag_attested_monograph",
    "flag_primary_name",
    "flag_product_status",
    "licence_date",
    "licence_number",
    "lnhpd_id",
    "product_name",
    "product_name_id",
    "revised_date",
    "sub_submission_type_code",
    "sub_submission_type_desc",
    "time_receipt",
  ],
  productdose: [
    "age",
    "age_maximum",
    "age_minimum",
    "dose_id",
    "frequency",
    "frequency_maximum",
    "frequency_minimum",
    "lnhpd_id",
    "population_type_desc",
    "quantity_dose",
    "quantity_dose_maximum",
    "quantity_dose_minimum",
    "uom_type_desc_age",
    "uom_type_desc_frequency",
    "uom_type_desc_quantity_dose",
  ],
};

/**
 * The columns that actually decide what is published. Everything else in
 * `LNHPD_COLUMNS` is read to prove the shape and then dropped — declaring which
 * is which here keeps "we checked it" and "we used it" from blurring together.
 *
 * `quantity_dose` is on the not-read side on purpose. It is LNHPD's field for a
 * single stated quantity rather than a range, and re-expressing one as a
 * `dose_range` whose minimum equals its maximum would publish a range the
 * licence holder never stated. The corpus fact kind is a range; a fixed dose is
 * a different statement, and it waits for a fact kind that means it.
 */
export const LNHPD_READ_COLUMNS: Readonly<
  Record<LnhpdDataset, readonly string[]>
> = {
  productlicence: [
    "company_name",
    "dosage_form",
    "flag_primary_name",
    "licence_number",
    "lnhpd_id",
    "product_name",
  ],
  productdose: [
    "dose_id",
    "lnhpd_id",
    "population_type_desc",
    "quantity_dose_maximum",
    "quantity_dose_minimum",
    "uom_type_desc_quantity_dose",
  ],
};

/**
 * A Natural Product Number as LNHPD writes it: eight digits. It is also the key
 * Health Canada's own product page is addressed by, so a row without one cannot
 * be cited back to the register and is held.
 */
export const LICENCE_NUMBER_PATTERN = /^[0-9]{8}$/;

/** An LNHPD internal product id, which is the source record id here. */
export const LNHPD_ID_PATTERN = /^[1-9][0-9]*$/;

/** The corpus fact unit vocabulary, as `schemas/record.schema.json` closes it. */
export const RECORD_FACT_UNITS = ["mcg", "mg", "g", "mL", "IU"] as const;

export type RecordFactUnit = (typeof RECORD_FACT_UNITS)[number];

/**
 * The dose units this importer turns into a `dose_range` fact, keyed by the
 * **exact** spelling LNHPD writes.
 *
 * This is an inventory, not a unit parser, and the full feed is what closes it:
 * across all 207,190 dose rows there are 179 distinct spellings of
 * `uom_type_desc_quantity_dose`, and these seven are every one of them that
 * names a mass or a volume the corpus vocabulary holds. The rest are dosage
 * *forms* that count a thing rather than measure it — `capsule` alone is 59,995
 * rows, `tablet` 23,583, `Drop(s)` 12,796 — or ratios the feed also carries
 * (`g/kg`, `ml/kg`, `g/g`), or units with no corpus member at all (`oz`,
 * `USP units`, `billion cfu`, `%`). A lenient normalizer would read `g/kg` as
 * `g` and be wrong by whatever the denominator was, and would read `oz` as a
 * mass without knowing whether the row meant a fluid ounce.
 *
 * So a spelling not listed here is quarantined for a human rather than folded on
 * a guess, and adding one is a deliberate edit with a test row to go with it.
 * No spelling of `IU` occurs in this column anywhere in the feed, which is why
 * the corpus unit `IU` has no entry: inventing one would claim an observation
 * this importer did not make.
 */
export const LNHPD_DOSE_UNITS: Readonly<Record<string, RecordFactUnit>> = {
  Grams: "g",
  g: "g",
  mL: "mL",
  mcg: "mcg",
  mg: "mg",
  milligrams: "mg",
  millilitre: "mL",
};

export const doseUnitFor = (spelling: string): RecordFactUnit | null =>
  Object.hasOwn(LNHPD_DOSE_UNITS, spelling) ? LNHPD_DOSE_UNITS[spelling]! : null;

/**
 * The citation URL, with the licence number substituted.
 *
 * Observed rather than guessed: `?licence=80005229&lang=eng` returns Health
 * Canada's product page for that Natural Product Number, carrying the brand
 * names, the licence holder, the dosage form and the recommended-dose table this
 * batch reads. It is keyed by licence number rather than by `lnhpd_id` because
 * that is the key the page answers to, and the two are one-to-one across the
 * feed: 152,329 distinct licence numbers over 152,330 products, the difference
 * being the one product whose licence number is blank and which is held here.
 */
export const LNHPD_URL_PLACEHOLDER = "{licence_number}";

export const LNHPD_URL_TEMPLATE =
  "https://health-products.canada.ca/lnhpd-bdpsnh/info?licence={licence_number}&lang=eng";

/**
 * Where a **fact** is cited to, which is deliberately not where the record is.
 *
 * The record's source row cites the product page, because that page is what
 * establishes the product: its Natural Product Number, its brand names, its
 * licence holder and its dosage form all appear there and were checked against
 * it. But the page does not always show the dose. For a licence attested to an
 * NHPD monograph — 1,747 of the 2,562 products this batch publishes — the
 * recommended-dose section reads "As authorized in the NHPD monograph(s) to
 * which the applicant attested" and the numbers never appear, even though
 * Health Canada publishes them in `productdose` for that same product.
 *
 * Citing the page for the range would therefore send a reader to check a number
 * that is not on it, which is a citation in form only. So a fact cites the
 * dataset the number actually came from, filtered to the one product, which
 * returns exactly the dose rows this batch read. Both URLs are Health Canada's,
 * both are https, and both answer the question they are attached to.
 */
export const LNHPD_DOSE_URL_PLACEHOLDER = "{lnhpd_id}";

export const LNHPD_DOSE_URL_TEMPLATE =
  "https://health-products.canada.ca/api/natural-licences/productdose/?lang=en&type=json&id={lnhpd_id}";

/**
 * The Information Provider's own name for the dataset, carried on every source
 * row and every fact source. The Open Government Licence – Canada requires an
 * attribution statement naming the provider, and this is it.
 */
export const LNHPD_ATTRIBUTION =
  "Health Canada, Licensed Natural Health Products Database (LNHPD). Contains information licensed under the Open Government Licence – Canada.";

/**
 * The licence, stated because it is a fact about the dataset this path exists
 * for and a reader is entitled to it. LNHPD is published under the Open
 * Government Licence – Canada 2.0, which permits reuse — including commercially
 * — on three conditions the notice below meets: attribute the source, say that
 * the Information has been modified and is not an official version, and claim no
 * endorsement.
 */
export const LNHPD_LICENSE =
  "OGL-Canada-2.0 (Open Government Licence – Canada, https://open.canada.ca/en/open-government-licence-canada)";

/**
 * The OGL modification notice, plus what this batch is and is not.
 *
 * The first three sentences are the licence's conditions in the licence's own
 * terms — modified, not official, no endorsement — and they are not optional
 * boilerplate: this importer *does* modify the Information, so saying which ways
 * is what makes the reuse licensed. The rest is this repository's own honesty
 * about provenance and scope, for a reader who meets one of these records and is
 * entitled to know where the batch stops.
 */
export const LNHPD_NOTICE =
  "This Information has been modified from the original published by Health Canada: columns are selected, product names are normalized and their whitespace collapsed, rows that could not be resolved are held back, and dose units are mapped onto the closed corpus fact vocabulary. It is not represented as an official version of the Information, nor as one endorsed by Health Canada or by the Government of Canada. Imported from complete bulk downloads of the official LNHPD productlicence and productdose endpoints, each verified whole against the content-length its own response declared and recorded by SHA-256 digest in the acquisition report beside this manifest. This batch publishes exactly the licensed products carrying at least one dose row whose unit of measure is a mass or volume the corpus fact vocabulary holds; resolved products with no such dose row are counted and held rather than published as identity rows carrying no fact, and every held row states its reason. The LNHPD medicinalingredient and productrisk datasets were not acquired, so this batch claims nothing about ingredient content, potency, cautions, contra-indications or adverse reactions. Every emitted value is attributed reference data. A record cites Health Canada's product page for the licence, and a dose range cites the product's own rows in the dose dataset, because a licence attested to an NHPD monograph shows no numbers on its page and a citation a reader cannot check is a citation in form only. A dose range is what a licence holder stated on a product, reproduced with its own attribution and citation — it is not a recommendation, an intake target, an upper limit or an evidence claim, and no fact, report or artifact on this path reaches an evidence score, benefit or evidence grade, ranking, resource association, recommendation or any app mechanic.";

/**
 * Every reason a row can be held back, closed so the manifest's counts total.
 *
 * The first group is about a product's own identity, and `ambiguous_primary_name`
 * is the one the feed makes unavoidable: of 152,330 licences, 442 carry more
 * than one row flagged `flag_primary_name` and 9 carry none. Picking one is an
 * editorial call and a wrong one is unpickable once an ID is published, so both
 * shapes are held.
 *
 * The second group is about a dose that cannot be attached or cannot be carried.
 * `unsupported_dose_unit` is the common one by a wide margin — most LNHPD doses
 * are counted in capsules — and it is a refusal rather than a defect: the row is
 * fine, the corpus fact vocabulary simply has no unit for it.
 *
 * `no_supported_dose_fact` is this batch's scope, stated as a count rather than
 * left to inference. A resolved product with no carryable dose row is not
 * defective; it is out of what this batch publishes, and emitting it as a record
 * with no fact would add 147,000 identity rows for commercial brand names that
 * assert nothing. Counting it here keeps the arithmetic whole: every input row
 * is accepted or held, with a reason.
 */
export const LNHPD_QUARANTINE_REASONS = [
  "missing_identifier",
  "invalid_identifier",
  "invalid_licence_number",
  "missing_name",
  "missing_primary_name",
  "ambiguous_primary_name",
  "duplicate_source_row",
  "ambiguous_identity",
  "unresolved_product",
  "missing_dose_range",
  "invalid_dose_range",
  "unsupported_dose_unit",
  "no_supported_dose_fact",
  "identifier_conflict",
  "record_type_conflict",
] as const;

export type LnhpdQuarantineReason = (typeof LNHPD_QUARANTINE_REASONS)[number];

export type LnhpdQuarantineEntry = {
  /** Position across this dataset, in row order. */
  index: number;
  dataset: LnhpdDataset;
  sourceRecordId: string | null;
  productName: string | null;
  licenceNumber: string | null;
  /** The dose row's own id, where the dataset has one. */
  rowId: string | null;
  /** The unit spelling as the feed wrote it, for an unsupported-unit review. */
  unit: string | null;
  reason: LnhpdQuarantineReason;
  detail: string;
};

/** One accepted dose range, as it reaches a record file. */
export type LnhpdDoseFact = {
  doseId: string;
  /**
   * Where in the dose dataset the row sat. Carried so that a product held for a
   * reason only the corpus can reveal can still account for the dose rows that
   * had already resolved to it — see the row accounting in `plan.ts`.
   */
  rowIndex: number;
  /** Reported, never carried: the envelope has no field for a sub-population. */
  populationTypeDesc: string | null;
  minimum: number;
  maximum: number;
  unit: RecordFactUnit;
  /** The feed's own spelling, kept so the mapping stays auditable. */
  sourceUnit: string;
};

export const byString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Whitespace, C0/C1 controls and format characters all collapse to one space.
 * Source names are single-line, but a stray tab or non-breaking space in an
 * upstream row would otherwise reach a YAML scalar and change how the file is
 * quoted — a byte-level diff for no semantic change.
 */
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}\p{Cf}]+/gu;

const COMBINING_MARKS = /\p{M}+/gu;

export const collapseSourceText = (value: string): string =>
  value.replace(WHITESPACE_OR_CONTROL, " ").trim();

/**
 * The normalized name rule, versioned by `LNHPD_NORMALIZATION_VERSION`:
 * compatibility-decompose, drop combining marks so `Café` matches `Cafe`,
 * recompose, collapse whitespace, then lowercase.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`, because the latter would map
 * `I` differently under a Turkish locale and emit a different corpus depending
 * on the machine that ran the import. Punctuation is deliberately kept: product
 * names carry meaning in their commas and dashes, and dropping it would merge
 * names LNHPD distinguishes.
 */
export const normalizeRecordName = (canonicalName: string): string =>
  collapseSourceText(
    canonicalName.normalize("NFKD").replace(COMBINING_MARKS, "").normalize("NFC"),
  ).toLowerCase();

/** The corpus slug rule: fold accents, lowercase, and kebab the rest. */
export const toSlug = (canonicalName: string, fallback: string): string => {
  const slug = canonicalName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback.toLowerCase();
};

/** The manifest's quarantine block: one count per reason that occurred. */
export const countQuarantineReasons = (
  quarantine: readonly { reason: string }[],
): { reason: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const entry of quarantine) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [...counts.keys()]
    .sort(byString)
    .map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
};

export const deriveBatchId = (prefix: string, parts: unknown): string =>
  `${prefix}-${createHash("sha256")
    .update(JSON.stringify(parts), "utf-8")
    .digest("hex")
    .slice(0, 16)}`;

/**
 * Deterministic entropy for `mintRecordId`, seeded per identity, so an ID is a
 * pure function of the row that earned it and two fresh imports of one download
 * agree. Each retry draws a new digest, so the collision path stays meaningful.
 */
export type SuffixBytes = (seed: string) => (size: number) => Uint8Array;

export const seededSuffixBytes: SuffixBytes = (seed) => {
  let attempt = 0;
  return (size) => {
    const digest = createHash("sha256")
      .update(`${seed} ${attempt}`, "utf-8")
      .digest();
    attempt += 1;
    return new Uint8Array(digest.subarray(0, size));
  };
};

/**
 * 256 is an exact multiple of the 32-character alphabet, so taking each byte
 * modulo 32 keeps every character equally likely — no rejection sampling and no
 * modulo bias to reason about later.
 */
const toSuffix = (bytes: Uint8Array): string => {
  let suffix = "";
  for (const byte of bytes) {
    suffix += RECORD_ID_ALPHABET[byte % RECORD_ID_ALPHABET.length];
  }
  return suffix;
};

export class LnhpdImportError extends Error {
  override readonly name = "LnhpdImportError";
}

/** Mints a typed ID, retrying until `isTaken` accepts one. */
export const mintRecordId = (
  prefix: string,
  isTaken: (candidate: string) => boolean,
  randomBytes: (size: number) => Uint8Array,
  maxAttempts = 8,
): string => {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const bytes = randomBytes(RECORD_ID_SUFFIX_LENGTH);
    if (bytes.length !== RECORD_ID_SUFFIX_LENGTH) {
      throw new LnhpdImportError(
        `randomBytes returned ${bytes.length} bytes, expected ${RECORD_ID_SUFFIX_LENGTH}.`,
      );
    }
    const candidate = `${prefix}${toSuffix(bytes)}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new LnhpdImportError(
    `Could not mint an unused ${prefix} ID in ${maxAttempts} attempts.`,
  );
};
