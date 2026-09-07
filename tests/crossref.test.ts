import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { createSchemaValidators, formatYaml, validateCorpus } from "../src/corpus.ts";
import { acquireCrossrefReferences } from "../src/crossref/acquire.ts";
import { emitCrossrefImport, plannedPaths } from "../src/crossref/emit.ts";
import {
  CrossrefImportError,
  crossrefWorkUrl,
  pmcIdconvUrl,
  renderAuthorName,
} from "../src/crossref/format.ts";
import { planCrossrefImport } from "../src/crossref/plan.ts";
import {
  CROSSREF_ACQUISITION_CONTRACT,
  readCrossrefSnapshot,
  readTargetResources,
} from "../src/crossref/read.ts";
import type { CrossrefAcquisitionTarget } from "../src/crossref/read.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function writeYaml(root: string, path: string, value: unknown): void {
  const absolutePath = resolve(root, ...path.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, formatYaml(value), "utf8");
}

function readYaml(root: string, path: string): Record<string, unknown> {
  return parse(readFileSync(resolve(root, ...path.split("/")), "utf8")) as Record<
    string,
    unknown
  >;
}

function codes(root: string): string[] {
  return validateCorpus(root).diagnostics.map((diagnostic) => diagnostic.code);
}

/**
 * Codes the evidence-integrity suspension demoted. The checks still run and
 * still report here; they simply no longer fail the corpus gate.
 */
function warningCodes(root: string): string[] {
  return validateCorpus(root).warnings.map((diagnostic) => diagnostic.code);
}

const RESOURCE_PATH = "resources/nutrition/food/blueberries.yaml";
const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const COMMITTED_BATCH_ID = "crossref-4667b033805f0818";
const CROSSREF_DOCUMENTATION_URL =
  "https://www.crossref.org/documentation/retrieve-metadata/rest-api/";
const DOI_1 = "10.1111/j.1753-4887.2010.00273.x";
const DOI_2 = "10.3390/antiox10101600";
const ABSTRACT =
  "<jats:p>Publisher-authored text that must never reach a committed file.</jats:p>";

/** A minimal published resource modeled on the real Blueberries file. */
function resourceData(): Record<string, unknown> {
  return {
    associations: [],
    category: "food",
    claims: [],
    description: "Anthocyanin-rich berry.",
    entity_type: "diet",
    id: "DT000001",
    identifiers: [{ kind: "source_slug", value: "nutrition/food:blueberries" }],
    kind: "resource",
    lifecycle: "published",
    links: [],
    provenance: { source: "Manasource editorial" },
    references: [
      {
        date: "2010-03-01",
        id: "berries-cardiovascular-review",
        title: "Berries: emerging impact on cardiovascular health",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3068482/",
      },
      {
        date: "2021-10-12",
        id: "anthocyanins-colorectal-cancer-review",
        title: "Anthocyanins in Colorectal Cancer Prevention Review",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8533526/",
      },
    ],
    schema_version: 1,
    score: 7,
    slug: "blueberries",
    title: "Blueberries",
  };
}

function referenceOf(
  data: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const references = data.references as Record<string, unknown>[];
  const reference = references.find((item) => item.id === id);
  expect(reference).toBeDefined();
  return reference!;
}

/** One enrichment-covering manifest, shaped as the importer emits it. */
function referenceManifest(): Record<string, unknown> {
  return {
    attribution: "Bibliographic metadata from the Crossref REST API.",
    batch_id: "crossref-0000000000000000",
    counts: { references: 1, resources: 1 },
    importer_version: "crossref-1",
    kind: "reference_import_manifest",
    license:
      "Crossref REST API documentation (https://www.crossref.org/documentation/retrieve-metadata/rest-api/); may be used for any purpose.",
    normalization_version: "1.0.0",
    notice: "Test batch.",
    references: [
      {
        authors: ["Arpita Basu", "Michael Rhone", "Timothy J Lyons"],
        container_title: "Nutrition Reviews",
        doi: DOI_1,
        pmcid: "PMC3068482",
        pmid: "20384847",
        reference_id: "berries-cardiovascular-review",
        resource_id: "DT000001",
      },
    ],
    retrieved_at: "2026-09-02T23:26:29.000Z",
    schema_version: 1,
    source: "crossref",
    source_namespace: "crossref.works",
  };
}

