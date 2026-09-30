import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { seedTrackable } from "../scripts/resources-seed-trackable.ts";
import { formatYaml } from "../src/corpus.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "resources-seed-trackable-"));
  roots.push(root);
  for (const path of [
    "resources/nutrition/food/apple.yaml",
    "resources/exercise/running.yaml",
    "resources/wellbeing/concept.yaml",
  ]) {
    const absolutePath = resolve(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, formatYaml({ kind: "resource", title: path }), "utf8");
  }
  writeFileSync(resolve(root, "resources/nutrition/food/apple.md"), "Apple body.\n", "utf8");
  writeFileSync(resolve(root, "resources/exercise/running.md"), "Running body.\n", "utf8");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("resource trackable seeder", () => {
  test("uses body presence outside exercise and is idempotent", () => {
    const root = fixture();
    const first = seedTrackable(root);

    expect(first).toEqual({
      falseCount: 2,
      trueCount: 1,
      written: [
        "resources/exercise/running.yaml",
        "resources/nutrition/food/apple.yaml",
        "resources/wellbeing/concept.yaml",
      ],
    });
    expect(
      parse(readFileSync(resolve(root, "resources/nutrition/food/apple.yaml"), "utf8"))
        .trackable,
    ).toBe(true);
    expect(
      parse(readFileSync(resolve(root, "resources/exercise/running.yaml"), "utf8"))
        .trackable,
    ).toBe(false);
    expect(
      parse(readFileSync(resolve(root, "resources/wellbeing/concept.yaml"), "utf8"))
        .trackable,
    ).toBe(false);

    const bytes = first.written.map((path) => readFileSync(resolve(root, path), "utf8"));
    expect(seedTrackable(root)).toEqual({ falseCount: 2, trueCount: 1, written: [] });
    expect(first.written.map((path) => readFileSync(resolve(root, path), "utf8"))).toEqual(bytes);
  });
});
