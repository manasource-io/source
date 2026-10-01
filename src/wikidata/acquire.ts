import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const WIKIDATA_SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";
export const WIKIDATA_ACQUISITION_CONTRACT = "manasource.wikidata-sparql.v1";
export const WIKIDATA_RESULT_VARIABLES = [
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
  "isChemicalEntity",
] as const;

/**
 * Fixed corpus query. Paging clauses are appended by `wikidataPageQuery`; the
 * selection and ordering are deliberately not caller-configurable.
 */
export const WIKIDATA_QUERY = `SELECT DISTINCT ?item ?itemLabel ?alias ?unii ?cas ?pubchemCid ?role ?roleLabel ?atc ?class ?classLabel ?isChemicalEntity WHERE {
  {
    ?item wdt:P652 ?selectedIdentifier .
  } UNION {
    ?item wdt:P231 ?selectedIdentifier .
  } UNION {
    ?item wdt:P662 ?selectedIdentifier .
  }
  OPTIONAL { ?item wdt:P652 ?unii . }
  OPTIONAL { ?item wdt:P231 ?cas . }
  OPTIONAL { ?item wdt:P662 ?pubchemCid . }
  OPTIONAL {
    ?item wdt:P2868 ?role .
    OPTIONAL { ?role rdfs:label ?roleLabel . FILTER(LANG(?roleLabel) = "en") }
  }
  OPTIONAL { ?item wdt:P267 ?atc . }
  OPTIONAL {
    ?item wdt:P31 ?class .
    OPTIONAL { ?class rdfs:label ?classLabel . FILTER(LANG(?classLabel) = "en") }
  }
  OPTIONAL { ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en") }
  OPTIONAL { ?item skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q172847 . } AS ?isChemicalEntity)
}
ORDER BY ?item ?itemLabel ?alias ?unii ?cas ?pubchemCid ?role ?roleLabel ?atc ?class ?classLabel ?isChemicalEntity`;

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

export type WikidataReceipt = {
  contract: typeof WIKIDATA_ACQUISITION_CONTRACT;
  endpoint: string;
  query: typeof WIKIDATA_QUERY;
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
  endpoint?: string;
  pageSize?: number;
  fetchImplementation?: typeof fetch;
  onProgress?: (message: string) => void;
};

export class WikidataAcquisitionError extends Error {
  override name = "WikidataAcquisitionError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

export const wikidataPageQuery = (pageSize: number, offset: number): string => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new WikidataAcquisitionError("pageSize must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % pageSize !== 0) {
    throw new WikidataAcquisitionError(
      "offset must be a non-negative safe integer aligned to pageSize.",
    );
  }
  return `${WIKIDATA_QUERY}\nLIMIT ${pageSize}\nOFFSET ${offset}`;
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
  return {
    type: value.type as WikidataSparqlTerm["type"],
    value: value.value,
    ...(value["xml:lang"] === undefined ? {} : { "xml:lang": value["xml:lang"] }),
    ...(value.datatype === undefined ? {} : { datatype: value.datatype }),
  };
};

