import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
export const WIKIDATA_ACQUISITION_CONTRACT = "manasource.wikidata-sparql.v2";

export const WIKIDATA_FACET_VARIABLES = [
  "item",
  "itemLabel",
  "alias",
  "unii",
  "cas",
  "pubchemCid",
  "role",
  "roleLabel",
  "atc",
  "class",
  "classLabel",
] as const;
export const WIKIDATA_PEPTIDE_VARIABLES = ["item", "isPeptide"] as const;
export const WIKIDATA_RESULT_VARIABLES = [
  ...WIKIDATA_FACET_VARIABLES,
  "isPeptide",
] as const;

/**
 * The corpus identifiers a snapshot is selected by, in the order the importer
 * joins on them, each with the Wikidata property that carries it and the shape
 * a value must have before it may be written into a query.
 */
export const WIKIDATA_SELECTION_KINDS = [
  { kind: "unii", property: "P652", pattern: /^[A-Z0-9]{10}$/ },
  { kind: "cas_number", property: "P231", pattern: /^[0-9]{2,7}-[0-9]{2}-[0-9]$/ },
  { kind: "pubchem_cid", property: "P662", pattern: /^[1-9][0-9]*$/ },
] as const;

export type WikidataSelectionKind = (typeof WIKIDATA_SELECTION_KINDS)[number]["kind"];

const PROPERTY_PLACEHOLDER = "{{PROPERTY}}";
const VALUES_PLACEHOLDER = "{{VALUES}}";
const SELECTION = `VALUES ?selected { ${VALUES_PLACEHOLDER} } ?item wdt:${PROPERTY_PLACEHOLDER} ?selected .`;

/**
 * One row per property value, never a cross-product. Every arm repeats the
 * selection: the endpoint evaluates a UNION arm on its own, and an arm that
 * does not bind `?item` itself scans the whole graph.
 */
export const WIKIDATA_FACET_QUERY = `SELECT DISTINCT ?item ?itemLabel ?alias ?unii ?cas ?pubchemCid ?role ?roleLabel ?atc ?class ?classLabel WHERE {
  { ${SELECTION} ?item wdt:P652 ?unii . }
  UNION
  { ${SELECTION} ?item wdt:P231 ?cas . }
  UNION
  { ${SELECTION} ?item wdt:P662 ?pubchemCid . }
  UNION
  { ${SELECTION} ?item wdt:P2868 ?role . OPTIONAL { ?role rdfs:label ?roleLabel . FILTER(LANG(?roleLabel) = "en") } }
  UNION
  { ${SELECTION} ?item wdt:P267 ?atc . }
  UNION
  { ${SELECTION} ?item wdt:P31 ?class . OPTIONAL { ?class rdfs:label ?classLabel . FILTER(LANG(?classLabel) = "en") } }
  UNION
  { ${SELECTION} ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") }
  UNION
  { ${SELECTION} ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
}`;

/**
 * P31/P279* membership of Q172847 (peptide), one row per member item. It is
 * its own request because the subclass path only terminates in time when the
 * endpoint walks it forward from the item's own classes.
 */
export const WIKIDATA_PEPTIDE_QUERY = `SELECT DISTINCT ?item ?isPeptide WHERE {
  ${SELECTION}
  ?item wdt:P31 ?peptideClass .
  ?peptideClass wdt:P279* wd:Q172847 .
  hint:Prior hint:gearing "forward" .
  BIND(true AS ?isPeptide)
}`;

const BOOLEAN_DATATYPE = "http://www.w3.org/2001/XMLSchema#boolean";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RECEIPT_KEYS = [
  "contract",
  "endpoint",
  "queries",
  "selection",
  "retrieved_at",
  "result_file",
  "sha256",
  "byte_count",
  "row_count",
] as const;

export type WikidataResultVariable = (typeof WIKIDATA_RESULT_VARIABLES)[number];

export type WikidataSparqlTerm = {
  type: "uri" | "literal" | "typed-literal" | "bnode";
  value: string;
  "xml:lang"?: string;
  datatype?: string;
};

