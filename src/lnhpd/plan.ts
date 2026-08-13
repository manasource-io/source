import { formatYaml } from "../corpus.ts";
import {
  LNHPD_ATTRIBUTION,
  LNHPD_DATASETS_NOT_ACQUIRED,
  LNHPD_DOSE_URL_PLACEHOLDER,
  LNHPD_DOSE_URL_TEMPLATE,
  LNHPD_ID_PREFIX,
  LNHPD_IMPORTER_VERSION,
  LNHPD_LICENSE,
  LNHPD_NORMALIZATION_VERSION,
  LNHPD_NOTICE,
  LNHPD_RECORD_TYPE,
  LNHPD_SOURCE_NAME,
  LNHPD_SOURCE_NAMESPACE,
  LNHPD_URL_PLACEHOLDER,
  LNHPD_URL_TEMPLATE,
  LnhpdImportError,
  byString,
  collapseSourceText,
  countQuarantineReasons,
  deriveBatchId,
  mintRecordId,
  seededSuffixBytes,
  toSlug,
} from "./format.ts";
import type {
  LnhpdDoseFact,
  LnhpdQuarantineEntry,
  SuffixBytes,
} from "./format.ts";
import { readLnhpdIdentities, toQuarantineEntry } from "./identity.ts";
import type { LnhpdIdentity } from "./identity.ts";
import type { CorpusIndex } from "./corpus.ts";
import type { LnhpdRowSet } from "./read.ts";

/**
 * The pure half of the importer: acquired rows plus a corpus index in, the exact
 * files to write out. No I/O, no clock, no randomness, so what counts as the
 * same product, what is held and which bytes an unchanged refresh emits are all
 * decidable without a filesystem. `emit.ts` is the half that touches one.
 *
 * **Deterministic by construction.** `retrieved_at` comes from the acquisition
 * receipt rather than from a clock; identities reconcile in LNHPD-id order and
 * emit in record-ID order, so the order rows arrived in cannot reach a file; IDs
 * are minted from a digest of the authoritative identity; and the batch id is a
 * digest of what the batch published, so a refresh that changes nothing reuses
 * the same manifest path and writes no bytes.
 *
 * **The LNHPD id is the match key, and it is the only one.** A product is matched
 * by the source row it already carries in this namespace. Matching on a
 * normalized product name across sources would be an inference no upstream
 * identifier backs, and the names LNHPD publishes — "Chewable Vitamin C 500 mg -
 * Grape Juice" — are exactly the kind that collide across manufacturers.
 *
 * **Facts are replaced wholesale for this namespace, never merged.** A refresh
 * that drops a dose row should drop the fact, and a fact accumulated across runs
 * would outlive the row that justified it. Facts from other namespaces are left
 * exactly as they were: this batch read none of their rows and has nothing to
 * say about them.
 */

export type PlannedFile = {
  path: string;
  contents: string;
};

/**
 * A dose fact as everything durable publishes it, without `rowIndex`.
 *
 * Where a row sat in the feed is bookkeeping, not something the batch published,
 * and letting it through would make the batch id a function of feed order: two
 * snapshots stating the same doses in a different order would derive different
 * manifests and rewrite every report. The same rule as `created` on a record —
 * what the batch published, never how the run went.
 */
export type PublishedDoseFact = Omit<LnhpdDoseFact, "rowIndex">;

export type PublishedProduct = {
  recordId: string;
  sourceRecordId: string;
  licenceNumber: string;
  canonicalName: string;
  dosageForm: string | null;
  companyName: string | null;
  alternateNames: string[];
  doseFacts: PublishedDoseFact[];
  occurrenceCount: number;
};

const toPublishedDoseFact = ({
  rowIndex: _rowIndex,
  ...published
}: LnhpdDoseFact): PublishedDoseFact => published;

/**
 * Where every input row went, stated so it can be checked rather than trusted.
 *
 * `planLnhpdImport` proves this closes — `acceptedProductRows +
 * alternateNameRows + heldProductRows` is exactly the product rows read, and
 * `facts + heldDoseRows` is exactly the dose rows — and throws if it does not.
 * A batch that cannot say where a row went has no business publishing a
 * manifest that counts the ones it liked.
 */
