import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { validateCorpus } from "../src/corpus.ts";
import { acquireIngredients, splitResults, substanceRowOf } from "../src/families/acquire.ts";
import { planFamilyEdges } from "../src/families/edges.ts";
import type { FamilyInput } from "../src/families/edges.ts";
import {
  binomialOf,
  familyKey,
  isFormLabel,
  stripFormWord,
  nameTokens,
} from "../src/families/forms.ts";
import { edgeLine, parseEdges } from "../src/families/format.ts";
import { buildNameIndex, resolveName } from "../src/families/resolve.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures", "valid");
const temporaryRoots: string[] = [];

const noOverrides = { forms: [], rejected: [], aliases: [], display: [] };

const compound = (id: string, name: string, aliases: string[] = [], unii: string | null = null) => ({
  id,
  order: 0,
  name,
  aliases,
  unii,
});
const ingredient = (id: string, name: string, aliases: string[] = []) => ({
  id,
  order: 2,
  name,
  aliases,
  unii: null,
});

/** The plan's own example: Health Canada's rows for product 27203787. */
const AGMATINE_PLUS = {
  id: "SP0WPK8B",
  lnhpdId: "27203787",
  name: "Agmatine +",
};

const input = (overrides: Partial<FamilyInput> = {}): FamilyInput => ({
  records: [
    compound("CPVT34A1", "AGMATINE", ["(4-Aminobutyl)guanidine"]),
    ingredient("SIQMX5E3", "Agmatine Silicate"),
    compound("CPGLYCIN", "GLYCINE", ["Aminoacetic acid"]),
    compound("CPMAGNE1", "MAGNESIUM"),
    compound("CPMAGCIT", "MAGNESIUM CITRATE"),
    compound("CPMAGDIH", "MAGNESIUM CITRATE DIHYDRATE"),
    compound("CPCALCI1", "CALCIUM"),
    ingredient("SICALMAG", "Calcium Magnesium"),
    compound("CPWITHAN", "WITHANIA SOMNIFERA WHOLE", ["Ashwagandha"]),
    compound("CPWITROO", "WITHANIA SOMNIFERA ROOT"),
    compound("CPHYDRCO", "HYDROCODONE"),
    compound("CPHYDBIT", "HYDROCODONE BITARTRATE"),
  ],
  products: [
    AGMATINE_PLUS,
    { id: "SPAGMATI", lnhpdId: "100", name: "Agmatine Sulfate" },
    { id: "SPMAGCIT", lnhpdId: "200", name: "Magnesium citrate tablets" },
    { id: "SPWITHAN", lnhpdId: "300", name: "Ashwagandha root" },
    { id: "SPUNKNOW", lnhpdId: "400", name: "Mystery" },
    { id: "SPMIXED1", lnhpdId: "500", name: "Magnesium and mystery" },
  ],
  ingredients: [
    { lnhpd_id: 27203787, ingredient_name: "Aminoacetic acid", source_material: "Glycine" },
    { lnhpd_id: 27203787, ingredient_name: "4-(Aminobutyl)guanidine", source_material: "Agmatine sulfate" },
    { lnhpd_id: 100, ingredient_name: "Agmatine", source_material: "Agmatine sulfate" },
    { lnhpd_id: 200, ingredient_name: "Magnesium citrate", source_material: "" },
    { lnhpd_id: 300, ingredient_name: "Withania somnifera", source_material: "Root" },
    { lnhpd_id: 400, ingredient_name: "Nothing known", source_material: "" },
    { lnhpd_id: 500, ingredient_name: "Magnesium", source_material: "" },
    { lnhpd_id: 500, ingredient_name: "Nothing known", source_material: "" },
    { lnhpd_id: 999, ingredient_name: "Agmatine", source_material: "" },
  ],
  substances: [],
  overrides: noOverrides,
  ...overrides,
});

