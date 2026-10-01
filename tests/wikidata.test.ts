import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WIKIDATA_FACET_QUERY,
  WIKIDATA_FACET_VARIABLES,
  WIKIDATA_PEPTIDE_QUERY,
  WIKIDATA_PEPTIDE_VARIABLES,
  WIKIDATA_RESULT_VARIABLES,
  WikidataAcquisitionError,
  acquireWikidataSnapshot,
  assembleWikidataResult,
  digestWikidataSelection,
  normalizeWikidataSelection,
  readCorpusSelection,
  readVerifiedWikidataSnapshot,
  serializeWikidataJson,
  verifyWikidataReceipt,
  wikidataBatchQuery,
} from "../src/wikidata/acquire.ts";
import type {
  WikidataBinding,
  WikidataResult,
  WikidataResultVariable,
  WikidataSelection,
  WikidataSparqlTerm,
} from "../src/wikidata/acquire.ts";

const temporaryRoots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "wikidata-acquire-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const literal = (value: string): WikidataSparqlTerm => ({ type: "literal", value });
const item = (qid: string): WikidataSparqlTerm => ({
  type: "uri",
  value: `http://www.wikidata.org/entity/${qid}`,
});
const uniiRow = (qid: string, unii: string): WikidataBinding => ({
  item: item(qid),
  unii: literal(unii),
});
const labelRow = (qid: string, label: string): WikidataBinding => ({
  item: item(qid),
  itemLabel: { type: "literal", value: label, "xml:lang": "en" },
});
const peptideRow = (qid: string): WikidataBinding => ({
  item: item(qid),
  isPeptide: {
    type: "literal",
    value: "true",
    datatype: "http://www.w3.org/2001/XMLSchema#boolean",
  },
});

function page(
  bindings: WikidataBinding[],
  variables: readonly WikidataResultVariable[] = WIKIDATA_FACET_VARIABLES,
): WikidataResult {
  return { head: { vars: [...variables] }, results: { bindings } };
}

type SentRequest = { query: string; method: string | undefined };

/** Answers each request from the identifiers its query names. */
function fetchBySelection(
  answer: (values: string[], peptide: boolean) => WikidataBinding[],
  requests: SentRequest[] = [],
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const query = new URLSearchParams(String(init?.body)).get("query") ?? "";
    requests.push({ query, method: init?.method });
    const values = [.../VALUES \?selected \{ ([^}]*) \}/.exec(query)![1]!.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    const peptide = query.startsWith("SELECT DISTINCT ?item ?isPeptide");
    return Response.json(
      page(answer(values, peptide), peptide ? WIKIDATA_PEPTIDE_VARIABLES : WIKIDATA_FACET_VARIABLES),
    );
  }) as typeof fetch;
}

const selection: WikidataSelection = {
  unii: ["UNII000003", "UNII000001", "UNII000002"],
  cas_number: ["50-00-0"],
  pubchem_cid: [],
};

const answerAll = (values: string[], peptide: boolean): WikidataBinding[] =>
  peptide
    ? values.includes("UNII000002")
      ? [peptideRow("Q2")]
      : []
    : values.flatMap((value) =>
        value.startsWith("UNII")
          ? [uniiRow(`Q${Number(value.slice(4))}`, value), labelRow(`Q${Number(value.slice(4))}`, value)]
          : // The CAS selects an item its UNII already selected: the same row arrives twice.
            [uniiRow("Q1", "UNII000001")],
      );

const acquired = async (
  directory: string,
  retrievedAt = "2026-10-01T00:00:00.000Z",
  requests: SentRequest[] = [],
) =>
  acquireWikidataSnapshot({
    directory,
    retrievedAt,
    selection,
    batchSize: 2,
    retryDelayMs: 0,
    requestPauseMs: 0,
    fetchImplementation: fetchBySelection(answerAll, requests),
  });