function idconvBody(pmcid: string, doi: string, pmid: number | null): unknown {
  return {
    status: "ok",
    "response-date": "2026-09-02 19:26:22",
    request: { format: "json", ids: [pmcid], idtype: "pmcid" },
    records: [
      { doi, pmcid, ...(pmid === null ? {} : { pmid }), "requested-id": pmcid },
    ],
  };
}

type WorkOverrides = {
  authors?: unknown;
  containerTitle?: string[] | undefined;
  abstract?: string;
};

function workBody(doi: string, overrides: WorkOverrides = {}): unknown {
  const message: Record<string, unknown> = {
    DOI: doi,
    type: "journal-article",
    publisher: "Example Publisher",
    title: ["An example work"],
    "container-title": overrides.containerTitle ?? [],
  };
  if (overrides.authors !== undefined) message.author = overrides.authors;
  if (overrides.abstract !== undefined) message.abstract = overrides.abstract;
  return { status: "ok", "message-type": "work", "message-version": "1.0.0", message };
}

const WORK_1 = workBody(DOI_1, {
  authors: [
    { given: "Arpita", family: "Basu", sequence: "first", affiliation: [] },
    { given: "Michael", family: "Rhone", sequence: "additional", affiliation: [] },
    { given: "Timothy J", family: "Lyons", sequence: "additional", affiliation: [] },
  ],
  containerTitle: ["Nutrition Reviews"],
});

const WORK_2 = workBody(DOI_2, {
  authors: [
    { given: "Ni", family: "Shi" },
    { given: "Xiaoxin", family: "Chen" },
    { given: "Tong", family: "Chen" },
  ],
  containerTitle: ["Antioxidants"],
  abstract: ABSTRACT,
});

