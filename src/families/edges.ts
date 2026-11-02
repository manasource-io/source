import type { IngredientRow, SubstanceRow } from "./acquire.ts";
import { familyKey, isFormLabel, stripFormWord, nameTokens } from "./forms.ts";
import { compareEdges, compareText } from "./format.ts";
import type { FamilyBasis, FamilyEdge } from "./format.ts";
import { buildNameIndex, plantBaseOf, resolveName } from "./resolve.ts";
import type { BaseRecord, NameIndex } from "./resolve.ts";

/**
 * Builds the ledger: which record is a form of which, and which products contain what.
 *
 * Forms form a tree of depth one. `Magnesium citrate dihydrate`, `Magnesium citrate`
 * and `Magnesium` all reach one base, and a base is never itself a member, so a reader
 * of the file never has to follow a chain.
 */

/** Who decided an override, and why. `corpus:validate` refuses an entry without them. */
type Decision = { note: string; decided_at: string; decided_by: string };

export type Overrides = {
  forms: ({ base: string; member: string } & Decision)[];
  /** One edge, or with no `member`, every product: a sanitizer is not a kind of alcohol. */
  rejected: ({ base: string; member?: string } & Decision)[];
  aliases: ({ name: string; base: string } & Decision)[];
  display: ({ base: string; name: string } & Decision)[];
};

export type FamilyRecord = BaseRecord & { unii: string | null };

export type ProductRecord = { id: string; lnhpdId: string; name: string };

export type FamilyInput = {
  records: readonly FamilyRecord[];
  products: readonly ProductRecord[];
  ingredients: readonly IngredientRow[];
  substances: readonly SubstanceRow[];
  overrides: Overrides;
};

export type FamilyReport = {
  counts: {
    edges: number;
    forms: number;
    products: number;
    combinations: number;
    bases: number;
  };
  coverage: {
    products: number;
    productsWithBase: number;
    productShare: number;
    ingredientNames: number;
    ingredientNamesResolved: number;
    ingredientNameShare: number;
    ingredientRowsWithoutProduct: number;
  };
  held: string[];
  topUnresolved: { name: string; products: number }[];
  topFamilies: { base: string; name: string; products: number; combinations: number }[];
};

const round = (value: number): number => Number(value.toFixed(4));

/** A salt's record names its moiety, and a word it shares marks a parent over a counterion. */
const ACTIVE_MOIETY = "ACTIVE MOIETY";
const SALT_OF_PARENT = "PARENT->SALT/SOLVATE";
const MIN_SHARED_WORD = 4;

const sharesWord = (left: string, right: string): boolean => {
  const words = new Set(nameTokens(left).filter((word) => word.length >= MIN_SHARED_WORD));
  return nameTokens(right).some((word) => words.has(word));
};

type Parent = { base: string; basis: FamilyBasis };