describe("Wikidata queries and selection", () => {
  test("pins one facet arm per property and the peptide path on its own", () => {
    for (const property of ["P652", "P231", "P662", "P2868", "P267", "P31"]) {
      expect(WIKIDATA_FACET_QUERY).toContain(`?item wdt:${property} `);
    }
    expect(WIKIDATA_FACET_QUERY).toContain("rdfs:label ?itemLabel");
    expect(WIKIDATA_FACET_QUERY).toContain("skos:altLabel ?alias");
    expect(WIKIDATA_FACET_QUERY).not.toContain("P279");
    // Every arm binds ?item from the selection itself.
    expect(WIKIDATA_FACET_QUERY.match(/VALUES \?selected \{ \{\{VALUES\}\} \}/g)).toHaveLength(8);
    expect(WIKIDATA_PEPTIDE_QUERY).toContain("?peptideClass wdt:P279* wd:Q172847 .");
    expect(WIKIDATA_PEPTIDE_QUERY).toContain('hint:Prior hint:gearing "forward" .');
  });

  test("fills a batch into both templates and refuses unsafe values", () => {
    const query = wikidataBatchQuery(WIKIDATA_FACET_QUERY, "cas_number", ["50-00-0", "64-17-5"]);
    expect(query).not.toContain("{{");
    expect(query).toContain('VALUES ?selected { "50-00-0" "64-17-5" } ?item wdt:P231 ?selected .');
    expect(wikidataBatchQuery(WIKIDATA_PEPTIDE_QUERY, "unii", ["UNII000001"])).toContain(
      'VALUES ?selected { "UNII000001" } ?item wdt:P652 ?selected .',
    );
    expect(() => wikidataBatchQuery(WIKIDATA_FACET_QUERY, "unii", ['A" } ?x ?y ?z . #'])).toThrow(
      /not a valid unii/,
    );
    expect(() => wikidataBatchQuery(WIKIDATA_FACET_QUERY, "unii", [])).toThrow(/at least one/);
    expect(() => normalizeWikidataSelection({ pubchem_cid: ["0123"] })).toThrow(
      /not a valid pubchem_cid/,
    );
  });

  test("reads sorted distinct compound identifiers from a corpus root", () => {
    const root = temporary();
    const write = (shard: string, id: string, identifiers: string): void => {
      mkdirSync(join(root, "records", "compound", shard), { recursive: true });
      writeFileSync(
        join(root, "records", "compound", shard, `${id}.yaml`),
        `id: ${id}\nidentifiers:\n${identifiers}`,
      );
    };
    write("BB", "CPBB0001", "  - kind: unii\n    value: UNII00000B\n  - kind: rxcui\n    value: \"161\"\n");
    write(
      "AA",
      "CPAA0001",
      "  - kind: cas_number\n    value: 50-00-0\n  - kind: pubchem_cid\n    value: \"712\"\n  - kind: unii\n    value: UNII00000A\n",
    );
    mkdirSync(join(root, "records", "food", "AA"), { recursive: true });
    writeFileSync(
      join(root, "records", "food", "AA", "FDAA0001.yaml"),
      "id: FDAA0001\nidentifiers:\n  - kind: unii\n    value: UNII00000F\n",
    );
    expect(readCorpusSelection(root)).toEqual({
      unii: ["UNII00000A", "UNII00000B"],
      cas_number: ["50-00-0"],
      pubchem_cid: ["712"],
    });
    expect(() => readCorpusSelection(temporary())).toThrow(/no records\/compound/);
  });
});

