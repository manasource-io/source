#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

/**
 * Mints the typed ID for a new resource, by the rule in
 * `resource-migration-report.md`:
 *
 *   digest = SHA-256("manasource/resource/" + source_slug)
 *   suffix = the first 30 bits of the digest, as six Crockford Base32 characters
 *   id     = <prefix for the section> + suffix
 *
 * A taken ID re-hashes as `<source_slug>#<n>`. IDs are immutable, so this only ever
 * runs once for a page: a later rename keeps the ID it already has.
 *
 *   bun run resources:new <section> <slug> [corpus-root]
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const SECTION_PREFIXES: Readonly<Record<string, string>> = {
  abstinence: "AB",
  circadian: "CI",
  exercise: "EX",
  habits: "HB",
  nutrition: "DT",
  restoration: "RS",
  wellbeing: "WB",
};

const suffixOf = (input: string): string => {
  const digest = createHash("sha256").update(`manasource/resource/${input}`).digest();
  const bits = [...digest.subarray(0, 4)]
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("")
    .slice(0, 30);
  return (bits.match(/.{5}/g) ?? [])
    .map((chunk) => CROCKFORD[Number.parseInt(chunk, 2)])
    .join("");
};

const takenIds = (root: string): Set<string> => {
  const directory = resolve(root, "resources");
  if (!existsSync(directory)) return new Set();
  const ids = readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map(
      (entry) =>
        (parse(readFileSync(join(entry.parentPath, entry.name), "utf8")) as { id: string })
          .id,
    );
  return new Set(ids);
};

export const mintResourceId = (
  section: string,
  slug: string,
  taken: ReadonlySet<string> = new Set(),
): string => {
  const prefix = SECTION_PREFIXES[section.split("/")[0] ?? ""];
  if (!prefix) throw new Error(`No ID prefix is registered for section ${section}.`);

  const sourceSlug = `${section}:${slug}`;
  for (let attempt = 0; ; attempt += 1) {
    const input = attempt === 0 ? sourceSlug : `${sourceSlug}#${attempt}`;
    const id = `${prefix}${suffixOf(input)}`;
    if (!taken.has(id)) return id;
  }
};

if (import.meta.main) {
  const [section, slug, root = "."] = process.argv.slice(2);
  if (!section || !slug) {
    console.error("Usage: bun run resources:new <section> <slug> [corpus-root]");
    process.exit(2);
  }
  const path = resolve(root, "resources", section, `${slug}.yaml`);
  if (existsSync(path)) {
    console.error(`${path} already exists, and an ID is minted only once.`);
    process.exit(1);
  }
  console.log(mintResourceId(section, slug, takenIds(root)));
}