export const parseWikidataResult = (value: unknown, context = "Wikidata response"): WikidataResult => {
  if (!isRecord(value)) {
    throw new WikidataAcquisitionError(`${context} is not a JSON object.`);
  }
  exactKeys(value, ["head", "results"], context);
  if (!isRecord(value.head) || !Array.isArray(value.head.vars)) {
    throw new WikidataAcquisitionError(`${context}.head.vars is not an array.`);
  }
  exactKeys(value.head, ["vars"], `${context}.head`);
  if (
    value.head.vars.length !== WIKIDATA_RESULT_VARIABLES.length ||
    value.head.vars.some((variable, index) => variable !== WIKIDATA_RESULT_VARIABLES[index])
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
    const binding: WikidataBinding = {};
    for (const [key, term] of Object.entries(candidate)) {
      if (!(WIKIDATA_RESULT_VARIABLES as readonly string[]).includes(key)) {
        throw new WikidataAcquisitionError(`${context} row ${rowIndex} has unknown variable '${key}'.`);
      }
      binding[key as WikidataResultVariable] = parseTerm(
        term,
        `${context} row ${rowIndex}.${key}`,
      );
    }
    const item = binding.item;
    if (item?.type !== "uri" || !/^https?:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(item.value)) {
      throw new WikidataAcquisitionError(`${context} row ${rowIndex} has no valid Wikidata item URI.`);
    }
    if (!binding.unii && !binding.cas && !binding.pubchemCid) {
      throw new WikidataAcquisitionError(`${context} row ${rowIndex} has none of P652, P231, or P662.`);
    }
    return binding;
  });

  return {
    head: { vars: [...WIKIDATA_RESULT_VARIABLES] },
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

export const assembleWikidataResult = (
  pages: readonly WikidataResult[],
): WikidataResult => {
  const bindings = pages
    .flatMap((page) => page.results.bindings)
    .sort((left, right) => {
      const leftKey = bindingSortKey(left);
      const rightKey = bindingSortKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return {
    head: { vars: [...WIKIDATA_RESULT_VARIABLES] },
    results: { bindings },
  };
};

export const serializeWikidataJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const receiptFromUnknown = (value: unknown): WikidataReceipt => {
  if (!isRecord(value)) {
    throw new WikidataAcquisitionError("The Wikidata receipt is not a JSON object.");
  }
  exactKeys(
    value,
    [
      "contract",
      "endpoint",
      "query",
      "retrieved_at",
      "result_file",
      "sha256",
      "byte_count",
      "row_count",
    ],
    "The Wikidata receipt",
  );
  if (
    value.contract !== WIKIDATA_ACQUISITION_CONTRACT ||
    typeof value.endpoint !== "string" ||
    value.query !== WIKIDATA_QUERY ||
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

export const acquireWikidataSnapshot = async ({
  directory,
  retrievedAt,
  endpoint = WIKIDATA_SPARQL_ENDPOINT,
  pageSize = 10_000,
  fetchImplementation = fetch,
  onProgress = () => {},
}: AcquireWikidataOptions): Promise<WikidataSnapshot> => {
  validateRetrievedAt(retrievedAt);
  const normalizedEndpoint = validateEndpoint(endpoint);
  // Validate pageSize before making any request.
  wikidataPageQuery(pageSize, 0);

  const pages: WikidataResult[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const query = wikidataPageQuery(pageSize, offset);
    const requestUrl = new URL(normalizedEndpoint);
    requestUrl.searchParams.set("query", query);
    requestUrl.searchParams.set("format", "json");
    onProgress(`fetching offset ${offset}`);
    const response = await fetchImplementation(requestUrl, {
      headers: {
        accept: "application/sparql-results+json",
        "user-agent": "manasource-source-wikidata-acquisition/1.0",
      },
      redirect: "error",
    });
    if (response.status !== 200) {
      throw new WikidataAcquisitionError(
        `${normalizedEndpoint} answered HTTP ${response.status} for offset ${offset}.`,
      );
    }
    let value: unknown;
    try {
      value = (await response.json()) as unknown;
    } catch (error) {
      throw new WikidataAcquisitionError(
        `The Wikidata response at offset ${offset} is not valid JSON: ${(error as Error).message}.`,
      );
    }
    const page = parseWikidataResult(value, `Wikidata response at offset ${offset}`);
    if (page.results.bindings.length > pageSize) {
      throw new WikidataAcquisitionError(
        `Wikidata returned ${page.results.bindings.length} rows for page size ${pageSize}.`,
      );
    }
    pages.push(page);
    onProgress(`offset ${offset}: ${page.results.bindings.length} rows`);
    if (page.results.bindings.length < pageSize) break;
    if (offset > Number.MAX_SAFE_INTEGER - pageSize) {
      throw new WikidataAcquisitionError("Wikidata pagination exceeded safe integer offsets.");
    }
  }

  const result = assembleWikidataResult(pages);
  if (result.results.bindings.length === 0) {
    throw new WikidataAcquisitionError("Wikidata returned no rows; the snapshot is refused.");
  }
  const resultBytes = serializeWikidataJson(result);
  const date = new Date(retrievedAt).toISOString().slice(0, 10);
  const resultFile = `wikidata-${date}.json`;
  const receiptFile = `wikidata-${date}.receipt.json`;
  const receipt: WikidataReceipt = {
    contract: WIKIDATA_ACQUISITION_CONTRACT,
    endpoint: normalizedEndpoint,
    query: WIKIDATA_QUERY,
    retrieved_at: retrievedAt,
    result_file: resultFile,
    sha256: digest(resultBytes),
    byte_count: resultBytes.byteLength,
    row_count: result.results.bindings.length,
  };
  const receiptBytes = serializeWikidataJson(receipt);
  const root = resolve(directory);
  const resultPath = resolve(root, resultFile);
  const receiptPath = resolve(root, receiptFile);
  if (existsSync(resultPath) || existsSync(receiptPath)) {
    throw new WikidataAcquisitionError(
      `Snapshot '${date}' already exists in ${root}; refusing to overwrite it.`,
    );
  }

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