const edgeOf = (plan: ReturnType<typeof planFamilyEdges>, base: string, member: string) =>
  plan.edges.find((edge) => edge.base === base && edge.member === member);

describe("names", () => {
  test("familyKey folds case, accents and punctuation", () => {
    expect(familyKey("4-(Aminobutyl)guanidine")).toBe(familyKey("(4-Aminobutyl)guanidine"));
    expect(familyKey("Café  Noir")).toBe("cafenoir");
  });

  test("strips one trailing form word", () => {
    expect(stripFormWord(nameTokens("Hydrocodone Bitartrate"))?.stem).toEqual(["hydrocodone"]);
    expect(stripFormWord(nameTokens("Creatine Ethyl Ester"))?.stem).toEqual(["creatine"]);
    expect(stripFormWord(nameTokens("Hydrocodone"))).toBeNull();
    expect(stripFormWord(nameTokens("Citrate"))).toBeNull();
  });

  test("marks two minerals as ambiguous", () => {
    expect(stripFormWord(nameTokens("Calcium Magnesium"))?.ambiguous).toBe(true);
    expect(stripFormWord(nameTokens("Atorvastatin Calcium"))?.ambiguous).toBe(false);
  });

  test("reads a binomial with a part", () => {
    expect(binomialOf(nameTokens("WITHANIA SOMNIFERA ROOT"))).toEqual(["withania", "somnifera"]);
    expect(binomialOf(nameTokens("WITHANIA SOMNIFERA"))).toBeNull();
  });

  test("tells a form label from a plant part", () => {
    expect(isFormLabel("Agmatine sulfate", "4-(Aminobutyl)guanidine")).toBe(true);
    for (const part of ["Leaf", "Root", "Rhizome", "Seed", "Seeds", "Whole cell"]) {
      expect(isFormLabel(part, "Withania somnifera")).toBe(false);
    }
    expect(isFormLabel("Withania somnifera - Root", "Withania")).toBe(false);
    expect(isFormLabel("", "Agmatine")).toBe(false);
    expect(isFormLabel("agmatine", "Agmatine")).toBe(false);
  });
});

describe("resolveName", () => {
  const index = buildNameIndex([
    compound("CPTHEA01", "THEANINE"),
    compound("CPBOTH01", "SHARED", ["Duplicate"]),
    ingredient("SIBOTH02", "Duplicate"),
    compound("CPMAGNE1", "MAGNESIUM"),
  ]);
  const none = new Map<string, string>();

  test("prefers a real name over an alias", () => {
    expect(resolveName("Duplicate", index, none)).toEqual({ id: "SIBOTH02", via: "exact" });
  });

  test("strips a chirality mark", () => {
    expect(resolveName("L-Theanine", index, none)).toEqual({ id: "CPTHEA01", via: "chirality" });
  });

  test("uses the form rule", () => {
    expect(resolveName("Magnesium Bisglycinate", index, none)).toEqual({
      id: "CPMAGNE1",
      via: "form",
    });
  });

  test("a reviewed alias wins", () => {
    const aliases = new Map([[familyKey("Vit D"), "CPTHEA01"]]);
    expect(resolveName("Vit D", index, aliases)).toEqual({ id: "CPTHEA01", via: "alias" });
  });

  test("leaves an unknown name unresolved", () => {
    expect(resolveName("Tablet", index, none)).toEqual({ id: null, held: false });
  });
});

