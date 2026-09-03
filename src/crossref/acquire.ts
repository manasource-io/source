import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CrossrefImportError,
  PMC_ARTICLE_URL_PATTERN,
  crossrefWorkUrl,
  idconvSnapshotFile,
  pmcIdconvUrl,
  workSnapshotFile,
} from "./format.ts";
import {
  CROSSREF_ACQUISITION_CONTRACT,
  readIdconvRecord,
  readTargetResources,
  readWorkRecord,
} from "./read.ts";
import type {
  CrossrefAcquiredRequest,
  CrossrefAcquisition,
  CrossrefAcquisitionTarget,
} from "./read.ts";

/**
 * The only part of this importer that touches the network, kept apart from
 * every part that decides what gets published.
 *
 * It resolves each named reference's PMCID to a DOI through the NCBI PMC ID
 * Converter, fetches that DOI's Crossref works record, writes both bodies to
 * a snapshot directory, and writes a receipt naming exactly what it did —
 * URL, served instant, byte count, SHA-256 digest — plus the references it
 * was run for. Nothing downstream fetches anything: `read.ts` re-verifies
 * the snapshot against the receipt, so an import is a function of a snapshot
 * on disk rather than of whatever the services happened to serve while it
 * ran.
 *
 * **It reaches exactly the endpoints the named references need.** One idconv
 * request per PMCID, one works request per resolved DOI, no authentication,
 * no keys, nothing else. The target references come from the corpus resource
 * files named by the caller: a reference is a target when its URL is a PMC
 * article page, and a matching reference without a local `id` refuses the
 * run — an enrichment that cannot be named in a manifest cannot be audited.
 *
 * **The snapshot is transient by design.** The Crossref body carries fields
 * this corpus must not commit — the abstract among them — so what belongs in
 * the repository is the enriched corpus plus the committed report saying
 * exactly which bytes produced it. Anyone can repeat the downloads from the
 * URLs the receipt records and check the digests.
 */

export type CrossrefAcquireOptions = {
  directory: string;
  corpusRoot: string;
  /** Resource paths to enrich, relative to the corpus root. */
  resourcePaths: readonly string[];
  fetchImplementation?: typeof fetch;
  onProgress?: (message: string) => void;
};

type FetchedBody = {
  bytes: Uint8Array;
  declaredBytes: number | null;
  servedAt: string;
};

const fetchWhole = async (
  url: string,
  fetchImplementation: typeof fetch,
): Promise<FetchedBody> => {
  // `identity`, as on every acquisition here: offered a compressed encoding,
  // a declared `content-length` would describe bytes the client then throws
  // away, leaving nothing to check the transfer against.
  const response = await fetchImplementation(url, {
    headers: { "accept-encoding": "identity" },
    redirect: "manual",
  });
  if (response.status !== 200) {
    throw new CrossrefImportError(
      `${url} answered HTTP ${response.status}. Only a 200 carries a complete body.`,
    );
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null) {
    throw new CrossrefImportError(
      `${url} answered with content-encoding '${encoding}' despite being asked for ` +
        `identity, so its content-length describes bytes other than the body.`,
    );
  }

  // Crossref's works endpoint declares no content-length; when one is
  // declared it must hold, and wholeness otherwise rests on the strict JSON
  // parse of the body plus the digest the receipt records.
  const declaredHeader = response.headers.get("content-length");
  let declaredBytes: number | null = null;
  if (declaredHeader !== null) {
    declaredBytes = Number(declaredHeader);
    if (!Number.isInteger(declaredBytes) || declaredBytes < 1) {
      throw new CrossrefImportError(
        `${url} declared content-length '${declaredHeader}', which is not a positive integer.`,
      );
    }
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (declaredBytes !== null && bytes.byteLength !== declaredBytes) {
    throw new CrossrefImportError(
      `${url} delivered ${bytes.byteLength} bytes for a declared content-length of ` +
        `${declaredBytes}, so the download is a fragment rather than the record.`,
    );
  }

  const servedHeader = response.headers.get("date");
  const servedAt = new Date(servedHeader ?? "");
  if (servedHeader === null || Number.isNaN(servedAt.getTime())) {
    throw new CrossrefImportError(
      `${url} declared no parseable 'date' header, so the served instant cannot be recorded.`,
    );
  }

  return { bytes, declaredBytes, servedAt: servedAt.toISOString() };
};

const parsedJson = (bytes: Uint8Array, url: string): unknown => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CrossrefImportError(
      `The ${url} response is not valid JSON: ${(error as Error).message}. That is ` +
        `what a truncated transfer looks like, so the snapshot is refused.`,
    );
  }
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const collectTargets = (
  corpusRoot: string,
  resourcePaths: readonly string[],
): CrossrefAcquisitionTarget[] => {
  const root = resolve(corpusRoot);
  const targets: CrossrefAcquisitionTarget[] = [];
  const resources = readTargetResources(root, resourcePaths);

  for (const resource of resources) {
    const references = Array.isArray(resource.data.references)
      ? resource.data.references
      : [];
    for (const item of references) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const reference = item as Record<string, unknown>;
      if (typeof reference.url !== "string") continue;
      const matched = PMC_ARTICLE_URL_PATTERN.exec(reference.url);
      if (!matched) continue;
      if (typeof reference.id !== "string" || reference.id === "") {
        throw new CrossrefImportError(
          `${resource.path} cites ${matched[1]} in a reference without a local id. ` +
            `Give the reference an id first: an enrichment a manifest cannot name ` +
            `cannot be audited.`,
        );
      }
      targets.push({
        resourcePath: resource.path,
        referenceId: reference.id,
        pmcid: matched[1]!,
      });
    }
    if (!targets.some((target) => target.resourcePath === resource.path)) {
      throw new CrossrefImportError(
        `${resource.path} cites no PMC article page, so this acquisition has nothing ` +
          `to resolve for it.`,
      );
    }
  }
  return targets;
};

