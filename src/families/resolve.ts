import {
  binomialOf,
  familyKey,
  nameTokens,
  stripFormWord,
  withoutChirality,
} from "./forms.ts";
import { compareText } from "./format.ts";

/**
 * Turns a name into a record.
 *
 * In order, first hit wins: a reviewed alias, an exact name or alias under `familyKey`,
 * the same without a leading `l-`, `d-` or `dl-`, then the form rule. Anything else is
 * unresolved and counted, because the fix for a miss is a reviewed alias rather than a
 * looser matcher.
 */

export type BaseRecord = {
  id: string;
  /** Lower sorts first: compound, then ingredient, then food. */
  order: number;
  name: string;
  aliases: string[];
};

type Candidate = { id: string; order: number; isName: boolean };

export type NameIndex = Map<string, Candidate[]>;

export const RECORD_ORDER: Record<string, number> = {
  compound: 0,
  drug_ingredient: 1,
  supplement_ingredient: 2,
  food: 3,
};

export const buildNameIndex = (records: readonly BaseRecord[]): NameIndex => {
  const index: NameIndex = new Map();
  const add = (name: string, candidate: Candidate): void => {
    const key = familyKey(name);
    if (!key) return;
    const held = index.get(key);
    if (held) held.push(candidate);
    else index.set(key, [candidate]);
  };
  for (const { id, order, name, aliases } of records) {
    add(name, { id, order, isName: true });
    for (const alias of aliases) add(alias, { id, order, isName: false });
  }
  return index;
};

/** The one record a key means: a real name beats an alias, then the record order. */
const pick = (
  candidates: readonly Candidate[] | undefined,
  excluded: string | null,
): string | null => {
  const allowed = candidates?.filter(({ id }) => id !== excluded) ?? [];
  const [best] = [...allowed].sort(
    (left, right) =>
      Number(right.isName) - Number(left.isName) ||
      left.order - right.order ||
      compareText(left.id, right.id),
  );
  return best?.id ?? null;
};

export type Resolution =
  | { id: string; via: "alias" | "exact" | "chirality" | "form" | "binomial" }
  | { id: null; held: boolean };

export const resolveName = (
  name: string,
  index: NameIndex,
  aliases: ReadonlyMap<string, string>,
  excluded: string | null = null,
): Resolution => {
  const key = familyKey(name);
  const reviewed = aliases.get(key);
  if (reviewed) return { id: reviewed, via: "alias" };

  const exact = pick(index.get(key), excluded);
  if (exact) return { id: exact, via: "exact" };

  const tokens = nameTokens(name);
  const bare = withoutChirality(tokens);
  if (bare) {
    const stripped = pick(index.get(bare.join("")), excluded);
    if (stripped) return { id: stripped, via: "chirality" };
  }

  const stripped = stripFormWord(tokens);
  if (stripped) {
    if (stripped.ambiguous) return { id: null, held: true };
    const stem = resolveName(stripped.stem.join(" "), index, aliases, excluded);
    if (stem.id) return { id: stem.id, via: "form" };
  }

  const whole = pick(index.get(`${tokens.join("")}whole`), excluded);
  if (tokens.length === 2 && whole) return { id: whole, via: "binomial" };

  return { id: null, held: false };
};

/** The `<genus> <species> whole` record a plant part groups under, or `null`. */
export const plantBaseOf = (
  name: string,
  index: NameIndex,
  excluded: string,
): string | null => {
  const binomial = binomialOf(nameTokens(name));
  return binomial
    ? pick(index.get(`${binomial.join("")}whole`), excluded)
    : null;
};
