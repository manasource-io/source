import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { parseAllDocuments } from "yaml";
import {
  CrossrefImportError,
  DOI_PATTERN,
  PMCID_PATTERN,
  PMID_PATTERN,
  renderAuthorName,
} from "./format.ts";
import type { CrossrefAuthor } from "./format.ts";
import { collapseSourceText } from "../lnhpd/format.ts";

/**
 * The strict half of the Crossref reference contract: an acquired snapshot
 * in, verified works out, or nothing at all.
 *
 * **Shape is contract; the batch fails closed.** This batch is a handful of
 * named references, not a bulk feed, so there is no quarantine lane: a
 * response that is not the shape NCBI or Crossref was observed to publish
 * refuses the whole batch rather than publishing the references that happened
 * to parse. Unlike the LNHPD bulk columns, the Crossref works record is an
 * open object this importer reads a projection of — extra upstream fields are
 * expected and ignored, but a field it does read must hold the declared type.
 *
 * **Wholeness is proven against the receipt.** Crossref's works endpoint
 * declares no `content-length`, so wholeness rests on three checks that must
 * all agree: the file on disk is exactly the bytes the receipt recorded and
 * digests to its SHA-256, the body parses as strict JSON (a truncated
 * response does not), and the payload's own DOI matches the one the receipt
 * says was requested. An edited or re-fetched snapshot cannot be imported
 * under the old receipt's provenance.
 */

/** The receipt `acquire.ts` writes beside a snapshot, and this module trusts. */
export const CROSSREF_ACQUISITION_CONTRACT =
  "manasource/crossref-reference-acquisition/1";

export const CROSSREF_REQUEST_KINDS = ["pmc_idconv", "crossref_work"] as const;

export type CrossrefRequestKind = (typeof CROSSREF_REQUEST_KINDS)[number];

/** One upstream request: URL, served instant, byte count, and digest. */
export type CrossrefAcquiredRequest = {
  kind: CrossrefRequestKind;
  pmcid: string;
  /** The requested DOI for a `crossref_work` request; null for idconv. */
  doi: string | null;
  /** The exact URL requested, recorded so a reader can repeat the download. */
  url: string;
  file: string;
  httpStatus: number;
  /** The `content-length` the response declared, or null if it declared none. */
  declaredBytes: number | null;
  /** The bytes actually written to disk. */
  observedBytes: number;
  sha256: string;
  /** The response's own `date` header: when the upstream served these bytes. */
  servedAt: string;
};

/** One reference the acquisition was run for, named at acquire time. */
export type CrossrefAcquisitionTarget = {
  resourcePath: string;
  referenceId: string;
  pmcid: string;
};

export type CrossrefAcquisition = {
  contract: string;
  /**
   * The instant this batch is published as having been retrieved: the newest
   * `servedAt` across the requests, never a clock at import time, so
   * re-importing one snapshot emits identical bytes whenever it runs.
   */
  retrievedAt: string;
  targets: CrossrefAcquisitionTarget[];
  requests: CrossrefAcquiredRequest[];
};

/** The bibliographic facts one verified works record states. */
export type CrossrefWorkFacts = {
  pmcid: string;
  /** From the ID converter; null when the converter states none. */
  pmid: string | null;
  /** Crossref's own `message.DOI`, verbatim. */
  doi: string;
  /** Rendered author names in exactly Crossref's order; null when absent. */
  authors: string[] | null;
  /** The first `container-title` entry; null when Crossref states none. */
  containerTitle: string | null;
};

export type CrossrefSnapshot = {
  acquisition: CrossrefAcquisition;
  /** Verified works keyed by the PMCID they were reached through. */
  works: Map<string, CrossrefWorkFacts>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  const kind = typeof value;
  return `${kind === "object" ? "an" : "a"} ${kind}`;
};

const refuse = (message: string): never => {
  throw new CrossrefImportError(
    `${message} This importer reads an acquisition snapshot declaring contract ` +
      `'${CROSSREF_ACQUISITION_CONTRACT}': one NCBI ID Converter response per ` +
      `PMCID and one Crossref works response per DOI, each verified byte-for-byte ` +
      `against the receipt beside it. A snapshot that does not match its receipt ` +
      `fails the whole batch closed rather than publishing under provenance it ` +
      `cannot prove.`,
  );
};

const requireString = (
  raw: Record<string, unknown>,
  key: string,
  at: string,
): string => {
  const value = raw[key];
  if (typeof value !== "string" || value === "") {
    refuse(`${at}.${key} is ${describe(value)}, not a non-empty string.`);
  }
  return value as string;
};