export type WikidataBinding = Partial<
  Record<WikidataResultVariable, WikidataSparqlTerm>
>;

export type WikidataResult = {
  head: { vars: WikidataResultVariable[] };
  results: { bindings: WikidataBinding[] };
};

export type WikidataSelection = Record<WikidataSelectionKind, string[]>;

export type WikidataSelectionDigest = { count: number; sha256: string };

export type WikidataReceipt = {
  contract: typeof WIKIDATA_ACQUISITION_CONTRACT;
  endpoint: string;
  queries: {
    facets: typeof WIKIDATA_FACET_QUERY;
    peptide: typeof WIKIDATA_PEPTIDE_QUERY;
  };
  selection: { batch_size: number } & Record<
    WikidataSelectionKind,
    WikidataSelectionDigest
  >;
  retrieved_at: string;
  result_file: string;
  sha256: string;
  byte_count: number;
  row_count: number;
};

export type WikidataSnapshot = {
  resultPath: string;
  receiptPath: string;
  result: WikidataResult;
  receipt: WikidataReceipt;
};

export type AcquireWikidataOptions = {
  directory: string;
  retrievedAt: string;
  /** Corpus root whose compound identifiers select the snapshot. */
  corpusRoot?: string;
  /** Explicit selection; overrides `corpusRoot`. */
  selection?: WikidataSelection;
  endpoint?: string;
  batchSize?: number;
  /** Attempts per request before the acquisition fails. */
  attempts?: number;
  /** Base delay between attempts; attempt n waits n times this long. */
  retryDelayMs?: number;
  /** Pause after every answered request, so the public endpoint is not hammered. */
  requestPauseMs?: number;
  fetchImplementation?: typeof fetch;
  onProgress?: (message: string) => void;
};

export class WikidataAcquisitionError extends Error {
  override name = "WikidataAcquisitionError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const byString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new WikidataAcquisitionError(
      `${context} has fields [${actual.join(", ")}], expected [${wanted.join(", ")}].`,
    );
  }
};

export const validateRetrievedAt = (value: string): string => {
  // Require an explicit zone: a zone-less date-time is local-machine dependent.
  const matched = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  const calendarDate =
    matched === null
      ? null
      : new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  if (
    matched === null ||
    calendarDate === null ||
    calendarDate.getUTCFullYear() !== Number(matched[1]) ||
    calendarDate.getUTCMonth() + 1 !== Number(matched[2]) ||
    calendarDate.getUTCDate() !== Number(matched[3]) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new WikidataAcquisitionError(
      `retrieved_at '${value}' is not an ISO 8601 instant with an explicit timezone.`,
    );
  }
  return value;
};