describe("Wikidata acquisition", () => {
  test("requests both queries per sorted batch, in join-key order, by POST", async () => {
    const requests: SentRequest[] = [];
    await acquired(temporary(), "2026-10-01T00:00:00Z", requests);
    expect(requests.every(({ method }) => method === "POST")).toBe(true);
    expect(requests.map(({ query }) => query)).toEqual([
      wikidataBatchQuery(WIKIDATA_FACET_QUERY, "unii", ["UNII000001", "UNII000002"]),
      wikidataBatchQuery(WIKIDATA_PEPTIDE_QUERY, "unii", ["UNII000001", "UNII000002"]),
      wikidataBatchQuery(WIKIDATA_FACET_QUERY, "unii", ["UNII000003"]),
      wikidataBatchQuery(WIKIDATA_PEPTIDE_QUERY, "unii", ["UNII000003"]),
      wikidataBatchQuery(WIKIDATA_FACET_QUERY, "cas_number", ["50-00-0"]),
      wikidataBatchQuery(WIKIDATA_PEPTIDE_QUERY, "cas_number", ["50-00-0"]),
    ]);
  });

  test("de-duplicates rows selected twice and sorts the rest canonically", async () => {
    const snapshot = await acquired(temporary());
    const rows = snapshot.result.results.bindings;
    expect(snapshot.result.head.vars).toEqual([...WIKIDATA_RESULT_VARIABLES]);
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.unii?.value === "UNII000001")).toHaveLength(1);
    expect(rows.map((row) => row.item?.value.split("/").at(-1))).toEqual([
      "Q1",
      "Q1",
      "Q2",
      "Q2",
      "Q2",
      "Q3",
      "Q3",
    ]);
    expect(rows.filter((row) => row.isPeptide !== undefined)).toEqual([peptideRow("Q2")]);
    expect(
      assembleWikidataResult([
        page([uniiRow("Q9", "UNII000009"), uniiRow("Q2", "UNII000002")]),
        page([uniiRow("Q2", "UNII000002"), uniiRow("Q1", "UNII000001")]),
      ]).results.bindings.map((row) => row.unii?.value),
    ).toEqual(["UNII000001", "UNII000002", "UNII000009"]);
  });

  test("records the templates and the selection digests in the receipt", async () => {
    const { receipt } = await acquired(temporary());
    expect(receipt.contract).toBe("manasource.wikidata-sparql.v2");
    expect(receipt.queries).toEqual({
      facets: WIKIDATA_FACET_QUERY,
      peptide: WIKIDATA_PEPTIDE_QUERY,
    });
    expect(receipt.selection).toEqual({
      batch_size: 2,
      unii: {
        count: 3,
        sha256: createHash("sha256").update("UNII000001\nUNII000002\nUNII000003").digest("hex"),
      },
      cas_number: digestWikidataSelection(["50-00-0"]),
      pubchem_cid: { count: 0, sha256: createHash("sha256").update("").digest("hex") },
    });
    expect(receipt.row_count).toBe(7);
  });

  test("retries transient answers and gives up after the configured attempts", async () => {
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 504 });
      if (calls === 2) throw new Error("socket closed");
      return fetchBySelection(answerAll)(input, init);
    }) as typeof fetch;
    const snapshot = await acquireWikidataSnapshot({
      directory: temporary(),
      retrievedAt: "2026-10-01T00:00:00Z",
      selection: { unii: ["UNII000001"], cas_number: [], pubchem_cid: [] },
      retryDelayMs: 0,
      requestPauseMs: 0,
      fetchImplementation: flaky,
    });
    expect(calls).toBe(4);
    expect(snapshot.receipt.row_count).toBe(2);

    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01T00:00:00Z",
        selection: { unii: ["UNII000001"], cas_number: [], pubchem_cid: [] },
        attempts: 2,
        retryDelayMs: 0,
        requestPauseMs: 0,
        fetchImplementation: down,
      }),
    ).rejects.toThrow(/HTTP 503 .* after 2 attempts/);

    const refused = (async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01T00:00:00Z",
        selection: { unii: ["UNII000001"], cas_number: [], pubchem_cid: [] },
        retryDelayMs: 0,
        requestPauseMs: 0,
        fetchImplementation: refused,
      }),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("Wikidata snapshot determinism and verification", () => {
  test("identical endpoint state and retrieval time produce byte-identical files", async () => {
    const left = await acquired(temporary());
    const right = await acquired(temporary());
    expect(readFileSync(left.resultPath)).toEqual(readFileSync(right.resultPath));
    expect(readFileSync(left.receiptPath)).toEqual(readFileSync(right.receiptPath));
  });

  test("changing only retrieved_at leaves result bytes unchanged", async () => {
    const left = await acquired(temporary(), "2026-10-01T01:00:00.000Z");
    const right = await acquired(temporary(), "2026-10-01T02:00:00.000Z");
    expect(readFileSync(left.resultPath)).toEqual(readFileSync(right.resultPath));
    const leftReceipt = JSON.parse(readFileSync(left.receiptPath, "utf8"));
    const rightReceipt = JSON.parse(readFileSync(right.receiptPath, "utf8"));
    expect({ ...leftReceipt, retrieved_at: rightReceipt.retrieved_at }).toEqual(rightReceipt);
  });

  test("refuses overwrite before any request and verifies hashes before result parsing", async () => {
    const root = temporary();
    const snapshot = await acquired(root);
    const requests: SentRequest[] = [];
    await expect(acquired(root, "2026-10-01T00:00:00.000Z", requests)).rejects.toThrow(
      /refusing to overwrite/,
    );
    expect(requests).toEqual([]);

    const receipt = JSON.parse(readFileSync(snapshot.receiptPath, "utf8"));
    const changed = new Uint8Array(readFileSync(snapshot.resultPath));
    changed[0] = 0x5b;
    expect(() => verifyWikidataReceipt(changed, receipt)).toThrow(/SHA-256/);
    expect(() =>
      verifyWikidataReceipt(readFileSync(snapshot.resultPath), {
        ...receipt,
        queries: { ...receipt.queries, facets: "SELECT ?item WHERE {}" },
      }),
    ).toThrow(/invalid field values/);
  });

  test("invalid timestamps, empty selections and malformed responses fail closed", async () => {
    const empty = fetchBySelection(() => []);
    for (const retrievedAt of ["2026-10-01 12:00:00", "2026-02-30T12:00:00Z"]) {
      await expect(
        acquireWikidataSnapshot({
          directory: temporary(),
          retrievedAt,
          selection,
          fetchImplementation: empty,
        }),
      ).rejects.toThrow(/ISO 8601 instant/);
    }
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01T00:00:00Z",
        selection: { unii: [], cas_number: [], pubchem_cid: [] },
        fetchImplementation: empty,
      }),
    ).rejects.toThrow(/no identifiers/);
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01T00:00:00Z",
        selection,
        retryDelayMs: 0,
        requestPauseMs: 0,
        fetchImplementation: empty,
      }),
    ).rejects.toThrow(/no rows/);

    const malformedFetch = (async () =>
      Response.json({ head: { vars: ["item"] }, results: { bindings: [] } })) as unknown as typeof fetch;
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01T00:00:00Z",
        selection,
        retryDelayMs: 0,
        requestPauseMs: 0,
        fetchImplementation: malformedFetch,
      }),
    ).rejects.toThrow(/unexpected result variables/);
  });

  test("result serialization is deterministic JSON with a final newline", () => {
    const result = page([uniiRow("Q1", "UNII000001")], WIKIDATA_RESULT_VARIABLES);
    const text = new TextDecoder().decode(serializeWikidataJson(result));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });
});