type SnapshotWork = {
  pmcid: string;
  doi: string;
  pmid: number | null;
  idconv?: unknown;
  work?: unknown;
  /** The DOI the receipt records the works request for, when it should lie. */
  requestedDoi?: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Writes a verifiable snapshot: payload files plus a truthful receipt. */
function writeSnapshot(
  targets: CrossrefAcquisitionTarget[],
  works: SnapshotWork[],
  mutateReceipt: (receipt: Record<string, unknown>) => void = () => {},
): string {
  const root = temporary("crossref-snapshot-");
  const requests: Record<string, unknown>[] = [];
  for (const work of works) {
    const idconvText = JSON.stringify(work.idconv ?? idconvBody(work.pmcid, work.doi, work.pmid));
    const idconvFile = `idconv-${work.pmcid}.json`;
    writeFileSync(resolve(root, idconvFile), idconvText, "utf8");
    requests.push({
      kind: "pmc_idconv",
      pmcid: work.pmcid,
      doi: null,
      url: pmcIdconvUrl(work.pmcid),
      file: idconvFile,
      httpStatus: 200,
      declaredBytes: Buffer.byteLength(idconvText),
      observedBytes: Buffer.byteLength(idconvText),
      sha256: sha256(idconvText),
      servedAt: "2026-09-02T23:26:22.000Z",
    });

    const requestedDoi = work.requestedDoi ?? work.doi;
    const workText = JSON.stringify(work.work ?? workBody(work.doi));
    const workFile = `crossref-${requestedDoi.replaceAll("/", "_")}.json`;
    writeFileSync(resolve(root, workFile), workText, "utf8");
    requests.push({
      kind: "crossref_work",
      pmcid: work.pmcid,
      doi: requestedDoi,
      url: crossrefWorkUrl(requestedDoi),
      file: workFile,
      httpStatus: 200,
      declaredBytes: null,
      observedBytes: Buffer.byteLength(workText),
      sha256: sha256(workText),
      servedAt: "2026-09-02T23:26:29.000Z",
    });
  }
  const receipt: Record<string, unknown> = {
    contract: CROSSREF_ACQUISITION_CONTRACT,
    retrievedAt: "2026-09-02T23:26:29.000Z",
    targets,
    requests,
  };
  mutateReceipt(receipt);
  writeFileSync(
    resolve(root, "acquisition.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  return root;
}

const BLUEBERRY_TARGETS: CrossrefAcquisitionTarget[] = [
  {
    resourcePath: RESOURCE_PATH,
    referenceId: "berries-cardiovascular-review",
    pmcid: "PMC3068482",
  },
  {
    resourcePath: RESOURCE_PATH,
    referenceId: "anthocyanins-colorectal-cancer-review",
    pmcid: "PMC8533526",
  },
];

const BLUEBERRY_WORKS: SnapshotWork[] = [
  { pmcid: "PMC3068482", doi: DOI_1, pmid: 20384847, work: WORK_1 },
  { pmcid: "PMC8533526", doi: DOI_2, pmid: 34679735, work: WORK_2 },
];

function corpusWithResource(data: Record<string, unknown>): string {
  const root = temporary("crossref-corpus-");
  writeYaml(root, RESOURCE_PATH, data);
  return root;
}

describe("reference schema", () => {
  const validator = () => createSchemaValidators().resource;

  test("keeps title/date/url-only references valid", () => {
    expect(validator()(resourceData())).toBe(true);
  });

  test("accepts partial and complete bibliographic identity", () => {
    const partial = resourceData();
    referenceOf(partial, "berries-cardiovascular-review").doi = DOI_1;
    expect(validator()(partial)).toBe(true);

    const complete = resourceData();
    const reference = referenceOf(complete, "berries-cardiovascular-review");
    reference.doi = DOI_1;
    reference.authors = ["Arpita Basu", "Michael Rhone", "Timothy J Lyons"];
    reference.container_title = "Nutrition Reviews";
    expect(validator()(complete)).toBe(true);
  });

  test("rejects unknown reference fields, study type included", () => {
    for (const field of ["study_type", "journal", "abstract"]) {
      const data = resourceData();
      referenceOf(data, "berries-cardiovascular-review")[field] = "anything";
      const validate = validator();
      expect(validate(data)).toBe(false);
      expect(
        validate.errors?.some((error) => error.keyword === "additionalProperties"),
      ).toBe(true);
    }
  });

  test("bibliographic identity is a package rooted in an addressable DOI", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ authors: ["Arpita Basu"] }, "dependentRequired"],
      [{ container_title: "Nutrition Reviews" }, "dependentRequired"],
      [{ doi: "not-a-doi" }, "pattern"],
      [{ doi: DOI_1, authors: [] }, "minItems"],
      [{ doi: DOI_1, authors: [" "] }, "pattern"],
      [{ doi: DOI_1, container_title: "" }, "minLength"],
    ];
    for (const [fields, keyword] of cases) {
      const data = resourceData();
      Object.assign(referenceOf(data, "berries-cardiovascular-review"), fields);
      const validate = validator();
      expect(validate(data)).toBe(false);
      expect(validate.errors?.some((error) => error.keyword === keyword)).toBe(true);
    }

    // A DOI on a reference with no local id cannot be named by a manifest.
    const unaddressable = resourceData();
    const reference = referenceOf(unaddressable, "berries-cardiovascular-review");
    delete reference.id;
    reference.doi = DOI_1;
    const validate = validator();
    expect(validate(unaddressable)).toBe(false);
    expect(
      validate.errors?.some((error) => error.keyword === "dependentRequired"),
    ).toBe(true);
  });
});