const validateEndpoint = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WikidataAcquisitionError(`Endpoint '${value}' is not an absolute URL.`);
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new WikidataAcquisitionError(`Endpoint '${value}' must use HTTPS.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new WikidataAcquisitionError("The Wikidata endpoint must not contain credentials.");
  }
  return url.toString();
};

const validateBatchSize = (batchSize: number): number => {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new WikidataAcquisitionError("batchSize must be a positive safe integer.");
  }
  return batchSize;
};

const selectionKind = (kind: WikidataSelectionKind) =>
  WIKIDATA_SELECTION_KINDS.find((entry) => entry.kind === kind)!;

/**
 * Sorted, distinct and shape-checked. A value is interpolated into a query as
 * a string literal, so nothing outside its identifier pattern is ever accepted.
 */
export const normalizeWikidataSelection = (
  selection: Partial<WikidataSelection>,
): WikidataSelection => {
  const normalized = {} as WikidataSelection;
  for (const { kind, pattern } of WIKIDATA_SELECTION_KINDS) {
    const values = [...new Set(selection[kind] ?? [])].sort(byString);
    const invalid = values.find((value) => !pattern.test(value));
    if (invalid !== undefined) {
      throw new WikidataAcquisitionError(
        `Selection value '${invalid}' is not a valid ${kind} identifier.`,
      );
    }
    normalized[kind] = values;
  }
  return normalized;
};

/**
 * Reads the selection from the corpus itself: every `unii`, `cas_number` and
 * `pubchem_cid` identifier carried by a `compound` record.
 */
export const readCorpusSelection = (corpusRoot: string): WikidataSelection => {
  const compoundRoot = resolve(corpusRoot, "records", "compound");
  if (!existsSync(compoundRoot)) {
    throw new WikidataAcquisitionError(
      `Corpus root '${corpusRoot}' has no records/compound directory.`,
    );
  }
  const selection: WikidataSelection = { unii: [], cas_number: [], pubchem_cid: [] };
  for (const shard of readdirSync(compoundRoot, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardPath = join(compoundRoot, shard.name);
    for (const file of readdirSync(shardPath, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
      const filePath = join(shardPath, file.name);
      const record = parse(readFileSync(filePath, "utf8")) as unknown;
      if (!isRecord(record) || !Array.isArray(record.identifiers)) continue;
      for (const identifier of record.identifiers) {
        if (!isRecord(identifier)) continue;
        const kind = WIKIDATA_SELECTION_KINDS.find((entry) => entry.kind === identifier.kind);
        if (kind === undefined) continue;
        selection[kind.kind].push(String(identifier.value));
      }
    }
  }
  return normalizeWikidataSelection(selection);
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Count and SHA-256 of the newline-joined sorted values of one identifier kind. */
export const digestWikidataSelection = (values: readonly string[]): WikidataSelectionDigest => ({
  count: values.length,
  sha256: digest(new TextEncoder().encode(values.join("\n"))),
});

export const wikidataBatchQuery = (
  template: typeof WIKIDATA_FACET_QUERY | typeof WIKIDATA_PEPTIDE_QUERY,
  kind: WikidataSelectionKind,
  values: readonly string[],
): string => {
  const { property, pattern } = selectionKind(kind);
  if (values.length === 0) {
    throw new WikidataAcquisitionError("A Wikidata batch needs at least one value.");
  }
  const invalid = values.find((value) => !pattern.test(value));
  if (invalid !== undefined) {
    throw new WikidataAcquisitionError(
      `Selection value '${invalid}' is not a valid ${kind} identifier.`,
    );
  }
  return template
    .replaceAll(PROPERTY_PLACEHOLDER, property)
    .replaceAll(VALUES_PLACEHOLDER, values.map((value) => `"${value}"`).join(" "));
};

const parseTerm = (value: unknown, context: string): WikidataSparqlTerm => {
  if (!isRecord(value)) {
    throw new WikidataAcquisitionError(`${context} is not a SPARQL result term.`);
  }
  const allowed = ["type", "value", "xml:lang", "datatype"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new WikidataAcquisitionError(`${context} has unknown field '${unknown[0]}'.`);
  }
  if (
    !["uri", "literal", "typed-literal", "bnode"].includes(String(value.type)) ||
    typeof value.value !== "string" ||
    value.value === ""
  ) {
    throw new WikidataAcquisitionError(`${context} has an invalid type or empty value.`);
  }
  if (value["xml:lang"] !== undefined && typeof value["xml:lang"] !== "string") {
    throw new WikidataAcquisitionError(`${context} has a non-string xml:lang.`);
  }
  if (value.datatype !== undefined && typeof value.datatype !== "string") {
    throw new WikidataAcquisitionError(`${context} has a non-string datatype.`);
  }
  // Key order is fixed here so identical terms always serialize identically.
  return {
    type: value.type as WikidataSparqlTerm["type"],
    value: value.value,
    ...(value["xml:lang"] === undefined ? {} : { "xml:lang": value["xml:lang"] }),
    ...(value.datatype === undefined ? {} : { datatype: value.datatype }),
  };
};

/**
 * Parses one response or one result file against the variables it must
 * declare. Rows keep only the variables they bind, in the fixed variable order.
 */
export const parseWikidataResult = (
  value: unknown,
  context = "Wikidata response",
  variables: readonly WikidataResultVariable[] = WIKIDATA_RESULT_VARIABLES,
): WikidataResult => {
  if (!isRecord(value)) {
    throw new WikidataAcquisitionError(`${context} is not a JSON object.`);
  }
  exactKeys(value, ["head", "results"], context);
  if (!isRecord(value.head) || !Array.isArray(value.head.vars)) {
    throw new WikidataAcquisitionError(`${context}.head.vars is not an array.`);
  }
  exactKeys(value.head, ["vars"], `${context}.head`);
  if (
    value.head.vars.length !== variables.length ||
    value.head.vars.some((variable, index) => variable !== variables[index])
  ) {
    throw new WikidataAcquisitionError(`${context} declares unexpected result variables.`);
  }
  if (!isRecord(value.results) || !Array.isArray(value.results.bindings)) {
    throw new WikidataAcquisitionError(`${context}.results.bindings is not an array.`);
  }
  exactKeys(value.results, ["bindings"], `${context}.results`);

  const bindings = value.results.bindings.map((candidate, rowIndex) => {
    if (!isRecord(candidate)) {
      throw new WikidataAcquisitionError(`${context} row ${rowIndex} is not an object.`);
    }
    const unknown = Object.keys(candidate).find(
      (key) => !(variables as readonly string[]).includes(key),
    );
    if (unknown !== undefined) {
      throw new WikidataAcquisitionError(
        `${context} row ${rowIndex} has unknown variable '${unknown}'.`,
      );
    }
    const binding: WikidataBinding = {};
    for (const variable of variables) {
      if (candidate[variable] === undefined) continue;
      binding[variable] = parseTerm(
        candidate[variable],
        `${context} row ${rowIndex}.${variable}`,
      );
    }
    const item = binding.item;
    if (item?.type !== "uri" || !/^https?:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(item.value)) {
      throw new WikidataAcquisitionError(`${context} row ${rowIndex} has no valid Wikidata item URI.`);
    }
    if (Object.keys(binding).length < 2) {
      throw new WikidataAcquisitionError(`${context} row ${rowIndex} binds nothing but its item.`);
    }
    const peptide = binding.isPeptide;
    if (
      peptide !== undefined &&
      (peptide.value !== "true" || peptide.datatype !== BOOLEAN_DATATYPE)
    ) {
      throw new WikidataAcquisitionError(
        `${context} row ${rowIndex} has an invalid peptide-membership term.`,
      );
    }
    return binding;
  });

  return {
    head: { vars: [...variables] },
    results: { bindings },
  };
};

const bindingSortKey = (binding: WikidataBinding): string =>
  WIKIDATA_RESULT_VARIABLES.map((variable) => {
    const term = binding[variable];
    return term
      ? `${term.value}\u0001${term.type}\u0001${term["xml:lang"] ?? ""}\u0001${term.datatype ?? ""}`
      : "";
  }).join("\u0000");

/**
 * One canonical result from any number of responses: an item selected by two
 * of its identifiers arrives twice, so rows are de-duplicated, then sorted.
 */
export const assembleWikidataResult = (
  pages: readonly WikidataResult[],
): WikidataResult => {
  const rows = new Map<string, WikidataBinding>();
  for (const page of pages) {
    for (const binding of page.results.bindings) {
      rows.set(bindingSortKey(binding), binding);
    }
  }
  return {
    head: { vars: [...WIKIDATA_RESULT_VARIABLES] },
    results: {
      bindings: [...rows.entries()]
        .sort(([left], [right]) => byString(left, right))
        .map(([, binding]) => binding),
    },
  };
};

export const serializeWikidataJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const selectionDigestFromUnknown = (
  value: unknown,
  kind: string,
): WikidataSelectionDigest => {
  if (!isRecord(value)) {
    throw new WikidataAcquisitionError(`The receipt selection for ${kind} is not an object.`);
  }
  exactKeys(value, ["count", "sha256"], `The receipt selection for ${kind}`);
  if (
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new WikidataAcquisitionError(`The receipt selection for ${kind} is invalid.`);
  }
  return { count: value.count as number, sha256: value.sha256 };
};

const receiptFromUnknown = (value: unknown): WikidataReceipt => {
  if (!isRecord(value)) {
    throw new WikidataAcquisitionError("The Wikidata receipt is not a JSON object.");
  }
  exactKeys(value, RECEIPT_KEYS, "The Wikidata receipt");
  if (!isRecord(value.queries) || !isRecord(value.selection)) {
    throw new WikidataAcquisitionError("The Wikidata receipt has invalid field values.");
  }
  exactKeys(value.queries, ["facets", "peptide"], "The Wikidata receipt queries");
  exactKeys(
    value.selection,
    ["batch_size", ...WIKIDATA_SELECTION_KINDS.map(({ kind }) => kind)],
    "The Wikidata receipt selection",
  );
  if (
    value.contract !== WIKIDATA_ACQUISITION_CONTRACT ||
    typeof value.endpoint !== "string" ||
    value.queries.facets !== WIKIDATA_FACET_QUERY ||
    value.queries.peptide !== WIKIDATA_PEPTIDE_QUERY ||
    !Number.isSafeInteger(value.selection.batch_size) ||
    (value.selection.batch_size as number) < 1 ||
    typeof value.retrieved_at !== "string" ||
    typeof value.result_file !== "string" ||
    !/^wikidata-\d{4}-\d{2}-\d{2}\.json$/.test(value.result_file) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.byte_count) ||
    (value.byte_count as number) < 1 ||
    !Number.isSafeInteger(value.row_count) ||
    (value.row_count as number) < 1
  ) {
    throw new WikidataAcquisitionError("The Wikidata receipt has invalid field values.");
  }
  for (const { kind } of WIKIDATA_SELECTION_KINDS) {
    selectionDigestFromUnknown(value.selection[kind], kind);
  }
  validateEndpoint(value.endpoint);
  validateRetrievedAt(value.retrieved_at);
  const receiptDate = new Date(value.retrieved_at).toISOString().slice(0, 10);
  if (value.result_file !== `wikidata-${receiptDate}.json`) {
    throw new WikidataAcquisitionError(
      `The receipt result filename does not match its retrieved_at date ${receiptDate}.`,
    );
  }
  return value as WikidataReceipt;
};

/** Verifies the receipt before parsing or returning any result rows. */
export const verifyWikidataReceipt = (
  resultBytes: Uint8Array,
  receiptValue: unknown,
): { receipt: WikidataReceipt; result: WikidataResult } => {
  const receipt = receiptFromUnknown(receiptValue);
  if (resultBytes.byteLength !== receipt.byte_count) {
    throw new WikidataAcquisitionError(
      `The result is ${resultBytes.byteLength} bytes but the receipt records ${receipt.byte_count}.`,
    );
  }
  const observedDigest = digest(resultBytes);
  if (observedDigest !== receipt.sha256) {
    throw new WikidataAcquisitionError(
      `The result SHA-256 is ${observedDigest} but the receipt records ${receipt.sha256}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resultBytes)) as unknown;
  } catch (error) {
    throw new WikidataAcquisitionError(
      `The verified Wikidata result is not valid UTF-8 JSON: ${(error as Error).message}.`,
    );
  }
  const result = parseWikidataResult(parsed, "Wikidata result file");
  if (result.results.bindings.length !== receipt.row_count) {
    throw new WikidataAcquisitionError(
      `The result has ${result.results.bindings.length} rows but the receipt records ${receipt.row_count}.`,
    );
  }
  return { receipt, result };
};