export const planFamilyEdges = ({
  records,
  products,
  ingredients,
  substances,
  overrides,
}: FamilyInput): { edges: FamilyEdge[]; report: FamilyReport } => {
  const index: NameIndex = buildNameIndex(records);
  const byId = new Map(records.map((record) => [record.id, record]));
  const byUnii = new Map(
    records.flatMap(({ id, unii }) => (unii ? [[unii, id] as const] : [])),
  );
  const aliases = new Map(
    overrides.aliases.map(({ name, base }) => [familyKey(name), base]),
  );
  const rejected = new Set(
    overrides.rejected.map(({ base, member }) => `${base}\0${member}`),
  );
  const refusesProducts = new Set(
    overrides.rejected.flatMap(({ base, member }) => (member ? [] : [base])),
  );
  const held: string[] = [];

  const parents = new Map<string, Parent>();
  const setParent = (member: string, base: string, basis: FamilyBasis): void => {
    if (member === base || parents.has(member)) return;
    if (rejected.has(`${base}\0${member}`)) return;
    parents.set(member, { base, basis });
  };

  for (const { base, member } of overrides.forms) setParent(member, base, "editorial");

  // Two records can carry one name, usually a compound and an ingredient, and those are
  // one substance. The better kind is the base, then the plainer spelling, so
  // `SELEGILINE` outranks `SELEGILINE, (+)-`.
  const sameName = new Map<string, FamilyRecord[]>();
  for (const record of records) {
    const key = familyKey(record.name);
    const held = sameName.get(key);
    if (held) held.push(record);
    else sameName.set(key, [record]);
  }
  for (const group of sameName.values()) {
    const [first, ...others] = [...group].sort(
      (left, right) =>
        left.order - right.order ||
        left.name.length - right.name.length ||
        compareText(left.id, right.id),
    );
    for (const { id } of others) setParent(id, first?.id ?? id, "name_rule");
  }

  for (const record of records) {
    const stripped = stripFormWord(nameTokens(record.name));
    if (!stripped) continue;
    if (stripped.ambiguous) {
      held.push(record.name);
      continue;
    }
    const stem = resolveName(stripped.stem.join(" "), index, aliases, record.id);
    if (stem.id) setParent(record.id, stem.id, "name_rule");
  }

  for (const record of records) {
    const plant = plantBaseOf(record.name, index, record.id);
    if (plant) setParent(record.id, plant, "name_rule");
  }

  // A record reads `ACTIVE MOIETY` and `PARENT->SALT/SOLVATE` as "what I am a form
  // of". The moiety wins. A salt also lists its counterion as a parent, so a parent
  // counts only when it shares a word with the salt: `CAFFEINE CITRATE` is a form of
  // caffeine, and citric acid is not its base. A moiety the corpus has no record for,
  // such as `MAGNESIUM CATION`, reaches its element through a reviewed alias.
  const nameByUnii = new Map(substances.map(({ unii, name }) => [unii, name]));
  const reach = (unii: string): string | null =>
    byUnii.get(unii) ?? aliases.get(familyKey(nameByUnii.get(unii) ?? "")) ?? null;

  for (const { unii, relationships } of substances) {
    const self = byUnii.get(unii);
    if (!self) continue;
    const name = byId.get(self)?.name ?? "";
    const moiety = relationships
      .filter(({ type }) => type === ACTIVE_MOIETY)
      .map(({ unii: related }) => reach(related))
      .find((id) => id !== null && id !== self);
    if (moiety) {
      setParent(self, moiety, "gsrs_relationship");
      continue;
    }
    for (const { type, unii: related } of relationships) {
      if (type !== SALT_OF_PARENT) continue;
      const parent = reach(related);
      if (parent && sharesWord(name, byId.get(parent)?.name ?? "")) {
        setParent(self, parent, "gsrs_relationship");
      }
    }
  }

  // Authorities can point two records at each other. A base is never also a member, so
  // the better record in a loop stops pointing anywhere and becomes its root.
  const rank = (id: string): [number, number, string] => {
    const record = byId.get(id);
    return [record?.order ?? 9, record?.name.length ?? 0, id];
  };
  const better = (left: string, right: string): number => {
    const [leftOrder, leftLength] = rank(left);
    const [rightOrder, rightLength] = rank(right);
    return leftOrder - rightOrder || leftLength - rightLength || compareText(left, right);
  };
  for (const start of [...parents.keys()]) {
    const path: string[] = [];
    let current: string | undefined = start;
    while (current && !path.includes(current)) {
      path.push(current);
      current = parents.get(current)?.base;
    }
    if (!current) continue;
    const [root] = path.slice(path.indexOf(current)).sort(better);
    if (root) parents.delete(root);
  }

  /** Follows a record to the root of its tree. */
  const baseOf = (id: string): string => {
    let current = id;
    for (;;) {
      const parent = parents.get(current);
      if (!parent) return current;
      current = parent.base;
    }
  };

  const edges = new Map<string, FamilyEdge>();
  const addEdge = (edge: FamilyEdge): void => {
    const key = `${edge.base}\0${edge.member}`;
    const held = edges.get(key);
    if (!held) edges.set(key, edge);
    else if (!held.form && edge.form) held.form = edge.form;
  };

  for (const [member, { basis }] of parents) {
    const base = baseOf(member);
    if (base !== member) addEdge({ base, member, role: "form", basis });
  }

  const productByLnhpd = new Map(products.map((each) => [each.lnhpdId, each]));
  const rowsByProduct = new Map<string, IngredientRow[]>();
  let rowsWithoutProduct = 0;
  for (const row of ingredients) {
    const product = productByLnhpd.get(String(row.lnhpd_id));
    if (!product) {
      rowsWithoutProduct += 1;
      continue;
    }
    const held = rowsByProduct.get(product.id);
    if (held) held.push(row);
    else rowsByProduct.set(product.id, [row]);
  }

  const resolutions = new Map<string, string | null>();
  const resolved = (name: string): string | null => {
    const key = familyKey(name);
    if (resolutions.has(key)) return resolutions.get(key) ?? null;
    const { id } = resolveName(name, index, aliases);
    resolutions.set(key, id);
    return id;
  };

  const unresolvedProducts = new Map<string, Set<string>>();
  const unresolvedSpelling = new Map<string, string>();
  const familyCounts = new Map<string, { products: number; combinations: number }>();
  let productsWithBase = 0;

  for (const { id: productId } of products) {
    const rows = rowsByProduct.get(productId) ?? [];
    const found = new Map<string, string | undefined>();
    let unresolved = 0;

    for (const { ingredient_name: name, source_material: material } of rows) {
      const id = resolved(name);
      if (!id) {
        unresolved += 1;
        const key = familyKey(name);
        unresolvedSpelling.set(key, unresolvedSpelling.get(key) ?? name);
        const seen = unresolvedProducts.get(key) ?? new Set<string>();
        seen.add(productId);
        unresolvedProducts.set(key, seen);
        continue;
      }
      const base = baseOf(id);
      if (refusesProducts.has(base) || rejected.has(`${base}\0${productId}`)) continue;
      const label = isFormLabel(material, name)
        ? material.trim()
        : base !== id
          ? name.trim()
          : undefined;
      found.set(base, found.get(base) ?? label);
    }

    if (found.size === 0) continue;
    productsWithBase += 1;
    const role = found.size === 1 && unresolved === 0 ? "product" : "combination";
    for (const [base, form] of found) {
      addEdge({
        base,
        member: productId,
        role,
        basis: "hc.lnhpd",
        ...(form ? { form } : {}),
      });
      const counts = familyCounts.get(base) ?? { products: 0, combinations: 0 };
      counts[role === "product" ? "products" : "combinations"] += 1;
      familyCounts.set(base, counts);
    }
  }

  const sorted = [...edges.values()].sort(compareEdges);
  const distinctNames = new Set(ingredients.map((row) => familyKey(row.ingredient_name)));
  const namesResolved = [...distinctNames].filter((key) => resolutions.get(key)).length;

  return {
    edges: sorted,
    report: {
      counts: {
        edges: sorted.length,
        forms: sorted.filter((edge) => edge.role === "form").length,
        products: sorted.filter((edge) => edge.role === "product").length,
        combinations: sorted.filter((edge) => edge.role === "combination").length,
        bases: new Set(sorted.map((edge) => edge.base)).size,
      },
      coverage: {
        products: products.length,
        productsWithBase,
        productShare: round(productsWithBase / Math.max(products.length, 1)),
        ingredientNames: distinctNames.size,
        ingredientNamesResolved: namesResolved,
        ingredientNameShare: round(namesResolved / Math.max(distinctNames.size, 1)),
        ingredientRowsWithoutProduct: rowsWithoutProduct,
      },
      held: [...new Set(held)].sort(compareText),
      topUnresolved: [...unresolvedProducts]
        .map(([key, seen]) => ({
          name: unresolvedSpelling.get(key) ?? key,
          products: seen.size,
        }))
        .sort(
          (left, right) =>
            right.products - left.products || compareText(left.name, right.name),
        )
        .slice(0, 500),
      topFamilies: [...familyCounts]
        .map(([base, counts]) => ({
          base,
          name: byId.get(base)?.name ?? base,
          ...counts,
        }))
        .sort(
          (left, right) =>
            right.products + right.combinations - left.products - left.combinations ||
            compareText(left.base, right.base),
        )
        .slice(0, 500),
    },
  };
};