export type LnhpdRowAccounting = {
  productRows: number;
  /** One per published licence: the primary name row the record was minted from. */
  acceptedProductRows: number;
  /**
   * A published licence's other name rows. Reported in the product report and
   * carried into no record — the envelope has no `aliases` field — so they are
   * neither accepted nor a defect, and counting them is the only honest option.
   */
  alternateNameRows: number;
  heldProductRows: number;
  doseRows: number;
  /** Dose rows that became a `dose_range` fact on a published record. */
  acceptedDoseRows: number;
  heldDoseRows: number;
};

export type LnhpdImportCounts = {
  inputRows: number;
  productRows: number;
  doseRows: number;
  resolvedLicences: number;
  accepted: number;
  facts: number;
  quarantined: number;
  accounting: LnhpdRowAccounting;
};

export type LnhpdImportPlan = {
  batchId: string;
  retrievedAt: string;
  records: PlannedFile[];
  manifest: PlannedFile;
  reports: PlannedFile[];
  counts: LnhpdImportCounts;
  quarantine: LnhpdQuarantineEntry[];
  products: PublishedProduct[];
  createdRecordIds: string[];
};

export type LnhpdPlanOptions = {
  rows: LnhpdRowSet;
  index: CorpusIndex;
  sourceUrlTemplate?: string;
  doseUrlTemplate?: string;
  attribution?: string;
  notice?: string;
  license?: string;
  /** Test seam for the ID collision retry. */
  suffixBytes?: SuffixBytes;
  /**
   * How many held rows per reason reach the durable quarantine report. The full
   * counts are always published; this bounds the worked examples beside them,
   * because 350,000 rows of "counted in capsules" is a file nobody reads and a
   * diff nobody can review.
   */
  quarantineSampleSize?: number;
};

export const QUARANTINE_SAMPLE_SIZE = 25;
export const REPORT_VERSION = 1;
export const REPORTS_DIRECTORY = "reports";

const citationUrl = (template: string, licenceNumber: string): string =>
  template.replaceAll(LNHPD_URL_PLACEHOLDER, licenceNumber);

const shardOf = (recordId: string): string => recordId.slice(2, 4);

/**
 * One accepted product as a corpus record file.
 *
 * The envelope is a closed public contract. It has no field for a licence
 * number, a dosage form, a company name or a sub-population, and this importer
 * writes **no identifier crosswalk at all**: there is no LNHPD identifier kind in
 * the corpus vocabulary, and minting one here would publish a crosswalk key the
 * artifact layer does not project and no other importer would agree with. Those
 * values reach the durable product report instead, where they are review data
 * rather than corpus content.
 */
