/**
 * The closed vocabulary that groups records by name.
 *
 * A form rule only groups records. A curated page still attaches only through a
 * reviewed link, so a name can never promote a record into evidence (D5).
 */

const COMBINING_MARKS = /\p{M}+/gu;

/** Folds case, accents and punctuation, so `4-(Aminobutyl)guanidine` meets its peers. */
export const familyKey = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

export const nameTokens = (name: string): string[] =>
  (name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []) as string[];

const CHIRALITY_MARKS: ReadonlySet<string> = new Set(["l", "d", "dl"]);

/** The tokens without a leading `l-`, `d-` or `dl-`, or `null` when there is none. */
export const withoutChirality = (tokens: readonly string[]): string[] | null => {
  const [mark, ...rest] = tokens;
  return mark && CHIRALITY_MARKS.has(mark) && rest.length > 0 ? rest : null;
};

const SINGLE_FORM_WORDS: ReadonlySet<string> = new Set([
  "hydrochloride",
  "hcl",
  "dihydrochloride",
  "hydrobromide",
  "sulfate",
  "sulphate",
  "bisulfate",
  "citrate",
  "malate",
  "fumarate",
  "tartrate",
  "bitartrate",
  "succinate",
  "lactate",
  "gluconate",
  "glycinate",
  "bisglycinate",
  "diglycinate",
  "acetate",
  "phosphate",
  "chloride",
  "oxide",
  "carbonate",
  "bicarbonate",
  "nitrate",
  "orotate",
  "taurate",
  "threonate",
  "aspartate",
  "picolinate",
  "silicate",
  "monohydrate",
  "dihydrate",
  "trihydrate",
  "hydrate",
  "hemihydrate",
  "anhydrous",
  "mesylate",
  "maleate",
  "besylate",
  "tosylate",
  "akg",
  "sodium",
  "potassium",
  "calcium",
  "magnesium",
  "zinc",
]);

/** A mineral can be either side of a name, so `Calcium Magnesium` names no base. */
const ION_WORDS: ReadonlySet<string> = new Set([
  "sodium",
  "potassium",
  "calcium",
  "magnesium",
  "zinc",
]);

const DOUBLE_FORM_WORDS: ReadonlySet<string> = new Set([
  "ethyl ester",
  "methyl ester",
  "alpha ketoglutarate",
]);

export type StrippedForm = {
  stem: string[];
  /** Both sides are minerals, so which is the base cannot be read from the name. */
  ambiguous: boolean;
};

/** Drops one trailing form word, or returns `null` when the name does not end in one. */
export const stripFormWord = (tokens: readonly string[]): StrippedForm | null => {
  if (tokens.length >= 3) {
    const tail = tokens.slice(-2).join(" ");
    if (DOUBLE_FORM_WORDS.has(tail)) {
      return { stem: tokens.slice(0, -2), ambiguous: false };
    }
  }
  const last = tokens.at(-1);
  if (tokens.length < 2 || !last || !SINGLE_FORM_WORDS.has(last)) return null;
  const stem = tokens.slice(0, -1);
  return {
    stem,
    ambiguous:
      ION_WORDS.has(last) && stem.length === 1 && ION_WORDS.has(stem[0] ?? ""),
  };
};

/** Parts of a plant. `<genus> <species> <part>` groups under the binomial. */
const PLANT_PARTS: ReadonlySet<string> = new Set([
  "aerial",
  "bark",
  "berry",
  "bud",
  "bulb",
  "flower",
  "flowers",
  "fruit",
  "herb",
  "kernel",
  "leaf",
  "leaves",
  "peel",
  "pollen",
  "resin",
  "rhizome",
  "root",
  "roots",
  "seed",
  "seeds",
  "stem",
  "stems",
  "tuber",
  "whole",
]);

/** The binomial of a `<genus> <species> <part>` name, or `null`. */
export const binomialOf = (tokens: readonly string[]): string[] | null => {
  const last = tokens.at(-1);
  return tokens.length === 3 && last && PLANT_PARTS.has(last)
    ? tokens.slice(0, 2)
    : null;
};

const MATERIAL_PARTS: ReadonlySet<string> = new Set([
  ...PLANT_PARTS,
  "whole cell",
  "whole plant",
]);

/**
 * Whether Health Canada's `source_material` names a form people buy, rather than the
 * part of a plant it came from. Plant rows carry `Leaf`, `Rhizome` or
 * `Withania somnifera - Root` there, and none of those is a form.
 */
export const isFormLabel = (material: string, ingredient: string): boolean => {
  const trimmed = material.trim();
  if (!trimmed || trimmed.includes(" - ")) return false;
  if (familyKey(trimmed) === familyKey(ingredient)) return false;
  return !MATERIAL_PARTS.has(nameTokens(trimmed).join(" "));
};