describe("planFamilyEdges", () => {
  const plan = planFamilyEdges(input());

  test("a form joins its base by name", () => {
    expect(edgeOf(plan, "CPVT34A1", "SIQMX5E3")).toEqual({
      base: "CPVT34A1",
      member: "SIQMX5E3",
      role: "form",
      basis: "name_rule",
    });
    expect(edgeOf(plan, "CPHYDRCO", "CPHYDBIT")?.role).toBe("form");
  });

  test("a chain of forms reaches one base", () => {
    expect(edgeOf(plan, "CPMAGNE1", "CPMAGCIT")?.role).toBe("form");
    expect(edgeOf(plan, "CPMAGNE1", "CPMAGDIH")?.role).toBe("form");
    expect(plan.edges.some((edge) => edge.base === "CPMAGCIT")).toBe(false);
  });

  test("a plant part groups under the whole plant", () => {
    expect(edgeOf(plan, "CPWITHAN", "CPWITROO")).toMatchObject({
      role: "form",
      basis: "name_rule",
    });
  });

  test("holds a name with a mineral on both sides, with no edge", () => {
    expect(plan.report.held).toEqual(["Calcium Magnesium"]);
    expect(plan.edges.some((edge) => edge.member === "SICALMAG")).toBe(false);
  });

  test("the plan's example: a combination with one edge per ingredient", () => {
    expect(edgeOf(plan, "CPVT34A1", "SP0WPK8B")).toEqual({
      base: "CPVT34A1",
      member: "SP0WPK8B",
      role: "combination",
      basis: "hc.lnhpd",
      form: "Agmatine sulfate",
    });
    expect(edgeOf(plan, "CPGLYCIN", "SP0WPK8B")?.role).toBe("combination");
  });

  test("a sole ingredient is a product", () => {
    expect(edgeOf(plan, "CPVT34A1", "SPAGMATI")).toMatchObject({
      role: "product",
      form: "Agmatine sulfate",
    });
  });

  test("a product of a form attaches to the base and keeps the form", () => {
    expect(edgeOf(plan, "CPMAGNE1", "SPMAGCIT")).toMatchObject({
      role: "product",
      form: "Magnesium citrate",
    });
  });

  test("a plant part is not a form label", () => {
    const edge = edgeOf(plan, "CPWITHAN", "SPWITHAN");
    expect(edge?.role).toBe("product");
    expect(edge?.form).toBeUndefined();
  });

  test("an unresolved ingredient keeps the rest as a combination", () => {
    expect(edgeOf(plan, "CPMAGNE1", "SPMIXED1")?.role).toBe("combination");
  });

  test("a product with nothing resolved gets no edge and is counted", () => {
    expect(plan.edges.some((edge) => edge.member === "SPUNKNOW")).toBe(false);
    expect(plan.report.coverage).toMatchObject({
      products: 6,
      productsWithBase: 5,
      ingredientRowsWithoutProduct: 1,
    });
    expect(plan.report.topUnresolved[0]).toEqual({ name: "Nothing known", products: 2 });
  });

  test("no product is a base, and no base is a member", () => {
    const bases = new Set(plan.edges.map((edge) => edge.base));
    const members = new Set(plan.edges.map((edge) => edge.member));
    expect([...bases].some((id) => id.startsWith("SP"))).toBe(false);
    expect([...bases].filter((id) => members.has(id))).toEqual([]);
    expect(plan.edges.some((edge) => edge.base === edge.member)).toBe(false);
  });

  test("sorts by base, role and member", () => {
    const lines = plan.edges.map(edgeLine);
    expect(parseEdges(lines.join("\n"))).toEqual(plan.edges);
    const roles = plan.edges
      .filter((edge) => edge.base === "CPVT34A1")
      .map((edge) => edge.role);
    expect(roles).toEqual(["form", "product", "combination"]);
  });

  test("is deterministic", () => {
    expect(planFamilyEdges(input())).toEqual(plan);
  });

  test("an active moiety adds a form the name rule cannot", () => {
    const related = planFamilyEdges(
      input({
        records: [
          compound("CPCAFFE1", "CAFFEINE", [], "UNIIAAAAAA"),
          compound("CPSANDO1", "SANDOCAF", [], "UNIIBBBBBB"),
        ],
        products: [],
        ingredients: [],
        substances: [
          {
            unii: "UNIIBBBBBB",
            name: "SANDOCAF",
            relationships: [{ type: "ACTIVE MOIETY", unii: "UNIIAAAAAA" }],
          },
          // Every substance names itself as its own moiety, and that means nothing.
          {
            unii: "UNIIAAAAAA",
            name: "CAFFEINE",
            relationships: [{ type: "ACTIVE MOIETY", unii: "UNIIAAAAAA" }],
          },
        ],
      }),
    );
    expect(edgeOf(related, "CPCAFFE1", "CPSANDO1")?.basis).toBe("gsrs_relationship");
  });

  test("a salt's parent counts, and its counterion does not", () => {
    const related = planFamilyEdges(
      input({
        records: [
          compound("CPCAFFE1", "CAFFEINE", [], "UNIIAAAAAA"),
          compound("CPC1TR1C", "ANHYDROUS CITRIC ACID", [], "UNIIBBBBBB"),
          compound("CPSALT01", "CAFFEINE PIDOLATE", [], "UNIICCCCCC"),
        ],
        products: [],
        ingredients: [],
        substances: [
          {
            unii: "UNIICCCCCC",
            name: "CAFFEINE PIDOLATE",
            relationships: [
              { type: "PARENT->SALT/SOLVATE", unii: "UNIIBBBBBB" },
              { type: "PARENT->SALT/SOLVATE", unii: "UNIIAAAAAA" },
            ],
          },
        ],
      }),
    );
    expect(edgeOf(related, "CPCAFFE1", "CPSALT01")?.role).toBe("form");
    expect(edgeOf(related, "CPC1TR1C", "CPSALT01")).toBeUndefined();
  });

  test("a parent never becomes a form of its own salt", () => {
    const related = planFamilyEdges(
      input({
        records: [
          compound("CPCAFFE1", "CAFFEINE", [], "UNIIAAAAAA"),
          compound("CPSALT01", "CAFFEINE PIDOLATE", [], "UNIICCCCCC"),
        ],
        products: [],
        ingredients: [],
        substances: [
          {
            unii: "UNIIAAAAAA",
            name: "CAFFEINE",
            relationships: [{ type: "SALT/SOLVATE->PARENT", unii: "UNIICCCCCC" }],
          },
        ],
      }),
    );
    expect(related.edges).toEqual([]);
  });

  test("a moiety with no record reaches its element through a reviewed alias", () => {
    const related = planFamilyEdges(
      input({
        records: [
          compound("CPMAGNE1", "MAGNESIUM"),
          compound("CPMAGOXY", "MAGALDRATE", [], "UNIIAAAAAA"),
        ],
        products: [],
        ingredients: [],
        substances: [
          {
            unii: "UNIIAAAAAA",
            name: "MAGALDRATE",
            relationships: [{ type: "ACTIVE MOIETY", unii: "UNIICATION" }],
          },
          { unii: "UNIICATION", name: "MAGNESIUM CATION", relationships: [] },
        ],
        overrides: {
          ...noOverrides,
          aliases: [{ name: "MAGNESIUM CATION", base: "CPMAGNE1", note: "", decided_at: "2026-11-02", decided_by: "hermes" }],
        },
      }),
    );
    expect(edgeOf(related, "CPMAGNE1", "CPMAGOXY")?.basis).toBe("gsrs_relationship");
  });

  test("two records with one name are one substance", () => {
    const { edges } = planFamilyEdges(
      input({
        records: [
          compound("CPVALIN1", "VALINE"),
          ingredient("SIVALIN1", "Valine"),
          compound("CPSELEG1", "SELEGILINE, (+)-"),
          compound("CPSELEG2", "SELEGILINE"),
        ],
        products: [],
        ingredients: [],
        substances: [],
      }),
    );
    expect(edges.filter((edge) => edge.role === "form")).toEqual([
      { base: "CPSELEG2", member: "CPSELEG1", role: "form", basis: "name_rule" },
      { base: "CPVALIN1", member: "SIVALIN1", role: "form", basis: "name_rule" },
    ]);
  });

  test("a material that names another substance is not a form", () => {
    const plan = planFamilyEdges(
      input({
        ingredients: [
          { lnhpd_id: 200, ingredient_name: "Magnesium", source_material: "Agmatine" },
          { lnhpd_id: 100, ingredient_name: "Agmatine", source_material: "Agmatine sulfate" },
        ],
      }),
    );
    expect(edgeOf(plan, "CPMAGNE1", "SPMAGCIT")?.form).toBeUndefined();
    expect(edgeOf(plan, "CPVT34A1", "SPAGMATI")?.form).toBe("Agmatine sulfate");
  });

  test("a base can refuse products", () => {
    const decided = planFamilyEdges(
      input({
        overrides: {
          ...noOverrides,
          rejected: [
            { base: "CPMAGNE1", note: "", decided_at: "2026-11-02", decided_by: "hermes" },
          ],
        },
      }),
    );
    expect(edgeOf(decided, "CPMAGNE1", "SPMAGCIT")).toBeUndefined();
    expect(edgeOf(decided, "CPMAGNE1", "CPMAGCIT")?.role).toBe("form");
  });

  test("a loop in the authorities still gives every record one base", () => {
    const { edges } = planFamilyEdges(
      input({
        records: [
          { ...compound("CPLOOP01", "ALPHA SALT"), unii: "UNIIA" },
          { ...compound("CPLOOP02", "ALPHA SALT FORM"), unii: "UNIIB" },
        ],
        products: [],
        ingredients: [],
        substances: [
          { unii: "UNIIA", name: "ALPHA SALT", relationships: [{ type: "ACTIVE MOIETY", unii: "UNIIB" }] },
          { unii: "UNIIB", name: "ALPHA SALT FORM", relationships: [{ type: "ACTIVE MOIETY", unii: "UNIIA" }] },
        ],
      }),
    );
    expect(edges).toEqual([
      { base: "CPLOOP01", member: "CPLOOP02", role: "form", basis: "gsrs_relationship" },
    ]);
  });

  test("overrides force, refuse and alias", () => {
    const reviewed = { note: "", decided_at: "2026-11-02", decided_by: "hermes" };
    const decided = planFamilyEdges(
      input({
        overrides: {
          ...noOverrides,
          forms: [{ base: "CPCALCI1", member: "SICALMAG", ...reviewed }],
          rejected: [{ base: "CPHYDRCO", member: "CPHYDBIT", ...reviewed }],
          aliases: [{ name: "Nothing known", base: "CPGLYCIN", ...reviewed }],
        },
      }),
    );
    expect(edgeOf(decided, "CPCALCI1", "SICALMAG")?.basis).toBe("editorial");
    expect(edgeOf(decided, "CPHYDRCO", "CPHYDBIT")).toBeUndefined();
    expect(edgeOf(decided, "CPGLYCIN", "SPUNKNOW")?.role).toBe("product");
  });
});

