import { formatYaml } from "../corpus.ts";
import { byString, collapseSourceText, deriveBatchId } from "../lnhpd/format.ts";
import {
  CROSSREF_ATTRIBUTION,
  CROSSREF_IMPORTER_VERSION,
  CROSSREF_LICENSE,
  CROSSREF_MANIFEST_KIND,
  CROSSREF_NORMALIZATION_VERSION,
  CROSSREF_NOTICE,
  CROSSREF_SOURCE_NAME,
  CROSSREF_SOURCE_NAMESPACE,
  CrossrefImportError,
  PMC_ARTICLE_URL_PATTERN,
} from "./format.ts";
import type {
  CrossrefResourceFile,
  CrossrefSnapshot,
  CrossrefWorkFacts,
} from "./read.ts";

/**
 * The pure half of the importer: a verified snapshot plus the target resource
 * files in, the exact files to write out. No I/O, no clock, no randomness.
 *
 * **Deterministic by construction.** `retrieved_at` comes from the
 * acquisition receipt rather than from a clock; references enrich in
 * path-then-id order; the emitted YAML is the corpus canonical form; and the
 * batch id is a digest of what the batch published, so re-planning one
 * snapshot over the corpus it produced derives the same manifest path and
 * byte-identical files.
 *
 * **The three imported fields are this namespace's, wholesale.** `doi`,
 * `authors`, and `container_title` are replaced from the snapshot on every
 * import — a fact Crossref no longer states is removed, because keeping it
 * would publish a claim the cited works record does not make. The DOI is the
 * one exception: it is the reference's imported identity, so a reference
 * already carrying a *different* DOI refuses the batch rather than being
 * silently repointed at another work. The curated `url`, `title`, and `date`
 * are never touched.
 */

export type PlannedFile = {
  path: string;
  contents: string;
};

/** One enriched reference, as the manifest and report publish it. */
export type CrossrefEnrichedReference = {
  resourceId: string;
  resourcePath: string;
  referenceId: string;
  doi: string;
  pmcid: string;
  pmid: string | null;
  authors: string[] | null;
  containerTitle: string | null;
};

export type CrossrefImportCounts = {
  resources: number;
  references: number;
};

export type CrossrefImportPlan = {
  batchId: string;
  retrievedAt: string;
  resources: PlannedFile[];
  manifest: PlannedFile;
  reports: PlannedFile[];
  references: CrossrefEnrichedReference[];
  counts: CrossrefImportCounts;
};

export type CrossrefPlanOptions = {
  snapshot: CrossrefSnapshot;
  resources: readonly CrossrefResourceFile[];
  license?: string;
  attribution?: string;
  notice?: string;
};

export const REPORT_VERSION = 1;
export const REPORTS_DIRECTORY = "reports";

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

const serializeReport = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const enrichReference = (
  reference: Record<string, unknown>,
  work: CrossrefWorkFacts,
  at: string,
): void => {
  if (typeof reference.doi === "string" && reference.doi !== work.doi) {
    throw new CrossrefImportError(
      `${at} already carries DOI '${reference.doi}' but the snapshot resolves it to ` +
        `'${work.doi}'. A reference is never silently repointed at another work; ` +
        `fix the reference or re-acquire before importing.`,
    );
  }
  reference.doi = work.doi;
  if (work.authors === null) delete reference.authors;
  else reference.authors = [...work.authors];
  if (work.containerTitle === null) delete reference.container_title;
  else reference.container_title = work.containerTitle;
};