describe("committed Wikidata fixture", () => {
  const root = resolve(import.meta.dir, "fixtures", "wikidata", "2026-10-01");
  const qid = (row: WikidataBinding): string => row.item!.value.split("/").at(-1)!;

  test("pins the exact result digest, byte count, and receipt", () => {
    const bytes = readFileSync(resolve(root, "wikidata-2026-10-01.json"));
    expect(bytes.byteLength).toBe(10755);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "ca433202a921f6c7bf9098196f4ece7f3aac70320e87853390a4160c198cba4a",
    );
    const snapshot = readVerifiedWikidataSnapshot(root, "2026-10-01");
    expect(snapshot.receipt.byte_count).toBe(10755);
    expect(snapshot.receipt.row_count).toBe(38);
    expect(snapshot.receipt.selection.unii.count).toBe(5);
    expect(snapshot.receipt.selection.cas_number.count).toBe(3);
  });

  test("is already in canonical assembled form", () => {
    const { result } = readVerifiedWikidataSnapshot(root, "2026-10-01");
    expect(assembleWikidataResult([result])).toEqual(result);
  });

  test("has at most 20 items and all required edge cases", () => {
    const rows = readVerifiedWikidataSnapshot(root, "2026-10-01").result.results.bindings;
    expect(new Set(rows.map(qid)).size).toBeLessThanOrEqual(20);
    const of = (id: string): WikidataBinding[] => rows.filter((row) => qid(row) === id);

    // Noopept: a nootropic role, joinable by UNII, and not a peptide member.
    expect(of("Q7049784").some((row) => row.role?.value.endsWith("/Q742487"))).toBe(true);
    expect(of("Q7049784").some((row) => row.unii?.value === "4QBJ98683M")).toBe(true);
    expect(of("Q7049784").some((row) => row.isPeptide !== undefined)).toBe(false);

    // Semax: no UNII on the item, so it is reachable by CAS number alone.
    expect(of("Q4415058").some((row) => row.unii !== undefined)).toBe(false);
    expect(of("Q4415058").some((row) => row.cas?.value === "80714-61-0")).toBe(true);

    // Elamipretide: the one peptide member.
    expect(rows.filter((row) => row.isPeptide !== undefined).map(qid)).toEqual(["Q27269822"]);

    // Paracetamol: abridged to an ATC-only classification signal.
    expect(of("Q57055").some((row) => row.atc?.value === "N02BE01")).toBe(true);
    expect(of("Q57055").some((row) => row.role !== undefined || row.class !== undefined)).toBe(false);

    // Two synthetic items share one UNII.
    const byUnii = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.unii) continue;
      const items = byUnii.get(row.unii.value) ?? new Set<string>();
      items.add(qid(row));
      byUnii.set(row.unii.value, items);
    }
    expect([...byUnii.values()].filter((items) => items.size === 2)).toHaveLength(1);
  });
});