describe("acquisition", () => {
  test("splits a results array across a chunk boundary", () => {
    const document = JSON.stringify({
      meta: {},
      results: [{ a: '}{"', b: { c: 1 } }, { d: "é" }],
    });
    for (let size = 1; size < document.length; size += 1) {
      const out: unknown[] = [];
      const split = splitResults((text) => out.push(JSON.parse(text)));
      for (let at = 0; at < document.length; at += size) {
        split(document.slice(at, at + size));
      }
      expect(out).toEqual([{ a: '}{"', b: { c: 1 } }, { d: "é" }]);
    }
  });

  test("keeps a substance's name and relationships, and nothing else", () => {
    expect(
      substanceRowOf({
        unii: "AAAAAAAAAA",
        names: [{ name: "Other" }, { name: "Display", display_name: true }],
        relationships: [
          { type: "ACTIVE MOIETY", related_substance: { unii: "BBBBBBBBBB" } },
          { type: "BAD ROW" },
        ],
      }),
    ).toEqual({
      unii: "AAAAAAAAAA",
      name: "Display",
      relationships: [{ type: "ACTIVE MOIETY", unii: "BBBBBBBBBB" }],
    });
    expect(substanceRowOf({ names: [] })).toBeNull();
  });
});

describe("acquiring ingredients", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const snapshot = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "manasource-ingredients-test-"));
    directories.push(directory);
    return directory;
  };

  const row = (id: number, name: string, material = "") => ({
    lnhpd_id: id,
    ingredient_name: name,
    source_material: material,
    quantity: 200,
  });

  /** One licence at a time, as the API answers it. */
  const feed = (answers: Record<string, unknown[]>, calls: string[] = []) =>
    (async (input: string) => {
      const id = new URL(input).searchParams.get("id") ?? "";
      calls.push(id);
      return new Response(JSON.stringify({ metadata: { pagination: null }, data: answers[id] ?? [] }));
    }) as unknown as typeof fetch;

  test("holds every licence, sorted and distinct, with no quantity", async () => {
    const directory = snapshot();
    const answers = {
      "20": [row(20, "Zinc"), row(20, "Agmatine", "Agmatine sulfate"), row(20, "Zinc")],
      "3": [row(3, "Magnesium")],
    };
    const acquired = await acquireIngredients(directory, ["20", "3", "7"], {
      fetchImplementation: feed(answers),
    });

    expect(acquired?.rows).toBe(3);
    const text = readFileSync(join(directory, "medicinalingredient.jsonl"), "utf8");
    expect(text.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { lnhpd_id: 3, ingredient_name: "Magnesium", source_material: "" },
      { lnhpd_id: 20, ingredient_name: "Agmatine", source_material: "Agmatine sulfate" },
      { lnhpd_id: 20, ingredient_name: "Zinc", source_material: "" },
    ]);
    expect(text).not.toContain("quantity");
  });

  test("one upstream state is one file, whatever order the licences answered in", async () => {
    const answers = { "1": [row(1, "A")], "2": [row(2, "B")] };
    const first = await acquireIngredients(snapshot(), ["1", "2"], {
      fetchImplementation: feed(answers),
    });
    const second = await acquireIngredients(snapshot(), ["2", "1"], {
      fetchImplementation: feed(answers),
    });
    expect(first?.sha256).toBe(second?.sha256 as string);
  });

  test("stops when told, and the same call carries on", async () => {
    const directory = snapshot();
    const answers = { "1": [row(1, "A")], "2": [row(2, "B")] };
    const stopped = await acquireIngredients(directory, ["1", "2"], {
      fetchImplementation: feed(answers),
      stopAfterMs: 0,
    });
    expect(stopped).toBeNull();

    writeFileSync(
      join(directory, "medicinalingredient.progress.jsonl"),
      `${JSON.stringify({ id: "1", rows: [row(1, "A")] })}\n{"id":"2","ro`,
    );
    const calls: string[] = [];
    const resumed = await acquireIngredients(directory, ["1", "2"], {
      fetchImplementation: feed(answers, calls),
    });
    // The first licence was held, and the line a kill cut short counts as not done.
    expect(calls).toEqual(["2"]);
    expect(resumed?.rows).toBe(2);
    expect(existsSync(join(directory, "medicinalingredient.progress.jsonl"))).toBe(false);
  });

  test("a licence that keeps failing stops the pull rather than reading as empty", async () => {
    const refusing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(
      acquireIngredients(snapshot(), ["1"], {
        fetchImplementation: refusing,
        concurrency: 1,
        backoffMs: 1,
      }),
    ).rejects.toThrow("HTTP 404");
  });
});