describe("reference manifest schema", () => {
  const validator = () => createSchemaValidators().manifest;

  test("accepts the emitted manifest shape", () => {
    expect(validator()(referenceManifest())).toBe(true);
  });

  test("requires the licence, attribution, and notice trail", () => {
    for (const field of ["license", "attribution", "notice", "counts", "references"]) {
      const manifest = referenceManifest();
      delete manifest[field];
      const validate = validator();
      expect(validate(manifest)).toBe(false);
      expect(
        validate.errors?.some(
          (error) =>
            error.keyword === "required" && error.params.missingProperty === field,
        ),
      ).toBe(true);
    }
  });

  test("keeps both manifest variants closed against each other", () => {
    const record = parse(
      readFileSync(
        resolve(import.meta.dir, "fixtures", "valid", "manifests", "example", "2026-08-02.yaml"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(validator()(record)).toBe(true);
    record.references = [];
    expect(validator()(record)).toBe(false);

    const reference = referenceManifest();
    reference.records = [];
    expect(validator()(reference)).toBe(false);

    const entry = referenceManifest();
    (entry.references as Record<string, unknown>[])[0]!.study_type = "rct";
    expect(validator()(entry)).toBe(false);
  });
});

describe("reference coverage invariants", () => {
  test("an enriched corpus with its covering manifest validates clean", () => {
    const data = resourceData();
    const reference = referenceOf(data, "berries-cardiovascular-review");
    reference.doi = DOI_1;
    reference.authors = ["Arpita Basu", "Michael Rhone", "Timothy J Lyons"];
    reference.container_title = "Nutrition Reviews";
    const root = corpusWithResource(data);
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", referenceManifest());
    expect(validateCorpus(root).diagnostics).toEqual([]);
  });

  test("imported bibliographic identity without manifest coverage is reported, not enforced", () => {
    const data = resourceData();
    referenceOf(data, "berries-cardiovascular-review").doi = DOI_1;
    const root = corpusWithResource(data);
    expect(warningCodes(root)).toContain("manifest/missing-reference-coverage");
    expect(codes(root)).not.toContain("manifest/missing-reference-coverage");
  });

  test("a manifest entry resolving to no local reference is reported, not enforced", () => {
    const root = corpusWithResource(resourceData());
    const manifest = referenceManifest();
    (manifest.references as Record<string, unknown>[])[0]!.reference_id = "no-such-reference";
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", manifest);
    expect(warningCodes(root)).toContain("manifest/missing-reference");
    expect(codes(root)).not.toContain("manifest/missing-reference");
  });

  test("a manifest DOI disagreeing with the resource is reported, not enforced", () => {
    const data = resourceData();
    referenceOf(data, "berries-cardiovascular-review").doi = DOI_2;
    const root = corpusWithResource(data);
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", referenceManifest());
    const reported = warningCodes(root);
    expect(reported).toContain("manifest/reference-doi-mismatch");
    expect(reported).toContain("manifest/missing-reference-coverage");
    expect(validateCorpus(root).ok).toBe(true);
  });

  test("authors reordered against the manifest are reported, not enforced", () => {
    const data = resourceData();
    const reference = referenceOf(data, "berries-cardiovascular-review");
    reference.doi = DOI_1;
    reference.authors = ["Michael Rhone", "Arpita Basu", "Timothy J Lyons"];
    reference.container_title = "Nutrition Reviews";
    const root = corpusWithResource(data);
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", referenceManifest());
    const reported = warningCodes(root);
    expect(reported).toContain("manifest/reference-authors-mismatch");
    expect(reported).toContain("manifest/missing-reference-coverage");
    expect(validateCorpus(root).ok).toBe(true);
  });

  test("a hand-edited container title is reported, not enforced", () => {
    const data = resourceData();
    const reference = referenceOf(data, "berries-cardiovascular-review");
    reference.doi = DOI_1;
    reference.authors = ["Arpita Basu", "Michael Rhone", "Timothy J Lyons"];
    reference.container_title = "Changed by hand";
    const root = corpusWithResource(data);
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", referenceManifest());
    const reported = warningCodes(root);
    expect(reported).toContain("manifest/reference-container-title-mismatch");
    expect(reported).toContain("manifest/missing-reference-coverage");
    expect(validateCorpus(root).ok).toBe(true);
  });

  test("legitimately absent upstream facts are absent in both resource and manifest", () => {
    const data = resourceData();
    referenceOf(data, "berries-cardiovascular-review").doi = DOI_1;
    const manifest = referenceManifest();
    const entry = (manifest.references as Record<string, unknown>[])[0]!;
    delete entry.authors;
    delete entry.container_title;
    const root = corpusWithResource(data);
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", manifest);
    expect(validateCorpus(root).diagnostics).toEqual([]);
  });

  test("manifest counts must total its entries and resources", () => {
    const data = resourceData();
    const reference = referenceOf(data, "berries-cardiovascular-review");
    reference.doi = DOI_1;
    const root = corpusWithResource(data);
    const manifest = referenceManifest();
    manifest.counts = { references: 2, resources: 3 };
    writeYaml(root, "manifests/crossref/crossref-0000000000000000.yaml", manifest);
    const resultCodes = codes(root);
    expect(resultCodes).toContain("manifest/reference-count");
    expect(resultCodes).toContain("manifest/resource-count");
  });
});

describe("committed Crossref batch", () => {
  test("manifest identity exactly covers the imported Blueberries fields", () => {
    const resource = readYaml(REPOSITORY_ROOT, RESOURCE_PATH);
    const manifest = readYaml(
      REPOSITORY_ROOT,
      `manifests/crossref/${COMMITTED_BATCH_ID}.yaml`,
    );
    expect(createSchemaValidators().manifest(manifest)).toBe(true);
    expect(manifest.license).toContain(CROSSREF_DOCUMENTATION_URL);

    for (const item of manifest.references as Record<string, unknown>[]) {
      const reference = referenceOf(resource, item.reference_id as string);
      expect(reference.doi).toBe(item.doi);
      expect(reference.authors).toEqual(item.authors);
      expect(reference.container_title).toBe(item.container_title);
    }

    const report = JSON.parse(
      readFileSync(
        resolve(
          REPOSITORY_ROOT,
          "reports",
          "crossref",
          `${COMMITTED_BATCH_ID}-acquisition.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(report.batchId).toBe(COMMITTED_BATCH_ID);
    expect(report.license).toContain(CROSSREF_DOCUMENTATION_URL);
    expect(JSON.stringify(report)).not.toContain(ABSTRACT);
  });
});

describe("format", () => {
  test("author names render by the one deterministic rule", () => {
    expect(renderAuthorName({ given: "Arpita", family: "Basu" })).toBe("Arpita Basu");
    expect(renderAuthorName({ family: "Basu" })).toBe("Basu");
    expect(renderAuthorName({ name: "EFSA Panel on Dietetic Products" })).toBe(
      "EFSA Panel on Dietetic Products",
    );
    expect(renderAuthorName({ given: " Timothy\tJ ", family: " Lyons " })).toBe(
      "Timothy J Lyons",
    );
    expect(renderAuthorName({})).toBe("");
  });
});

type StubRoute = () => Response;

function stubFetch(routes: Record<string, StubRoute>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const implementation = async (input: unknown): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch of ${url}`);
    return route();
  };
  return Object.assign(implementation as typeof fetch, { calls });
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { date: "Wed, 02 Sep 2026 23:26:22 GMT", ...headers },
  });
}

function blueberryRoutes(): Record<string, StubRoute> {
  return {
    [pmcIdconvUrl("PMC3068482")]: () => jsonResponse(idconvBody("PMC3068482", DOI_1, 20384847)),
    [pmcIdconvUrl("PMC8533526")]: () => jsonResponse(idconvBody("PMC8533526", DOI_2, 34679735)),
    [crossrefWorkUrl(DOI_1)]: () => jsonResponse(WORK_1),
    [crossrefWorkUrl(DOI_2)]: () => jsonResponse(WORK_2),
  };
}

describe("acquire", () => {
  test("writes a snapshot and receipt naming exactly what it fetched", async () => {
    const corpusRoot = corpusWithResource(resourceData());
    const snapshotRoot = temporary("crossref-acquire-");
    const fetchImplementation = stubFetch(blueberryRoutes());
    const acquisition = await acquireCrossrefReferences({
      directory: snapshotRoot,
      corpusRoot,
      resourcePaths: [RESOURCE_PATH],
      fetchImplementation,
    });

    expect(fetchImplementation.calls.sort()).toEqual(
      Object.keys(blueberryRoutes()).sort(),
    );
    expect(acquisition.targets).toEqual(BLUEBERRY_TARGETS);
    expect(acquisition.requests).toHaveLength(4);
    expect(acquisition.retrievedAt).toBe("2026-09-02T23:26:22.000Z");
    for (const request of acquisition.requests) {
      const bytes = readFileSync(resolve(snapshotRoot, request.file));
      expect(bytes.byteLength).toBe(request.observedBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(request.sha256);
    }

    // The receipt round-trips through the same verification import runs.
    const snapshot = readCrossrefSnapshot(snapshotRoot);
    expect([...snapshot.works.keys()].sort()).toEqual(["PMC3068482", "PMC8533526"]);
  });

  test("refuses a PMC reference that has no local id", async () => {
    const data = resourceData();
    delete referenceOf(data, "berries-cardiovascular-review").id;
    const corpusRoot = corpusWithResource(data);
    const fetchImplementation = stubFetch({});
    await expect(
      acquireCrossrefReferences({
        directory: temporary("crossref-acquire-"),
        corpusRoot,
        resourcePaths: [RESOURCE_PATH],
        fetchImplementation,
      }),
    ).rejects.toThrow(CrossrefImportError);
    expect(fetchImplementation.calls).toEqual([]);
  });

  test("refuses a symlinked target file before fetching or changing its target", async () => {
    const corpusRoot = temporary("crossref-corpus-");
    const outsideRoot = temporary("crossref-outside-");
    const outsidePath = resolve(outsideRoot, "blueberries.yaml");
    writeFileSync(outsidePath, formatYaml(resourceData()), "utf8");
    const targetPath = resolve(corpusRoot, ...RESOURCE_PATH.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    symlinkSync(outsidePath, targetPath);
    const before = readFileSync(outsidePath, "utf8");
    const fetchImplementation = stubFetch({});

    await expect(
      acquireCrossrefReferences({
        directory: temporary("crossref-acquire-"),
        corpusRoot,
        resourcePaths: [RESOURCE_PATH],
        fetchImplementation,
      }),
    ).rejects.toThrow("not an ordinary file");
    expect(fetchImplementation.calls).toEqual([]);
    expect(readFileSync(outsidePath, "utf8")).toBe(before);
  });

  test("refuses a response that is not a complete 200", async () => {
    const corpusRoot = corpusWithResource(resourceData());
    const routes = blueberryRoutes();
    routes[pmcIdconvUrl("PMC3068482")] = () => new Response("gone", { status: 404 });
    await expect(
      acquireCrossrefReferences({
        directory: temporary("crossref-acquire-"),
        corpusRoot,
        resourcePaths: [RESOURCE_PATH],
        fetchImplementation: stubFetch(routes),
      }),
    ).rejects.toThrow("HTTP 404");
  });

  test("refuses a declared content-length the body does not honour", async () => {
    const corpusRoot = corpusWithResource(resourceData());
    const routes = blueberryRoutes();
    routes[pmcIdconvUrl("PMC3068482")] = () =>
      jsonResponse(idconvBody("PMC3068482", DOI_1, 20384847), { "content-length": "7" });
    await expect(
      acquireCrossrefReferences({
        directory: temporary("crossref-acquire-"),
        corpusRoot,
        resourcePaths: [RESOURCE_PATH],
        fetchImplementation: stubFetch(routes),
      }),
    ).rejects.toThrow("fragment");
  });
});

describe("read", () => {
  test("verifies the snapshot and preserves the served facts", () => {
    const root = writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS);
    const snapshot = readCrossrefSnapshot(root);
    const first = snapshot.works.get("PMC3068482")!;
    expect(first.doi).toBe(DOI_1);
    expect(first.pmid).toBe("20384847");
    expect(first.authors).toEqual(["Arpita Basu", "Michael Rhone", "Timothy J Lyons"]);
    expect(first.containerTitle).toBe("Nutrition Reviews");
    const second = snapshot.works.get("PMC8533526")!;
    expect(second.authors).toEqual(["Ni Shi", "Xiaoxin Chen", "Tong Chen"]);
    expect(second.containerTitle).toBe("Antioxidants");
  });

  test("absent upstream facts stay absent rather than being invented", () => {
    const targets = [BLUEBERRY_TARGETS[0]!];
    const root = writeSnapshot(targets, [
      { pmcid: "PMC3068482", doi: DOI_1, pmid: null, work: workBody(DOI_1) },
    ]);
    const work = readCrossrefSnapshot(root).works.get("PMC3068482")!;
    expect(work.pmid).toBeNull();
    expect(work.authors).toBeNull();
    expect(work.containerTitle).toBeNull();
  });

  test("refuses a snapshot edited after acquisition", () => {
    const root = writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS);
    const file = resolve(root, "idconv-PMC3068482.json");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace('"status":"ok"', '"status":"OK"'), "utf8");
    expect(() => readCrossrefSnapshot(root)).toThrow("changed after acquisition");
  });

  test("refuses a receipt declaring another contract", () => {
    const root = writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS, (receipt) => {
      receipt.contract = "manasource/other/1";
    });
    expect(() => readCrossrefSnapshot(root)).toThrow("declares contract");
  });

  test("refuses receipt-controlled snapshot paths and alternate separators", () => {
    for (const unsafe of [
      "../outside.json",
      "/tmp/outside.json",
      "nested/response.json",
      "nested\\response.json",
      "C:\\outside.json",
    ]) {
      const root = writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS, (receipt) => {
        const requests = receipt.requests as Record<string, unknown>[];
        requests[0]!.file = unsafe;
      });
      expect(() => readCrossrefSnapshot(root)).toThrow("safe snapshot-file basename");
    }
  });

  test("refuses non-canonical or escaping resource target paths", () => {
    const corpusRoot = corpusWithResource(resourceData());
    for (const unsafe of [
      "resources/../outside.yaml",
      "resources/nutrition//food/blueberries.yaml",
      "resources/nutrition/food/../food/blueberries.yaml",
      "resources\\nutrition\\food\\blueberries.yaml",
      resolve(corpusRoot, RESOURCE_PATH),
    ]) {
      expect(() => readTargetResources(corpusRoot, [unsafe])).toThrow(
        "canonical repository-relative POSIX",
      );
    }
  });

  test("refuses a target beneath a symlinked parent that escapes resources", () => {
    const corpusRoot = temporary("crossref-corpus-");
    const outsideRoot = temporary("crossref-outside-");
    const outsidePath = resolve(outsideRoot, "food", "blueberries.yaml");
    mkdirSync(dirname(outsidePath), { recursive: true });
    writeFileSync(outsidePath, formatYaml(resourceData()), "utf8");
    const linkedParent = resolve(corpusRoot, "resources", "nutrition", "food");
    mkdirSync(dirname(linkedParent), { recursive: true });
    symlinkSync(dirname(outsidePath), linkedParent, "dir");
    const before = readFileSync(outsidePath, "utf8");
    const snapshot = readCrossrefSnapshot(
      writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS),
    );

    expect(() => {
      const resources = readTargetResources(corpusRoot, [RESOURCE_PATH]);
      const plan = planCrossrefImport({ snapshot, resources });
      emitCrossrefImport(corpusRoot, plan);
    }).toThrow("outside the real corpus resources directory");
    expect(readFileSync(outsidePath, "utf8")).toBe(before);
  });

  test("refuses a works file answering a different DOI than the trail states", () => {
    const root = writeSnapshot(BLUEBERRY_TARGETS, [
      { ...BLUEBERRY_WORKS[0]!, requestedDoi: DOI_2, work: workBody(DOI_2) },
      BLUEBERRY_WORKS[1]!,
    ]);
    expect(() => readCrossrefSnapshot(root)).toThrow("works request");
  });
});

describe("plan and import", () => {
  function importedCorpus(): { corpusRoot: string; snapshotRoot: string } {
    const corpusRoot = corpusWithResource(resourceData());
    const snapshotRoot = writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS);
    const snapshot = readCrossrefSnapshot(snapshotRoot);
    const resources = readTargetResources(
      corpusRoot,
      snapshot.acquisition.targets.map((target) => target.resourcePath),
    );
    const plan = planCrossrefImport({ snapshot, resources });
    emitCrossrefImport(corpusRoot, plan);
    return { corpusRoot, snapshotRoot };
  }

  test("enriches exactly the named references and nothing else in them", () => {
    const { corpusRoot } = importedCorpus();
    const data = readYaml(corpusRoot, RESOURCE_PATH);
    const first = referenceOf(data, "berries-cardiovascular-review");
    expect(first.doi).toBe(DOI_1);
    expect(first.authors).toEqual(["Arpita Basu", "Michael Rhone", "Timothy J Lyons"]);
    expect(first.container_title).toBe("Nutrition Reviews");
    expect(first.title).toBe("Berries: emerging impact on cardiovascular health");
    expect(first.date).toBe("2010-03-01");
    expect(first.url).toBe("https://pmc.ncbi.nlm.nih.gov/articles/PMC3068482/");
    const second = referenceOf(data, "anthocyanins-colorectal-cancer-review");
    expect(second.doi).toBe(DOI_2);
    expect(second.authors).toEqual(["Ni Shi", "Xiaoxin Chen", "Tong Chen"]);
  });

  test("the enriched corpus, manifest and coverage validate clean end to end", () => {
    const { corpusRoot } = importedCorpus();
    expect(validateCorpus(corpusRoot).diagnostics).toEqual([]);
  });

  test("no committed byte carries the abstract or other publisher text", () => {
    const corpusRoot = corpusWithResource(resourceData());
    const snapshotRoot = writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS);
    const snapshot = readCrossrefSnapshot(snapshotRoot);
    const plan = planCrossrefImport({
      snapshot,
      resources: readTargetResources(corpusRoot, [RESOURCE_PATH]),
    });
    for (const file of [...plan.resources, plan.manifest, ...plan.reports]) {
      expect(file.contents).not.toContain("jats");
      expect(file.contents).not.toContain("Publisher-authored");
      expect(file.contents).not.toContain("journal-article");
    }
  });

  test("re-running import over its own output writes nothing", () => {
    const { corpusRoot, snapshotRoot } = importedCorpus();
    const snapshot = readCrossrefSnapshot(snapshotRoot);
    const resources = readTargetResources(corpusRoot, [RESOURCE_PATH]);
    const first = planCrossrefImport({ snapshot, resources });
    const emitted = emitCrossrefImport(corpusRoot, first);
    expect(emitted.written).toEqual([]);
    expect(emitted.unchanged.sort()).toEqual(plannedPaths(first));

    const again = planCrossrefImport({
      snapshot: readCrossrefSnapshot(snapshotRoot),
      resources: readTargetResources(corpusRoot, [RESOURCE_PATH]),
    });
    expect(again.batchId).toBe(first.batchId);
  });

  test("refuses to repoint a reference that already carries another DOI", () => {
    const data = resourceData();
    referenceOf(data, "berries-cardiovascular-review").doi = DOI_2;
    const corpusRoot = corpusWithResource(data);
    const snapshot = readCrossrefSnapshot(writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS));
    expect(() =>
      planCrossrefImport({
        snapshot,
        resources: readTargetResources(corpusRoot, [RESOURCE_PATH]),
      }),
    ).toThrow("never silently repointed");
  });

  test("refuses a corpus that moved under the snapshot", () => {
    const data = resourceData();
    referenceOf(data, "berries-cardiovascular-review").url =
      "https://pmc.ncbi.nlm.nih.gov/articles/PMC9999999/";
    const corpusRoot = corpusWithResource(data);
    const snapshot = readCrossrefSnapshot(writeSnapshot(BLUEBERRY_TARGETS, BLUEBERRY_WORKS));
    expect(() =>
      planCrossrefImport({
        snapshot,
        resources: readTargetResources(corpusRoot, [RESOURCE_PATH]),
      }),
    ).toThrow("no longer cites");
  });

  test("a work stating fewer facts enriches with fewer fields, removing stale ones", () => {
    const data = resourceData();
    const reference = referenceOf(data, "berries-cardiovascular-review");
    reference.doi = DOI_1;
    reference.authors = ["Stale Author"];
    reference.container_title = "Stale Container";
    const corpusRoot = corpusWithResource(data);
    const targets = [BLUEBERRY_TARGETS[0]!];
    const snapshot = readCrossrefSnapshot(
      writeSnapshot(targets, [
        { pmcid: "PMC3068482", doi: DOI_1, pmid: null, work: workBody(DOI_1) },
      ]),
    );
    const plan = planCrossrefImport({
      snapshot,
      resources: readTargetResources(corpusRoot, [RESOURCE_PATH]),
    });
    emitCrossrefImport(corpusRoot, plan);
    const enriched = referenceOf(
      readYaml(corpusRoot, RESOURCE_PATH),
      "berries-cardiovascular-review",
    );
    expect(enriched.doi).toBe(DOI_1);
    expect(enriched.authors).toBeUndefined();
    expect(enriched.container_title).toBeUndefined();
    expect(validateCorpus(corpusRoot).diagnostics).toEqual([]);
  });
});