const toRecordFile = (
  identity: LnhpdIdentity,
  recordId: string,
  existingData: Record<string, unknown> | null,
  sourceUrlTemplate: string,
  doseUrlTemplate: string,
  attribution: string,
): PlannedFile => {
  const url = citationUrl(sourceUrlTemplate, identity.licenceNumber);
  const doseUrl = doseUrlTemplate.replaceAll(
    LNHPD_DOSE_URL_PLACEHOLDER,
    identity.sourceRecordId,
  );

  const priorSources = Array.isArray(existingData?.sources)
    ? (existingData.sources as Record<string, unknown>[]).filter(
        (source) =>
          !(
            source.namespace === LNHPD_SOURCE_NAMESPACE &&
            source.source_record_id === identity.sourceRecordId
          ),
      )
    : [];

  const priorFacts = Array.isArray(existingData?.facts)
    ? (existingData.facts as Record<string, unknown>[]).filter((fact) => {
        const source = fact.source as Record<string, unknown> | undefined;
        return source?.namespace !== LNHPD_SOURCE_NAMESPACE;
      })
    : [];

  const sources = [
    ...priorSources,
    {
      attribution,
      namespace: LNHPD_SOURCE_NAMESPACE,
      occurrence_count: identity.occurrenceCount,
      source_record_id: identity.sourceRecordId,
      url,
    },
  ].sort((left, right) =>
    byString(String(left.namespace), String(right.namespace)) ||
    byString(String(left.source_record_id), String(right.source_record_id)),
  );

  // Each fact cites the **dose row** it came from, so a reader meeting a range on
  // a detail page can tell which of a product's several dose statements stated
  // it, and two dose rows on one product do not collapse into one citation. The
  // URL is the dose dataset filtered to this product rather than the product
  // page — see `LNHPD_DOSE_URL_TEMPLATE` for why the page is the wrong citation
  // for a number it does not always print.
  const facts = [
    ...priorFacts,
    ...identity.doseFacts.map((dose) => ({
      kind: "dose_range",
      range: { maximum: dose.maximum, minimum: dose.minimum, unit: dose.unit },
      source: {
        attribution,
        namespace: LNHPD_SOURCE_NAMESPACE,
        occurrence_count: 1,
        source_record_id: `dose:${dose.doseId}`,
        url: doseUrl,
      },
    })),
  ].sort((left, right) => {
    const leftSource = left.source as Record<string, unknown>;
    const rightSource = right.source as Record<string, unknown>;
    return (
      byString(String(leftSource.namespace), String(rightSource.namespace)) ||
      byString(
        String(leftSource.source_record_id),
        String(rightSource.source_record_id),
      )
    );
  });

  // Only rename a record this importer wholly owns. A record that also carries
  // another source was named by whichever import created it, and overwriting
  // that name here would make the canonical name depend on which importer ran
  // last.
  const ownedSolely = priorSources.length === 0;
  const canonicalName = ownedSolely
    ? identity.canonicalName
    : String(existingData?.canonical_name ?? identity.canonicalName);
  const normalizedName = ownedSolely
    ? identity.normalizedName
    : String(existingData?.normalized_name ?? identity.normalizedName);

  const data = {
    canonical_name: canonicalName,
    entity_type: LNHPD_RECORD_TYPE,
    facts,
    id: recordId,
    identifiers: existingData?.identifiers ?? [],
    kind: "record",
    lifecycle: existingData?.lifecycle ?? "published",
    links: existingData?.links ?? [],
    normalized_name: normalizedName,
    schema_version: 1,
    slug: existingData?.slug ?? toSlug(canonicalName, recordId),
    sources,
    title: existingData?.title ?? canonicalName,
  };

  return {
    path: `records/${LNHPD_RECORD_TYPE}/${shardOf(recordId)}/${recordId}.yaml`,
    contents: formatYaml(data),
  };
};