describe("corpus validation", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const withEdges = (lines: unknown[]): string => {
    const root = mkdtempSync(join(tmpdir(), "manasource-families-test-"));
    temporaryRoots.push(root);
    cpSync(FIXTURE, root, { recursive: true });
    mkdirSync(join(root, "families"), { recursive: true });
    writeFileSync(
      join(root, "families", "edges.jsonl"),
      `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
    );
    return root;
  };

  const codes = (root: string): string[] =>
    validateCorpus(root).diagnostics.map((diagnostic) => diagnostic.code);

  const edge = (base: string, member: string, extra: object = {}) => ({
    base,
    member,
    role: "form",
    basis: "name_rule",
    ...extra,
  });

  test("the fixture's own ledger is valid", () => {
    expect(validateCorpus(FIXTURE).ok).toBe(true);
  });

  test("a missing families directory is valid", () => {
    const root = withEdges([]);
    rmSync(join(root, "families"), { recursive: true });
    expect(validateCorpus(root).ok).toBe(true);
  });

  test("refuses an unknown record", () => {
    expect(codes(withEdges([edge("FDAB0001", "FDZZZZZZ")]))).toContain("family/unknown-record");
  });

  describe("overrides", () => {
    const decision = { note: "Why.", decided_at: "2026-11-02", decided_by: "hermes" };

    const withOverrides = (text: string): string => {
      const root = withEdges([]);
      writeFileSync(join(root, "families", "overrides.yaml"), text);
      return root;
    };

    const aliases = (...entries: object[]): string =>
      stringify({ forms: [], rejected: [], aliases: entries, display: [] });

    test("accepts a decided alias onto a record", () => {
      const root = withOverrides(aliases({ name: "Agmatine", base: "FDAB0001", ...decision }));
      expect(codes(root).filter((code) => code.startsWith("family/"))).toEqual([]);
    });

    test("every entry says who, when and why", () => {
      const root = withOverrides(aliases({ name: "Agmatine", base: "FDAB0001", note: "Why." }));
      expect(codes(root)).toContain("family/unaudited-override");
    });

    test("refuses an alias onto a missing record or a product", () => {
      expect(
        codes(withOverrides(aliases({ name: "Agmatine", base: "FDZZZZZZ", ...decision }))),
      ).toContain("family/unknown-record");
      expect(
        codes(withOverrides(aliases({ name: "Agmatine", base: "SPAB0001", ...decision }))),
      ).toContain("family/product-as-base");
    });

    test("refuses the same spelling twice", () => {
      const root = withOverrides(
        aliases(
          { name: "Agmatine", base: "FDAB0001", ...decision },
          { name: "AGMATINE", base: "FDAB0001", ...decision },
        ),
      );
      expect(codes(root)).toContain("family/duplicate-alias");
    });

    test("the four lists are closed", () => {
      expect(codes(withOverrides(stringify({ synonyms: [] })))).toContain(
        "family/malformed-overrides",
      );
      expect(codes(withOverrides("a: [\n"))).toContain("family/malformed-overrides");
    });
  });

  test("refuses a product as a base", () => {
    expect(codes(withEdges([edge("SPAB0001", "FDAB0001")]))).toContain("family/product-as-base");
  });

  test("refuses a base that is also a member", () => {
    expect(
      codes(withEdges([edge("FDAB0001", "FDAB0002"), edge("FDAB0002", "FDAB0003")])),
    ).toContain("family/base-is-member");
  });

  test("refuses an unknown role", () => {
    expect(codes(withEdges([edge("FDAB0001", "FDAB0002", { role: "cousin" })]))).toContain(
      "family/unknown-role",
    );
  });

  test("refuses an unsorted file", () => {
    expect(
      codes(withEdges([edge("FDAB0001", "FDAB0003"), edge("FDAB0001", "FDAB0002")])),
    ).toContain("family/unsorted");
  });

  test("refuses a duplicate edge", () => {
    expect(
      codes(withEdges([edge("FDAB0001", "FDAB0002"), edge("FDAB0001", "FDAB0002")])),
    ).toContain("family/duplicate-edge");
  });

  test("refuses a line that is not JSON", () => {
    expect(codes(withEdges(["{not json"]))).toContain("family/malformed");
  });
});