const SAFE_SNAPSHOT_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_RESOURCE_PATH =
  /^resources\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)+[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/;

/** Receipt-controlled snapshot files are names, never paths. */
const requireSafeSnapshotBasename = (file: string, at: string): void => {
  if (
    file === "." ||
    file === ".." ||
    file.includes("/") ||
    file.includes("\\") ||
    isAbsolute(file) ||
    posix.isAbsolute(file) ||
    win32.isAbsolute(file) ||
    !SAFE_SNAPSHOT_BASENAME.test(file)
  ) {
    refuse(
      `${at} is '${file}', not one safe snapshot-file basename. Absolute paths, ` +
        `parent traversal, separators, and non-portable filename characters are refused.`,
    );
  }
};

/** Resource targets use one canonical repository-relative POSIX spelling. */
const requireCanonicalResourcePath = (path: string, at: string): void => {
  if (
    path.includes("\\") ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    !CANONICAL_RESOURCE_PATH.test(path)
  ) {
    refuse(
      `${at} is '${path}', not a canonical repository-relative POSIX resource YAML path.`,
    );
  }
};

export const parseCrossrefAcquisition = (
  text: string,
  at: string,
): CrossrefAcquisition => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    refuse(`${at} is not valid JSON: ${(error as Error).message}.`);
  }
  if (!isPlainObject(parsed)) {
    refuse(`${at} is ${describe(parsed)}, not a mapping.`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.contract !== CROSSREF_ACQUISITION_CONTRACT) {
    refuse(`${at} declares contract ${JSON.stringify(raw.contract) ?? "nothing"}.`);
  }

  const retrievedAt = requireString(raw, "retrievedAt", at);
  if (Number.isNaN(Date.parse(retrievedAt))) {
    refuse(`${at}.retrievedAt '${retrievedAt}' is not a parseable instant.`);
  }

  if (!Array.isArray(raw.targets)) {
    refuse(`${at}.targets is ${describe(raw.targets)}, not a list.`);
  }
  const targets: CrossrefAcquisitionTarget[] = [];
  const targetKeys = new Set<string>();
  for (const [position, entry] of (raw.targets as unknown[]).entries()) {
    const where = `${at}.targets[${position}]`;
    if (!isPlainObject(entry)) {
      refuse(`${where} is ${describe(entry)}, not a mapping.`);
    }
    const item = entry as Record<string, unknown>;
    const target: CrossrefAcquisitionTarget = {
      resourcePath: requireString(item, "resourcePath", where),
      referenceId: requireString(item, "referenceId", where),
      pmcid: requireString(item, "pmcid", where),
    };
    requireCanonicalResourcePath(target.resourcePath, `${where}.resourcePath`);
    if (!PMCID_PATTERN.test(target.pmcid)) {
      refuse(`${where}.pmcid '${target.pmcid}' is not a PMCID.`);
    }
    const key = `${target.resourcePath} ${target.referenceId}`;
    if (targetKeys.has(key)) {
      refuse(`${where} repeats reference '${key}'.`);
    }
    targetKeys.add(key);
    targets.push(target);
  }
  if (targets.length === 0) {
    refuse(`${at} names no target references, so the batch has nothing to enrich.`);
  }

  if (!Array.isArray(raw.requests)) {
    refuse(`${at}.requests is ${describe(raw.requests)}, not a list.`);
  }
  const requests: CrossrefAcquiredRequest[] = [];
  for (const [position, entry] of (raw.requests as unknown[]).entries()) {
    const where = `${at}.requests[${position}]`;
    if (!isPlainObject(entry)) {
      refuse(`${where} is ${describe(entry)}, not a mapping.`);
    }
    const item = entry as Record<string, unknown>;
    const kind = requireString(item, "kind", where);
    if (!(CROSSREF_REQUEST_KINDS as readonly string[]).includes(kind)) {
      refuse(`${where}.kind '${kind}' is not one of ${CROSSREF_REQUEST_KINDS.join(", ")}.`);
    }
    const httpStatus = item.httpStatus;
    if (httpStatus !== 200) {
      refuse(`${where} records HTTP ${String(httpStatus)}. Only a 200 carries a complete body.`);
    }
    const declaredBytes = item.declaredBytes;
    if (declaredBytes !== null && (!Number.isInteger(declaredBytes) || (declaredBytes as number) < 1)) {
      refuse(`${where}.declaredBytes is ${String(declaredBytes)}, not null or a positive integer.`);
    }
    const observedBytes = item.observedBytes;
    if (!Number.isInteger(observedBytes) || (observedBytes as number) < 1) {
      refuse(`${where}.observedBytes is ${String(observedBytes)}, not a positive integer.`);
    }
    if (declaredBytes !== null && declaredBytes !== observedBytes) {
      refuse(
        `${where} wrote ${String(observedBytes)} bytes for a response declaring ` +
          `content-length ${String(declaredBytes)}, so the download is a fragment.`,
      );
    }
    const pmcid = requireString(item, "pmcid", where);
    if (!PMCID_PATTERN.test(pmcid)) {
      refuse(`${where}.pmcid '${pmcid}' is not a PMCID.`);
    }
    const doi = item.doi;
    if (kind === "crossref_work") {
      if (typeof doi !== "string" || !DOI_PATTERN.test(doi)) {
        refuse(`${where}.doi is ${describe(doi)}, not the requested DOI.`);
      }
    } else if (doi !== null) {
      refuse(`${where}.doi is ${describe(doi)}; an idconv request states null.`);
    }
    const file = requireString(item, "file", where);
    requireSafeSnapshotBasename(file, `${where}.file`);
    requests.push({
      kind: kind as CrossrefRequestKind,
      pmcid,
      doi: (doi ?? null) as string | null,
      url: requireString(item, "url", where),
      file,
      httpStatus: 200,
      declaredBytes: declaredBytes as number | null,
      observedBytes: observedBytes as number,
      sha256: requireString(item, "sha256", where),
      servedAt: requireString(item, "servedAt", where),
    });
  }

  for (const kind of CROSSREF_REQUEST_KINDS) {
    for (const target of targets) {
      const held = requests.filter(
        (request) => request.kind === kind && request.pmcid === target.pmcid,
      );
      if (held.length !== 1) {
        refuse(
          `${at} carries ${held.length} '${kind}' request(s) for ${target.pmcid}; ` +
            `exactly one per PMCID is what makes the trail checkable.`,
        );
      }
    }
  }
  const targetPmcids = new Set(targets.map((target) => target.pmcid));
  for (const request of requests) {
    if (!targetPmcids.has(request.pmcid)) {
      refuse(
        `${at} records a request for ${request.pmcid}, which no target reference names.`,
      );
    }
  }

  return { contract: CROSSREF_ACQUISITION_CONTRACT, retrievedAt, targets, requests };
};

