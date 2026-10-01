import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WIKIDATA_QUERY,
  WIKIDATA_RESULT_VARIABLES,
  WikidataAcquisitionError,
  acquireWikidataSnapshot,
  assembleWikidataResult,
  readVerifiedWikidataSnapshot,
  serializeWikidataJson,
  verifyWikidataReceipt,
  wikidataPageQuery,
} from "../src/wikidata/acquire.ts";
import type {
  WikidataBinding,
  WikidataResult,
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

function binding(qid: string, unii: string): WikidataBinding {
  return {
    item: item(qid),
    itemLabel: { type: "literal", value: qid, "xml:lang": "en" },
    unii: literal(unii),
    isChemicalEntity: {
      type: "literal",
      value: "true",
      datatype: "http://www.w3.org/2001/XMLSchema#boolean",
    },
  };
}

function page(bindings: WikidataBinding[]): WikidataResult {
  return {
    head: { vars: [...WIKIDATA_RESULT_VARIABLES] },
    results: { bindings },
  };
}

function fetchPages(
  pages: readonly WikidataResult[],
  requests: URL[] = [],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(url);
    const query = url.searchParams.get("query") ?? "";
    const offset = Number(/\nOFFSET (\d+)$/.exec(query)?.[1] ?? "0");
    const limit = Number(/\nLIMIT (\d+)\n/.exec(query)?.[1] ?? "1");
    const index = offset / limit;
    return Response.json(pages[index] ?? page([]));
  }) as typeof fetch;
}

const acquired = async (
  directory: string,
  retrievedAt = "2026-10-01T00:00:00.000Z",
  pages = [page([binding("Q3", "UNII000003")])],
) =>
  acquireWikidataSnapshot({
    directory,
    retrievedAt,
    pageSize: 10,
    fetchImplementation: fetchPages(pages),
  });

describe("Wikidata query and page assembly", () => {
  test("pins the fixed selection, stable ordering, limit, and aligned offsets", () => {
    expect(WIKIDATA_QUERY).toContain("wdt:P652");
    expect(WIKIDATA_QUERY).toContain("wdt:P231");
    expect(WIKIDATA_QUERY).toContain("wdt:P662");
    expect(WIKIDATA_QUERY).toContain("wdt:P2868");
    expect(WIKIDATA_QUERY).toContain("wdt:P267");
    expect(WIKIDATA_QUERY).toContain("wdt:P31/wdt:P279* wd:Q172847");
    expect(WIKIDATA_QUERY).toEndWith(
      "ORDER BY ?item ?itemLabel ?alias ?unii ?cas ?pubchemCid ?role ?roleLabel ?atc ?class ?classLabel ?isChemicalEntity",
    );
    expect(wikidataPageQuery(25, 50)).toBe(`${WIKIDATA_QUERY}\nLIMIT 25\nOFFSET 50`);
    expect(() => wikidataPageQuery(25, 26)).toThrow(/aligned/);
  });

  test("sorts rows canonically when pages and rows arrive out of order", () => {
    const result = assembleWikidataResult([
      page([binding("Q9", "UNII000009"), binding("Q2", "UNII000002")]),
      page([binding("Q5", "UNII000005"), binding("Q1", "UNII000001")]),
    ]);
    expect(result.results.bindings.map((row) => row.item?.value)).toEqual([
      "http://www.wikidata.org/entity/Q1",
      "http://www.wikidata.org/entity/Q2",
      "http://www.wikidata.org/entity/Q5",
      "http://www.wikidata.org/entity/Q9",
    ]);
  });

  test("requests deterministic offsets until a short page", async () => {
    const requests: URL[] = [];
    const snapshot = await acquireWikidataSnapshot({
      directory: temporary(),
      retrievedAt: "2026-10-01T00:00:00Z",
      pageSize: 2,
      fetchImplementation: fetchPages(
        [
          page([binding("Q2", "UNII000002"), binding("Q1", "UNII000001")]),
          page([binding("Q3", "UNII000003")]),
        ],
        requests,
      ),
    });
    expect(requests.map((url) => url.searchParams.get("query"))).toEqual([
      wikidataPageQuery(2, 0),
      wikidataPageQuery(2, 2),
    ]);
    expect(snapshot.result.results.bindings.map((row) => row.item?.value)).toEqual([
      "http://www.wikidata.org/entity/Q1",
      "http://www.wikidata.org/entity/Q2",
      "http://www.wikidata.org/entity/Q3",
    ]);
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

  test("refuses overwrite and verifies hashes before result parsing", async () => {
    const root = temporary();
    const snapshot = await acquired(root);
    await expect(acquired(root)).rejects.toThrow(/refusing to overwrite/);

    const receipt = JSON.parse(readFileSync(snapshot.receiptPath, "utf8"));
    const changed = new Uint8Array(readFileSync(snapshot.resultPath));
    changed[0] = 0x5b;
    expect(() => verifyWikidataReceipt(changed, receipt)).toThrow(/SHA-256/);
  });

  test("invalid timestamps and malformed endpoint responses fail closed", async () => {
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01 12:00:00",
        fetchImplementation: fetchPages([]),
      }),
    ).rejects.toThrow(/ISO 8601 instant/);
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-02-30T12:00:00Z",
        fetchImplementation: fetchPages([]),
      }),
    ).rejects.toThrow(/ISO 8601 instant/);

    const malformedFetch = (async () =>
      Response.json({ head: { vars: ["item"] }, results: { bindings: [] } })) as unknown as typeof fetch;
    await expect(
      acquireWikidataSnapshot({
        directory: temporary(),
        retrievedAt: "2026-10-01T00:00:00Z",
        fetchImplementation: malformedFetch,
      }),
    ).rejects.toThrow(WikidataAcquisitionError);
  });

  test("result serialization is deterministic JSON with a final newline", () => {
    const bytes = serializeWikidataJson(page([binding("Q1", "UNII000001")]));
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify(page([binding("Q1", "UNII000001")]), null, 2)}\n`);
  });
});

describe("committed Wikidata fixture", () => {
  const root = resolve(import.meta.dir, "fixtures", "wikidata", "2026-10-01");

  test("pins the exact result digest, byte count, and receipt", () => {
    const bytes = readFileSync(resolve(root, "wikidata-2026-10-01.json"));
    expect(bytes.byteLength).toBe(3501);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "d0734facd3c1b65d053534fd30689234fbbc505404825e3b865053445c99bfc9",
    );
    const snapshot = readVerifiedWikidataSnapshot(root, "2026-10-01");
    expect(snapshot.receipt.byte_count).toBe(3501);
    expect(snapshot.receipt.row_count).toBe(4);
  });

  test("has at most 20 items and all required edge cases", () => {
    const rows = readVerifiedWikidataSnapshot(root, "2026-10-01").result.results.bindings;
    const qid = (row: WikidataBinding): string => row.item!.value.split("/").at(-1)!;
    expect(new Set(rows.map(qid)).size).toBeLessThanOrEqual(20);

    const noopept = rows.find((row) => qid(row) === "Q7049784");
    expect(noopept?.role?.value).toBe("http://www.wikidata.org/entity/Q742487");

    const byUnii = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.unii) continue;
      const items = byUnii.get(row.unii.value) ?? new Set<string>();
      items.add(qid(row));
      byUnii.set(row.unii.value, items);
    }
    expect([...byUnii.values()].some((items) => items.size === 2)).toBe(true);

    expect(
      rows.some(
        (row) => row.atc !== undefined && row.role === undefined && row.class === undefined,
      ),
    ).toBe(true);
  });
});
