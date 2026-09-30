#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { formatYaml } from "../src/corpus.ts";

export interface SeedTrackableResult {
  falseCount: number;
  trueCount: number;
  written: string[];
}

function resourceYamlPaths(resourcesRoot: string): string[] {
  if (!existsSync(resourcesRoot)) {
    throw new Error(`Resources directory does not exist: ${resourcesRoot}`);
  }

  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".yaml")) paths.push(path);
    }
  };
  visit(resourcesRoot);
  return paths;
}

export function seedTrackable(corpusRoot: string): SeedTrackableResult {
  const root = resolve(corpusRoot);
  const resourcesRoot = resolve(root, "resources");
  const result: SeedTrackableResult = { falseCount: 0, trueCount: 0, written: [] };

  for (const yamlPath of resourceYamlPaths(resourcesRoot)) {
    const relativePath = relative(root, yamlPath).split(sep).join("/");
    const entity = parse(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
    const hasBody = existsSync(yamlPath.replace(/\.yaml$/, ".md"));
    const underExercise = relativePath.startsWith("resources/exercise/");
    const trackable = hasBody && !underExercise;
    entity.trackable = trackable;
    const formatted = formatYaml(entity);

    if (trackable) result.trueCount += 1;
    else result.falseCount += 1;
    if (readFileSync(yamlPath, "utf8") === formatted) continue;
    writeFileSync(yamlPath, formatted, "utf8");
    result.written.push(relativePath);
  }

  return result;
}

if (import.meta.main) {
  const [rootArgument = ".", ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0) {
    console.error("Usage: bun run scripts/resources-seed-trackable.ts [corpus-root]");
    process.exit(2);
  }
  const result = seedTrackable(rootArgument);
  console.log(
    `Seeded ${result.trueCount} trackable and ${result.falseCount} untrackable resource(s); wrote ${result.written.length} file(s).`,
  );
}