const readVerifiedJson = (
  root: string,
  request: CrossrefAcquiredRequest,
): unknown => {
  const path = resolve(root, request.file);
  const file = lstatSync(path);
  if (!file.isFile()) {
    refuse(`${request.file} is not a regular snapshot file.`);
  }
  const size = file.size;
  if (size !== request.observedBytes) {
    refuse(
      `${request.file} is ${size} bytes on disk but the receipt records ` +
        `${request.observedBytes}, so the snapshot changed after acquisition.`,
    );
  }
  const bytes = readFileSync(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== request.sha256) {
    refuse(
      `${request.file} digests to ${digest} but the receipt records ` +
        `${request.sha256}, so the snapshot changed after acquisition.`,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    refuse(
      `${request.file} is not valid JSON: ${(error as Error).message}. A truncated ` +
        `response fails exactly here.`,
    );
  }
};

/** The PMCID → (DOI, PMID) mapping one verified ID Converter response states. */
export const readIdconvRecord = (
  payload: unknown,
  pmcid: string,
  at: string,
): { doi: string; pmid: string | null } => {
  if (!isPlainObject(payload)) {
    refuse(`${at} is ${describe(payload)}, not a mapping.`);
  }
  const raw = payload as Record<string, unknown>;
  if (raw.status !== "ok") {
    refuse(`${at} reports status ${JSON.stringify(raw.status)}, not "ok".`);
  }
  if (!Array.isArray(raw.records) || raw.records.length !== 1) {
    refuse(
      `${at}.records is not the single-record list one requested PMCID returns.`,
    );
  }
  const record = (raw.records as unknown[])[0];
  if (!isPlainObject(record)) {
    refuse(`${at}.records[0] is ${describe(record)}, not a mapping.`);
  }
  const row = record as Record<string, unknown>;
  if (row.pmcid !== pmcid) {
    refuse(
      `${at}.records[0].pmcid is ${JSON.stringify(row.pmcid)}, not the requested ${pmcid}.`,
    );
  }
  const doi = row.doi;
  if (typeof doi !== "string" || !DOI_PATTERN.test(doi)) {
    refuse(`${at}.records[0].doi is ${describe(doi)}, not a DOI, so ${pmcid} cannot be resolved.`);
  }
  // The converter serves the PMID as a JSON number; either spelling is read,
  // and its absence is a fact rather than a failure.
  const pmid = row.pmid;
  let pmidText: string | null = null;
  if (typeof pmid === "number" && Number.isInteger(pmid)) pmidText = String(pmid);
  else if (typeof pmid === "string" && pmid !== "") pmidText = pmid;
  else if (pmid !== undefined && pmid !== null) {
    refuse(`${at}.records[0].pmid is ${describe(pmid)}, not an integer, a string, or absent.`);
  }
  if (pmidText !== null && !PMID_PATTERN.test(pmidText)) {
    refuse(`${at}.records[0].pmid '${pmidText}' is not a PMID.`);
  }
  return { doi: doi as string, pmid: pmidText };
};

/** The projection one verified Crossref works response states. */
export const readWorkRecord = (
  payload: unknown,
  requestedDoi: string,
  at: string,
): { doi: string; authors: string[] | null; containerTitle: string | null } => {
  if (!isPlainObject(payload)) {
    refuse(`${at} is ${describe(payload)}, not a mapping.`);
  }
  const raw = payload as Record<string, unknown>;
  if (raw.status !== "ok") {
    refuse(`${at} reports status ${JSON.stringify(raw.status)}, not "ok".`);
  }
  if (!isPlainObject(raw.message)) {
    refuse(`${at}.message is ${describe(raw.message)}, not a mapping.`);
  }
  const message = raw.message as Record<string, unknown>;

  const doi = message.DOI;
  if (typeof doi !== "string" || !DOI_PATTERN.test(doi)) {
    refuse(`${at}.message.DOI is ${describe(doi)}, not a DOI.`);
  }
  // DOIs are case-insensitive by specification; the served spelling is the
  // one published.
  if ((doi as string).toLowerCase() !== requestedDoi.toLowerCase()) {
    refuse(
      `${at}.message.DOI is '${String(doi)}' but the receipt requested '${requestedDoi}', ` +
        `so this file answers a different work.`,
    );
  }

  let authors: string[] | null = null;
  if (message.author !== undefined) {
    if (!Array.isArray(message.author) || message.author.length === 0) {
      refuse(`${at}.message.author is ${describe(message.author)}, not a non-empty list.`);
    }
    authors = (message.author as unknown[]).map((entry, position) => {
      if (!isPlainObject(entry)) {
        refuse(`${at}.message.author[${position}] is ${describe(entry)}, not a mapping.`);
      }
      const rendered = renderAuthorName(entry as CrossrefAuthor);
      if (rendered === "") {
        refuse(
          `${at}.message.author[${position}] states neither a given/family name nor a ` +
            `literal name, so the author list cannot be rendered whole.`,
        );
      }
      return rendered;
    });
  }

  let containerTitle: string | null = null;
  const container = message["container-title"];
  if (container !== undefined) {
    if (!Array.isArray(container)) {
      refuse(`${at}.message["container-title"] is ${describe(container)}, not a list.`);
    }
    const first = (container as unknown[])[0];
    if (first !== undefined) {
      if (typeof first !== "string") {
        refuse(`${at}.message["container-title"][0] is ${describe(first)}, not a string.`);
      }
      const collapsed = collapseSourceText(first as string);
      containerTitle = collapsed === "" ? null : collapsed;
    }
  }

  return { doi: doi as string, authors, containerTitle };
};

/**
 * Reads a whole snapshot: the receipt, then each response re-verified against
 * it, then the ID trail re-checked end to end — the idconv DOI must be the
 * DOI the works request was recorded for, and the works payload must answer
 * that DOI. Two PMCIDs resolving to one DOI would publish one work under two
 * identities and are refused.
 */
export const readCrossrefSnapshot = (directory: string): CrossrefSnapshot => {
  const root = resolve(directory);
  const acquisition = parseCrossrefAcquisition(
    readFileSync(resolve(root, "acquisition.json"), "utf8"),
    "acquisition.json",
  );

  const works = new Map<string, CrossrefWorkFacts>();
  const seenDois = new Map<string, string>();
  for (const target of acquisition.targets) {
    if (works.has(target.pmcid)) continue;
    const idconvRequest = acquisition.requests.find(
      (request) => request.kind === "pmc_idconv" && request.pmcid === target.pmcid,
    )!;
    const workRequest = acquisition.requests.find(
      (request) => request.kind === "crossref_work" && request.pmcid === target.pmcid,
    )!;

    const { doi, pmid } = readIdconvRecord(
      readVerifiedJson(root, idconvRequest),
      target.pmcid,
      idconvRequest.file,
    );
    if (workRequest.doi !== doi) {
      refuse(
        `${idconvRequest.file} resolves ${target.pmcid} to '${doi}' but the receipt ` +
          `records a works request for '${String(workRequest.doi)}'.`,
      );
    }
    const claimedBy = seenDois.get(doi.toLowerCase());
    if (claimedBy !== undefined) {
      refuse(
        `${target.pmcid} and ${claimedBy} both resolve to DOI '${doi}', so they name ` +
          `one work and the trail is not one-to-one.`,
      );
    }
    seenDois.set(doi.toLowerCase(), target.pmcid);

    const work = readWorkRecord(readVerifiedJson(root, workRequest), doi, workRequest.file);
    works.set(target.pmcid, {
      pmcid: target.pmcid,
      pmid,
      doi: work.doi,
      authors: work.authors,
      containerTitle: work.containerTitle,
    });
  }

  return { acquisition, works };
};

export type CrossrefResourceFile = {
  /** Corpus-relative path, `/`-separated. */
  path: string;
  data: Record<string, unknown>;
};

/**
 * Reads exactly the resource files named — for import, the receipt's target
 * paths. Import may touch no other file, so no other file is read: the
 * corpus scan that would find further references citing the same works is
 * deliberately absent — enriching a reference the acquisition was not run
 * for would publish under a receipt that never named it.
 */
export const readTargetResources = (
  corpusRoot: string,
  resourcePaths: readonly string[],
): CrossrefResourceFile[] => {
  const root = resolve(corpusRoot);
  const resourcesRoot = resolve(root, "resources");
  const paths = [...new Set(resourcePaths)].sort();
  for (const path of paths) {
    requireCanonicalResourcePath(path, "Target resource path");
  }
  if (paths.length === 0) return [];

  let resourcesDirectory;
  try {
    resourcesDirectory = lstatSync(resourcesRoot);
  } catch (error) {
    return refuse(
      `Corpus resources directory cannot be inspected: ${(error as Error).message}.`,
    );
  }
  if (!resourcesDirectory.isDirectory() || resourcesDirectory.isSymbolicLink()) {
    refuse("Corpus resources path is not an ordinary directory; symbolic links are refused.");
  }

  let realResourcesRoot: string;
  try {
    realResourcesRoot = realpathSync(resourcesRoot);
  } catch (error) {
    return refuse(
      `Corpus resources directory cannot be resolved: ${(error as Error).message}.`,
    );
  }

  return paths.map((path) => {
    const absolutePath = resolve(root, ...path.split("/"));
    const beneathResources = relative(resourcesRoot, absolutePath);
    if (
      beneathResources === "" ||
      beneathResources === ".." ||
      beneathResources.startsWith(`..${sep}`) ||
      isAbsolute(beneathResources)
    ) {
      refuse(`Target resource path '${path}' resolves outside the corpus resources directory.`);
    }
    const canonical = relative(root, absolutePath).split(sep).join("/");
    if (canonical !== path) {
      refuse(
        `Target resource path '${path}' resolves as '${canonical}', not its canonical ` +
          `repository-relative POSIX spelling.`,
      );
    }

    let file;
    try {
      file = lstatSync(absolutePath);
    } catch (error) {
      return refuse(`Target resource '${path}' cannot be inspected: ${(error as Error).message}.`);
    }
    if (!file.isFile() || file.isSymbolicLink()) {
      refuse(`Target resource '${path}' is not an ordinary file; symbolic links are refused.`);
    }

    let realPath: string;
    try {
      realPath = realpathSync(absolutePath);
    } catch (error) {
      return refuse(`Target resource '${path}' cannot be resolved: ${(error as Error).message}.`);
    }
    const beneathRealResources = relative(realResourcesRoot, realPath);
    if (
      beneathRealResources === "" ||
      beneathRealResources === ".." ||
      beneathRealResources.startsWith(`..${sep}`) ||
      isAbsolute(beneathRealResources)
    ) {
      refuse(
        `Target resource '${path}' resolves outside the real corpus resources directory; ` +
          `symbolic-link parent escapes are refused.`,
      );
    }

    let text: string;
    try {
      text = readFileSync(absolutePath, "utf8");
    } catch (error) {
      return refuse(`Target resource '${path}' cannot be read: ${(error as Error).message}.`);
    }
    const documents = parseAllDocuments(text, {
      merge: false,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
    const document = documents[0];
    if (documents.length !== 1 || !document || document.errors.length > 0) {
      refuse(`Target resource '${path}' is not one well-formed YAML document.`);
    }
    const data = document!.toJS({ maxAliasCount: 100 }) as unknown;
    if (!isPlainObject(data)) {
      refuse(`Target resource '${path}' is ${describe(data)}, not a mapping.`);
    }
    return { path, data: data as Record<string, unknown> };
  });
};
