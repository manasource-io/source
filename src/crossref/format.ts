import { collapseSourceText } from "../lnhpd/format.ts";

/**
 * What a Crossref reference enrichment publishes into this corpus, and the
 * vocabulary every step of it shares.
 *
 * This importer enriches **curated resource references**, not records. A
 * curated reference already carries an editorial `url`, `title`, and `date`;
 * this path adds the bibliographic identity of the cited work — its DOI, its
 * ordered author names, and its container title — taken from the exact
 * Crossref works record the reference resolves to, and nothing else. It never
 * writes a record, a fact, a claim, a score, or an association, and it does
 * not translate Crossref's publication `type` into a study design: Crossref
 * states what kind of publication a work is, not how its study was designed.
 *
 * **The input is two real, named upstream services.** A reference citing a
 * PubMed Central article is resolved to its DOI through the NCBI PMC ID
 * Converter, and the DOI is resolved to its metadata through the Crossref
 * REST API works endpoint. Both are acquired to a snapshot with a receipt
 * first; import reads only the snapshot.
 *
 * **Only bibliographic facts are imported.** Crossref works records also
 * carry abstracts, and Crossref's documentation warns those can remain
 * copyrighted even though almost none of its metadata is subject to
 * copyright. The abstract — and every other publisher-authored text — stays
 * in the transient snapshot and never reaches a committed file.
 */

/** The source namespace this importer writes under. */
export const CROSSREF_SOURCE_NAMESPACE = "crossref.works";

/** The manifest directory name, and the prefix on derived batch ids. */
export const CROSSREF_SOURCE_NAME = "crossref";

/** Bump when the emitted reference shape or the reconciliation rules change. */
export const CROSSREF_IMPORTER_VERSION = "crossref-1";

/** Bump when `renderAuthorName` changes, which re-derives every author name. */
export const CROSSREF_NORMALIZATION_VERSION = "1.0.0";

/** The manifest `kind` a reference enrichment batch publishes. */
export const CROSSREF_MANIFEST_KIND = "reference_import_manifest";

/**
 * A curated reference is matched to an article by its URL alone: the PMC
 * article page it already cites. Anchored to the canonical host and the bare
 * accession so a lookalike URL cannot smuggle in a different article.
 */
export const PMC_ARTICLE_URL_PATTERN =
  /^https:\/\/pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC[0-9]+)\/?$/;

/** A DOI as `schemas/common.schema.json` spells it. */
export const DOI_PATTERN = /^10\.[0-9]{4,9}\/\S+$/;

export const PMCID_PATTERN = /^PMC[0-9]+$/;

export const PMID_PATTERN = /^[1-9][0-9]*$/;

/**
 * The NCBI PMC ID Converter, one request per PMCID. The old
 * `www.ncbi.nlm.nih.gov/pmc/utils/idconv` host now answers 301 to this one,
 * and acquisition does not follow redirects: the receipt records the URL that
 * actually served the bytes, so the canonical URL is the one requested.
 */
export const pmcIdconvUrl = (pmcid: string): string =>
  `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${pmcid}&format=json`;

/**
 * The Crossref works endpoint for one DOI. The DOI is percent-encoded whole:
 * a DOI suffix may legally carry `/`, `?` or `#`, and an unencoded one would
 * make the requested path depend on which characters the DOI happened to
 * contain.
 */
export const crossrefWorkUrl = (doi: string): string =>
  `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

/** Snapshot file names, keyed by the identifier each response answers to. */
export const idconvSnapshotFile = (pmcid: string): string => `idconv-${pmcid}.json`;

/**
 * A DOI contains `/`, which a file name cannot. The substitution is `_`,
 * applied to every `/`, and it is only a file name: the receipt records the
 * exact DOI and URL beside it.
 */
export const workSnapshotFile = (doi: string): string =>
  `crossref-${doi.replaceAll("/", "_").replaceAll("\\", "_")}.json`;

/**
 * Crossref's reuse terms, quoted from its current REST API documentation. The
 * warning about abstracts is part of the terms as this importer relies on
 * them: it is why the abstract is excluded rather than merely unused.
 */
export const CROSSREF_LICENSE =
  "Crossref's REST API documentation (https://www.crossref.org/documentation/retrieve-metadata/rest-api/) states that almost none of the metadata is subject to copyright, and you may use it for any purpose. It separately warns that abstracts can remain copyrighted; no abstract is imported.";

export const CROSSREF_ATTRIBUTION =
  "Bibliographic metadata from the Crossref REST API (https://api.crossref.org). PubMed Central identifiers were resolved to DOIs by the NCBI PMC ID Converter (https://pmc.ncbi.nlm.nih.gov/tools/idconv/).";

/**
 * The modification and scope notice, stated in full on every batch. This
 * importer *does* modify what it reads — it selects three fields and renders
 * author names — so saying exactly which ways is what keeps the trail honest.
 */
export const CROSSREF_NOTICE =
  "This batch enriches curated resource references with bibliographic identity only: the DOI, the ordered author names, and the container title of each cited work, taken from the exact Crossref works record its PubMed Central identifier resolves to. Author names are rendered by one deterministic rule — the Crossref given and family names joined by a single space (or the literal name for a corporate author), whitespace collapsed — in exactly the order Crossref serves them; nothing is reordered, initialed, or respelled. The container title is the first entry of the Crossref container-title list. A fact Crossref does not state stays absent. No abstract or other publisher-authored text is imported, and Crossref's publication type is not read as a study design. Each reference's curated url, title, and date are untouched. Acquisition and import are separate: each upstream response is recorded with its URL, served instant, byte count, and SHA-256 digest in the acquisition receipt, the committed report beside this manifest preserves that trail, and re-running the import over its own output writes nothing.";

export class CrossrefImportError extends Error {
  override readonly name = "CrossrefImportError";
}

/**
 * One Crossref author, as the works record states it. `given`/`family` name a
 * person; `name` is Crossref's field for a corporate author stated whole.
 */
export type CrossrefAuthor = {
  given?: string;
  family?: string;
  name?: string;
};

/**
 * The one deterministic author-name rule, versioned by
 * `CROSSREF_NORMALIZATION_VERSION`: given and family joined by a single
 * space, falling back to the literal corporate name, whitespace collapsed.
 * Order is the caller's job — Crossref's order is preserved, never re-sorted.
 */
export const renderAuthorName = (author: CrossrefAuthor): string => {
  const person = [author.given, author.family]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ");
  const rendered = person !== "" ? person : typeof author.name === "string" ? author.name : "";
  return collapseSourceText(rendered);
};