export const planCrossrefImport = ({
  snapshot,
  resources,
  license = CROSSREF_LICENSE,
  attribution = CROSSREF_ATTRIBUTION,
  notice = CROSSREF_NOTICE,
}: CrossrefPlanOptions): CrossrefImportPlan => {
  const byPath = new Map(resources.map((resource) => [resource.path, resource]));
  const enrichedData = new Map<string, Record<string, unknown>>();
  const references: CrossrefEnrichedReference[] = [];

  const targets = [...snapshot.acquisition.targets].sort(
    (left, right) =>
      byString(left.resourcePath, right.resourcePath) ||
      byString(left.referenceId, right.referenceId),
  );

  for (const target of targets) {
    const resource = byPath.get(target.resourcePath);
    if (!resource) {
      throw new CrossrefImportError(
        `The receipt targets ${target.resourcePath}, which was not among the resource ` +
          `files read, so the batch cannot enrich what it named.`,
      );
    }
    const data =
      enrichedData.get(target.resourcePath) ??
      (structuredClone(resource.data) as Record<string, unknown>);
    enrichedData.set(target.resourcePath, data);

    const resourceId = data.id;
    if (typeof resourceId !== "string" || resourceId === "") {
      throw new CrossrefImportError(
        `${target.resourcePath} carries no typed id, so its enrichment cannot be ` +
          `named in a manifest.`,
      );
    }

    const items = Array.isArray(data.references) ? data.references : [];
    const reference = items
      .map(asRecord)
      .find((item) => item?.id === target.referenceId);
    const at = `${target.resourcePath} reference '${target.referenceId}'`;
    if (!reference) {
      throw new CrossrefImportError(
        `${at} no longer exists, so the corpus moved under the snapshot. Re-acquire ` +
          `rather than importing a receipt that names a reference the corpus lacks.`,
      );
    }
    const url = typeof reference.url === "string" ? reference.url : "";
    const matched = PMC_ARTICLE_URL_PATTERN.exec(url);
    if (!matched || matched[1] !== target.pmcid) {
      throw new CrossrefImportError(
        `${at} no longer cites ${target.pmcid}, so the corpus moved under the ` +
          `snapshot. Re-acquire rather than enriching a reference from a record it ` +
          `no longer resolves to.`,
      );
    }

    const work = snapshot.works.get(target.pmcid)!;
    enrichReference(reference, work, at);
    references.push({
      resourceId,
      resourcePath: target.resourcePath,
      referenceId: target.referenceId,
      doi: work.doi,
      pmcid: work.pmcid,
      pmid: work.pmid,
      authors: work.authors,
      containerTitle: work.containerTitle,
    });
  }

  const plannedResources = [...enrichedData.entries()]
    .sort(([left], [right]) => byString(left, right))
    .map(([path, data]) => ({ path, contents: formatYaml(data) }));

  const counts: CrossrefImportCounts = {
    resources: enrichedData.size,
    references: references.length,
  };

  const collapsedLicense = collapseSourceText(license);
  const collapsedAttribution = collapseSourceText(attribution);
  const collapsedNotice = collapseSourceText(notice);

  const requests = [...snapshot.acquisition.requests].sort(
    (left, right) =>
      byString(left.kind, right.kind) || byString(left.pmcid, right.pmcid),
  );

  const batchId = deriveBatchId(CROSSREF_SOURCE_NAME, {
    sourceNamespace: CROSSREF_SOURCE_NAMESPACE,
    retrievedAt: snapshot.acquisition.retrievedAt,
    importerVersion: CROSSREF_IMPORTER_VERSION,
    normalizationVersion: CROSSREF_NORMALIZATION_VERSION,
    license: collapsedLicense,
    attribution: collapsedAttribution,
    notice: collapsedNotice,
    requests,
    references,
  });

  const manifest: PlannedFile = {
    path: `manifests/${CROSSREF_SOURCE_NAME}/${batchId}.yaml`,
    contents: formatYaml({
      attribution: collapsedAttribution,
      batch_id: batchId,
      counts,
      importer_version: CROSSREF_IMPORTER_VERSION,
      kind: CROSSREF_MANIFEST_KIND,
      license: collapsedLicense,
      normalization_version: CROSSREF_NORMALIZATION_VERSION,
      notice: collapsedNotice,
      references: references.map((entry) => ({
        ...(entry.authors === null ? {} : { authors: entry.authors }),
        ...(entry.containerTitle === null
          ? {}
          : { container_title: entry.containerTitle }),
        doi: entry.doi,
        pmcid: entry.pmcid,
        ...(entry.pmid === null ? {} : { pmid: entry.pmid }),
        reference_id: entry.referenceId,
        resource_id: entry.resourceId,
      })),
      retrieved_at: snapshot.acquisition.retrievedAt,
      schema_version: 1,
      source: CROSSREF_SOURCE_NAME,
      source_namespace: CROSSREF_SOURCE_NAMESPACE,
    }),
  };

  const reports: PlannedFile[] = [
    {
      path: `${REPORTS_DIRECTORY}/${CROSSREF_SOURCE_NAME}/${batchId}-acquisition.json`,
      contents: serializeReport({
        version: REPORT_VERSION,
        batchId,
        sourceNamespace: CROSSREF_SOURCE_NAMESPACE,
        retrievedAt: snapshot.acquisition.retrievedAt,
        importerVersion: CROSSREF_IMPORTER_VERSION,
        normalizationVersion: CROSSREF_NORMALIZATION_VERSION,
        license: collapsedLicense,
        attribution: collapsedAttribution,
        notice: collapsedNotice,
        requests,
        references,
        excluded:
          "Abstracts and every other publisher-authored text; Crossref's publication " +
          "type, which states what kind of publication a work is and is not read as a " +
          "study design; and every other Crossref field beyond the DOI, the ordered " +
          "author names, and the container title.",
      }),
    },
  ];

  return {
    batchId,
    retrievedAt: snapshot.acquisition.retrievedAt,
    resources: plannedResources,
    manifest,
    reports,
    references,
    counts,
  };
};