export const readVerifiedWikidataSnapshot = (
  directory: string,
  date: string,
): WikidataSnapshot => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new WikidataAcquisitionError(`Snapshot date '${date}' is not YYYY-MM-DD.`);
  }
  const resultPath = resolve(directory, `wikidata-${date}.json`);
  const receiptPath = resolve(directory, `wikidata-${date}.receipt.json`);
  const resultBytes = readFileSync(resultPath);
  let receiptValue: unknown;
  try {
    receiptValue = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
  } catch (error) {
    throw new WikidataAcquisitionError(
      `The Wikidata receipt is not valid JSON: ${(error as Error).message}.`,
    );
  }
  const verified = verifyWikidataReceipt(resultBytes, receiptValue);
  if (verified.receipt.result_file !== `wikidata-${date}.json`) {
    throw new WikidataAcquisitionError(
      `The receipt names '${verified.receipt.result_file}', not wikidata-${date}.json.`,
    );
  }
  return { resultPath, receiptPath, ...verified };
};

const sleep = (milliseconds: number): Promise<void> =>
  milliseconds > 0
    ? new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
    : Promise.resolve();

type RequestOptions = {
  endpoint: string;
  attempts: number;
  retryDelayMs: number;
  fetchImplementation: typeof fetch;
  onProgress: (message: string) => void;
};