const serializeReport = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export const planLnhpdImport = ({
  rows,
  index,
  sourceUrlTemplate = LNHPD_URL_TEMPLATE,
  doseUrlTemplate = LNHPD_DOSE_URL_TEMPLATE,
  attribution = LNHPD_ATTRIBUTION,
  notice = LNHPD_NOTICE,
  license = LNHPD_LICENSE,
  suffixBytes = seededSuffixBytes,
  quarantineSampleSize = QUARANTINE_SAMPLE_SIZE,
}: LnhpdPlanOptions): LnhpdImportPlan => {
  if (!sourceUrlTemplate.includes(LNHPD_URL_PLACEHOLDER)) {
    throw new LnhpdImportError(
      `The source URL template must contain ${LNHPD_URL_PLACEHOLDER}; '${sourceUrlTemplate}' would cite one URL for every record.`,
    );
  }
  if (!sourceUrlTemplate.startsWith("https://")) {
    throw new LnhpdImportError(
      `The source URL template must be https://; '${sourceUrlTemplate}' would emit a source row the corpus rejects.`,
    );
  }
  if (!doseUrlTemplate.includes(LNHPD_DOSE_URL_PLACEHOLDER)) {
    throw new LnhpdImportError(
      `The dose URL template must contain ${LNHPD_DOSE_URL_PLACEHOLDER}; '${doseUrlTemplate}' would cite one URL for every fact.`,
    );
  }
  if (!doseUrlTemplate.startsWith("https://")) {
    throw new LnhpdImportError(
      `The dose URL template must be https://; '${doseUrlTemplate}' would emit a fact source the corpus rejects.`,
    );
  }

  const read = readLnhpdIdentities(rows);
  const quarantine = [...read.quarantine];
  const takenIds = new Set(index.takenIds);
  const claimed = new Map<string, string>();

  /**
   * Holds a licence the corpus rejected, every row of it.
   *
   * `identity.ts` deliberately leaves these rows unheld: until the corpus has
   * been consulted the licence is still publishable, and holding its rows early
   * would have counted them twice for the licences that went on to publish. So
   * the last two reasons finish the job here — name rows and the dose rows that
   * had already resolved to the product alike, because a dose with no published
   * product to hang off is exactly as unpublished as the product.
   */
  const holdReconciled = (
    identity: LnhpdIdentity,
    reason: "identifier_conflict" | "record_type_conflict",
    detail: string,
  ): void => {
    for (const row of identity.nameRows) {
      quarantine.push({
        ...toQuarantineEntry(identity, reason, detail),
        index: row.index,
      });
    }
    for (const fact of identity.doseFacts) {
      quarantine.push({
        ...toQuarantineEntry(identity, reason, detail),
        dataset: "productdose",
        index: fact.rowIndex,
        rowId: fact.doseId,
        unit: fact.sourceUnit,
      });
    }
  };

  const reconciled: {
    identity: LnhpdIdentity;
    recordId: string;
    existing: Record<string, unknown> | null;
    created: boolean;
  }[] = [];

  for (const identity of read.identities) {
    const matched = index.byLnhpdId.get(identity.sourceRecordId) ?? null;

    if (matched && matched.entityType !== LNHPD_RECORD_TYPE) {
      holdReconciled(
        identity,
        "record_type_conflict",
        `${matched.id} is a ${matched.entityType} already sourcing LNHPD product ${identity.sourceRecordId}, and a record type change mints a new ID rather than being remapped.`,
      );
      continue;
    }

    const otherSource = matched?.sources.find(
      (source) =>
        source.namespace === LNHPD_SOURCE_NAMESPACE &&
        source.sourceRecordId !== identity.sourceRecordId,
    );
    if (matched && otherSource) {
      holdReconciled(
        identity,
        "identifier_conflict",
        `${matched.id} already sources LNHPD product ${otherSource.sourceRecordId}.`,
      );
      continue;
    }

    if (matched && claimed.has(matched.id)) {
      holdReconciled(
        identity,
        "identifier_conflict",
        `${matched.id} was already claimed in this batch by LNHPD product ${claimed.get(matched.id)}.`,
      );
      continue;
    }

    const recordId =
      matched?.id ??
      mintRecordId(
        LNHPD_ID_PREFIX,
        (candidate) => takenIds.has(candidate),
        suffixBytes(`${LNHPD_SOURCE_NAMESPACE} ${identity.sourceRecordId}`),
      );
    takenIds.add(recordId);
    claimed.set(recordId, identity.sourceRecordId);

    // The licence publishes, so its repeated primary rows become held rows: the
    // record carries one source row with an occurrence count, and the repeats
    // are not separately published. Decided here, once the licence's fate is
    // actually known, so a licence held above never counts them.
    for (const row of identity.nameRows.filter((entry) => entry.isPrimary).slice(1)) {
      quarantine.push({
        ...toQuarantineEntry(
          identity,
          "duplicate_source_row",
          `lnhpd_id ${identity.sourceRecordId} repeats the primary name row at index ${identity.index}.`,
        ),
        index: row.index,
      });
    }

    reconciled.push({
      identity,
      recordId,
      existing: matched?.data ?? null,
      created: matched === null,
    });
  }

  reconciled.sort((left, right) => byString(left.recordId, right.recordId));

  const records = reconciled.map((entry) =>
    toRecordFile(
      entry.identity,
      entry.recordId,
      entry.existing,
      sourceUrlTemplate,
      doseUrlTemplate,
      attribution,
    ),
  );

  const products: PublishedProduct[] = reconciled.map((entry) => ({
    recordId: entry.recordId,
    sourceRecordId: entry.identity.sourceRecordId,
    licenceNumber: entry.identity.licenceNumber,
    canonicalName: entry.identity.canonicalName,
    dosageForm: entry.identity.dosageForm,
    companyName: entry.identity.companyName,
    alternateNames: entry.identity.alternateNames,
    doseFacts: entry.identity.doseFacts.map(toPublishedDoseFact),
    occurrenceCount: entry.identity.occurrenceCount,
  }));

  const reasons = countQuarantineReasons(quarantine);
  const collapsedNotice = collapseSourceText(notice);
  const collapsedLicense = collapseSourceText(license);
  const collapsedAttribution = collapseSourceText(attribution);
  const factCount = products.reduce(
    (total, product) => total + product.doseFacts.length,
    0,
  );

  const acquisition = rows.acquisition.datasets
    .map((entry) => ({
      dataset: entry.dataset,
      url: entry.url,
      httpStatus: entry.httpStatus,
      declaredBytes: entry.declaredBytes,
      observedBytes: entry.observedBytes,
      sha256: entry.sha256,
      rowCount: entry.rowCount,
      servedAt: entry.servedAt,
    }))
    .sort((left, right) => byString(left.dataset, right.dataset));

  // What the batch published, never how the run went: `created` is true the
  // first time a record is minted and false on every run after it, so nothing
  // whose stability matters may carry it. Otherwise an unchanged refresh would
  // derive a fresh batch id and rewrite every report.
  const batchId = deriveBatchId(LNHPD_SOURCE_NAME, {
    sourceNamespace: LNHPD_SOURCE_NAMESPACE,
    retrievedAt: rows.acquisition.retrievedAt,
    importerVersion: LNHPD_IMPORTER_VERSION,
    normalizationVersion: LNHPD_NORMALIZATION_VERSION,
    attribution: collapsedAttribution,
    notice: collapsedNotice,
    license: collapsedLicense,
    sourceUrlTemplate,
    doseUrlTemplate,
    acquisition,
    quarantine: reasons,
    products,
  });

  const productRows = rows.rows.productlicence.length;
  const doseRows = rows.rows.productdose.length;
  const heldProductRows = quarantine.filter(
    (entry) => entry.dataset === "productlicence",
  ).length;
  const heldDoseRows = quarantine.length - heldProductRows;
  const accounting: LnhpdRowAccounting = {
    productRows,
    acceptedProductRows: reconciled.length,
    alternateNameRows: reconciled.reduce(
      (total, entry) => total + entry.identity.alternateNameRows,
      0,
    ),
    heldProductRows,
    doseRows,
    acceptedDoseRows: factCount,
    heldDoseRows,
  };

  // The proof, not a comment claiming one. If a row went somewhere this
  // accounting does not name, the batch refuses rather than publishing counts
  // that quietly omit it.
  const productBalance =
    accounting.acceptedProductRows +
    accounting.alternateNameRows +
    accounting.heldProductRows;
  if (productBalance !== productRows) {
    throw new LnhpdImportError(
      `Row accounting does not close: ${productRows} productlicence rows were read but ` +
        `${accounting.acceptedProductRows} accepted + ${accounting.alternateNameRows} alternate-name + ` +
        `${accounting.heldProductRows} held is ${productBalance}.`,
    );
  }
  const doseBalance = accounting.acceptedDoseRows + accounting.heldDoseRows;
  if (doseBalance !== doseRows) {
    throw new LnhpdImportError(
      `Row accounting does not close: ${doseRows} productdose rows were read but ` +
        `${accounting.acceptedDoseRows} accepted + ${accounting.heldDoseRows} held is ${doseBalance}.`,
    );
  }

  const counts: LnhpdImportCounts = {
    inputRows: productRows + doseRows,
    productRows,
    doseRows,
    resolvedLicences: read.resolvedLicences,
    accepted: reconciled.length,
    facts: factCount,
    quarantined: quarantine.length,
    accounting,
  };

  const manifest: PlannedFile = {
    path: `manifests/${LNHPD_SOURCE_NAME}/${batchId}.yaml`,
    contents: formatYaml({
      batch_id: batchId,
      counts: { records: reconciled.length, sources: reconciled.length },
      importer_version: LNHPD_IMPORTER_VERSION,
      kind: "import_manifest",
      license: collapsedLicense,
      normalization_version: LNHPD_NORMALIZATION_VERSION,
      notice: collapsedNotice,
      quarantine: { reasons, total: quarantine.length },
      record_type: LNHPD_RECORD_TYPE,
      records: reconciled.map((entry) => entry.recordId),
      retrieved_at: rows.acquisition.retrievedAt,
      schema_version: 1,
      source: LNHPD_SOURCE_NAME,
      source_namespace: LNHPD_SOURCE_NAMESPACE,
    }),
  };

  const reportBase = `${REPORTS_DIRECTORY}/${LNHPD_SOURCE_NAME}/${batchId}`;

  const samples = new Map<string, LnhpdQuarantineEntry[]>();
  for (const entry of quarantine) {
    const held = samples.get(entry.reason) ?? [];
    if (held.length < quarantineSampleSize) {
      held.push(entry);
      samples.set(entry.reason, held);
    }
  }

  const reports: PlannedFile[] = [
    {
      path: `${reportBase}-acquisition.json`,
      contents: serializeReport({
        version: REPORT_VERSION,
        batchId,
        sourceNamespace: LNHPD_SOURCE_NAMESPACE,
        retrievedAt: rows.acquisition.retrievedAt,
        importerVersion: LNHPD_IMPORTER_VERSION,
        normalizationVersion: LNHPD_NORMALIZATION_VERSION,
        license: collapsedLicense,
        attribution: collapsedAttribution,
        notice: collapsedNotice,
        sourceUrlTemplate,
        doseUrlTemplate,
        acquired: acquisition,
        notAcquired: LNHPD_DATASETS_NOT_ACQUIRED,
        counts,
      }),
    },
    {
      path: `${reportBase}-quarantine.json`,
      contents: serializeReport({
        version: REPORT_VERSION,
        batchId,
        sourceNamespace: LNHPD_SOURCE_NAMESPACE,
        retrievedAt: rows.acquisition.retrievedAt,
        total: quarantine.length,
        reasons,
        sampleSize: quarantineSampleSize,
        sampleNote:
          `Counts above are complete and cover every held row. The samples below are the ` +
          `first ${quarantineSampleSize} rows per reason in feed order, kept so a reviewer can ` +
          `settle a reason by hand without a file the size of the feed.`,
        samples: [...samples.keys()].sort(byString).map((reason) => ({
          reason,
          entries: samples.get(reason) ?? [],
        })),
      }),
    },
    {
      path: `${reportBase}-products.json`,
      contents: serializeReport({
        version: REPORT_VERSION,
        batchId,
        sourceNamespace: LNHPD_SOURCE_NAMESPACE,
        retrievedAt: rows.acquisition.retrievedAt,
        importerVersion: LNHPD_IMPORTER_VERSION,
        normalizationVersion: LNHPD_NORMALIZATION_VERSION,
        license: collapsedLicense,
        attribution: collapsedAttribution,
        notice: collapsedNotice,
        counts,
        note:
          "The durable home for what the record envelope cannot carry: the Natural " +
          "Product Number, the dosage form, the licence holder, the licence's other " +
          "brand names, and the sub-population each dose row named. None of it is " +
          "corpus content and none of it is evidence.",
        products,
      }),
    },
  ];

  return {
    batchId,
    retrievedAt: rows.acquisition.retrievedAt,
    records,
    manifest,
    reports,
    counts,
    quarantine,
    products,
    createdRecordIds: reconciled
      .filter((entry) => entry.created)
      .map((entry) => entry.recordId),
  };
};