export const acquireCrossrefReferences = async ({
  directory,
  corpusRoot,
  resourcePaths,
  fetchImplementation = fetch,
  onProgress = () => {},
}: CrossrefAcquireOptions): Promise<CrossrefAcquisition> => {
  if (resourcePaths.length === 0) {
    throw new CrossrefImportError("No resource path was named, so there is nothing to acquire.");
  }
  const targets = collectTargets(corpusRoot, resourcePaths);
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });

  const requests: CrossrefAcquiredRequest[] = [];
  const resolvedDois = new Map<string, string>();
  const pmcids = [...new Set(targets.map((target) => target.pmcid))].sort();

  for (const pmcid of pmcids) {
    const url = pmcIdconvUrl(pmcid);
    onProgress(`fetching ${url}`);
    const body = await fetchWhole(url, fetchImplementation);
    // Parsed now so a refused response never becomes a snapshot: the same
    // shape check the import runs, run before anything is written.
    const { doi } = readIdconvRecord(parsedJson(body.bytes, url), pmcid, url);
    const file = idconvSnapshotFile(pmcid);
    writeFileSync(resolve(root, file), body.bytes);
    requests.push({
      kind: "pmc_idconv",
      pmcid,
      doi: null,
      url,
      file,
      httpStatus: 200,
      declaredBytes: body.declaredBytes,
      observedBytes: body.bytes.byteLength,
      sha256: sha256(body.bytes),
      servedAt: body.servedAt,
    });
    const claimedBy = [...resolvedDois.entries()].find(
      ([, held]) => held.toLowerCase() === doi.toLowerCase(),
    );
    if (claimedBy) {
      throw new CrossrefImportError(
        `${pmcid} and ${claimedBy[0]} both resolve to DOI '${doi}', so they name one ` +
          `work and the trail would not be one-to-one.`,
      );
    }
    resolvedDois.set(pmcid, doi);
    onProgress(`${pmcid}: DOI ${doi}, ${body.bytes.byteLength} bytes`);
  }

  for (const pmcid of pmcids) {
    const doi = resolvedDois.get(pmcid)!;
    const url = crossrefWorkUrl(doi);
    onProgress(`fetching ${url}`);
    const body = await fetchWhole(url, fetchImplementation);
    readWorkRecord(parsedJson(body.bytes, url), doi, url);
    const file = workSnapshotFile(doi);
    writeFileSync(resolve(root, file), body.bytes);
    requests.push({
      kind: "crossref_work",
      pmcid,
      doi,
      url,
      file,
      httpStatus: 200,
      declaredBytes: body.declaredBytes,
      observedBytes: body.bytes.byteLength,
      sha256: sha256(body.bytes),
      servedAt: body.servedAt,
    });
    onProgress(`${doi}: ${body.bytes.byteLength} bytes, sha256 ${sha256(body.bytes)}`);
  }

  // The batch's retrieval instant is the newest of the responses, so it is
  // never earlier than any byte in the snapshot.
  const retrievedAt = requests
    .map((request) => request.servedAt)
    .sort()
    .at(-1)!;

  const acquisition: CrossrefAcquisition = {
    contract: CROSSREF_ACQUISITION_CONTRACT,
    retrievedAt,
    targets,
    requests,
  };
  writeFileSync(
    resolve(root, "acquisition.json"),
    `${JSON.stringify(acquisition, null, 2)}\n`,
    "utf8",
  );
  return acquisition;
};