/**
 * One POSTed query, retried on the endpoint's transient answers. A bounded
 * retry is what lets a few hundred requests finish as one snapshot.
 */
const requestWikidata = async (
  query: string,
  label: string,
  variables: readonly WikidataResultVariable[],
  { endpoint, attempts, retryDelayMs, fetchImplementation, onProgress }: RequestOptions,
): Promise<WikidataResult> => {
  let failure = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryAfterMs = 0;
    try {
      const response = await fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          accept: "application/sparql-results+json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "manasource-source-wikidata-acquisition/2.0",
        },
        body: new URLSearchParams({ query, format: "json" }).toString(),
        redirect: "error",
      });
      if (response.status === 200) {
        let value: unknown;
        try {
          value = (await response.json()) as unknown;
        } catch (error) {
          // A dropped stream is transient; a complete non-JSON body is not expected either way.
          failure = `returned an unreadable body: ${(error as Error).message}`;
          value = undefined;
        }
        if (value !== undefined) {
          return parseWikidataResult(value, `Wikidata response for ${label}`, variables);
        }
      } else if (RETRYABLE_STATUS.has(response.status)) {
        failure = `answered HTTP ${response.status}`;
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          retryAfterMs = Math.min(retryAfter, 120) * 1000;
        }
      } else {
        throw new WikidataAcquisitionError(
          `${endpoint} answered HTTP ${response.status} for ${label}.`,
        );
      }
    } catch (error) {
      if (error instanceof WikidataAcquisitionError) throw error;
      failure = `could not be reached: ${(error as Error).message}`;
    }
    if (attempt < attempts) {
      onProgress(`${label}: ${failure}; retrying (${attempt}/${attempts})`);
      await sleep(Math.max(retryAfterMs, retryDelayMs * attempt));
    }
  }
  throw new WikidataAcquisitionError(
    `${endpoint} ${failure} for ${label} after ${attempts} attempts.`,
  );
};

export const acquireWikidataSnapshot = async ({
  directory,
  retrievedAt,
  corpusRoot,
  selection: explicitSelection,
  endpoint = WIKIDATA_SPARQL_ENDPOINT,
  batchSize = 500,
  attempts = 5,
  retryDelayMs = 5_000,
  requestPauseMs = 250,
  fetchImplementation = fetch,
  onProgress = () => {},
}: AcquireWikidataOptions): Promise<WikidataSnapshot> => {
  validateRetrievedAt(retrievedAt);
  const normalizedEndpoint = validateEndpoint(endpoint);
  validateBatchSize(batchSize);
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new WikidataAcquisitionError("attempts must be a positive safe integer.");
  }
  if (explicitSelection === undefined && corpusRoot === undefined) {
    throw new WikidataAcquisitionError("A corpus root or an explicit selection is required.");
  }
  const selection =
    explicitSelection === undefined
      ? readCorpusSelection(corpusRoot!)
      : normalizeWikidataSelection(explicitSelection);
  if (WIKIDATA_SELECTION_KINDS.every(({ kind }) => selection[kind].length === 0)) {
    throw new WikidataAcquisitionError("The selection has no identifiers; nothing to acquire.");
  }

  const date = new Date(retrievedAt).toISOString().slice(0, 10);
  const resultFile = `wikidata-${date}.json`;
  const receiptFile = `wikidata-${date}.receipt.json`;
  const root = resolve(directory);
  const resultPath = resolve(root, resultFile);
  const receiptPath = resolve(root, receiptFile);
  // Refuse before the first request: a snapshot is never overwritten.
  if (existsSync(resultPath) || existsSync(receiptPath)) {
    throw new WikidataAcquisitionError(
      `Snapshot '${date}' already exists in ${root}; refusing to overwrite it.`,
    );
  }

  const request: RequestOptions = {
    endpoint: normalizedEndpoint,
    attempts,
    retryDelayMs,
    fetchImplementation,
    onProgress,
  };
  const pages: WikidataResult[] = [];
  for (const { kind } of WIKIDATA_SELECTION_KINDS) {
    const values = selection[kind];
    for (let offset = 0; offset < values.length; offset += batchSize) {
      const batch = values.slice(offset, offset + batchSize);
      const label = `${kind} ${offset}-${offset + batch.length - 1}`;
      const facets = await requestWikidata(
        wikidataBatchQuery(WIKIDATA_FACET_QUERY, kind, batch),
        `${label} facets`,
        WIKIDATA_FACET_VARIABLES,
        request,
      );
      await sleep(requestPauseMs);
      const peptide = await requestWikidata(
        wikidataBatchQuery(WIKIDATA_PEPTIDE_QUERY, kind, batch),
        `${label} peptide`,
        WIKIDATA_PEPTIDE_VARIABLES,
        request,
      );
      await sleep(requestPauseMs);
      pages.push(facets, peptide);
      onProgress(
        `${label}: ${facets.results.bindings.length} facet rows, ${peptide.results.bindings.length} peptide rows`,
      );
    }
  }

  const result = assembleWikidataResult(pages);
  if (result.results.bindings.length === 0) {
    throw new WikidataAcquisitionError("Wikidata returned no rows; the snapshot is refused.");
  }
  const resultBytes = serializeWikidataJson(result);
  const receipt: WikidataReceipt = {
    contract: WIKIDATA_ACQUISITION_CONTRACT,
    endpoint: normalizedEndpoint,
    queries: { facets: WIKIDATA_FACET_QUERY, peptide: WIKIDATA_PEPTIDE_QUERY },
    selection: {
      batch_size: batchSize,
      unii: digestWikidataSelection(selection.unii),
      cas_number: digestWikidataSelection(selection.cas_number),
      pubchem_cid: digestWikidataSelection(selection.pubchem_cid),
    },
    retrieved_at: retrievedAt,
    result_file: resultFile,
    sha256: digest(resultBytes),
    byte_count: resultBytes.byteLength,
    row_count: result.results.bindings.length,
  };
  const receiptBytes = serializeWikidataJson(receipt);

  mkdirSync(root, { recursive: true });
  let resultWritten = false;
  let receiptWritten = false;
  try {
    writeFileSync(resultPath, resultBytes, { flag: "wx" });
    resultWritten = true;
    writeFileSync(receiptPath, receiptBytes, { flag: "wx" });
    receiptWritten = true;
  } catch (error) {
    if (resultWritten) rmSync(resultPath, { force: true });
    if (receiptWritten) rmSync(receiptPath, { force: true });
    throw new WikidataAcquisitionError(
      `Could not write the Wikidata snapshot without overwriting files: ${(error as Error).message}`,
    );
  }
  onProgress(
    `wrote ${result.results.bindings.length} rows, ${resultBytes.byteLength} bytes, sha256 ${receipt.sha256}`,
  );
  return { resultPath, receiptPath, result, receipt };
};
