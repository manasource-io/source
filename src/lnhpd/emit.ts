import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LnhpdImportPlan, PlannedFile } from "./plan.ts";

/**
 * The half of the importer that touches a filesystem, and the only one.
 *
 * **A file is written only when its bytes would change.** That is what makes the
 * zero-write rerun provable rather than merely likely: every byte in the plan is
 * a function of the acquired snapshot and the corpus it is applied to, so
 * re-running an unchanged import over the corpus it produced compares equal on
 * every file and issues no write at all. A reviewer can check that with a
 * modification time, and CI can check it with a clean git status.
 */

export type EmitResult = {
  written: string[];
  unchanged: string[];
};

const writeIfChanged = (root: string, file: PlannedFile, result: EmitResult): void => {
  const path = resolve(root, ...file.path.split("/"));
  let existing: string | null = null;
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = null;
  }
  if (existing === file.contents) {
    result.unchanged.push(file.path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.contents, "utf8");
  result.written.push(file.path);
};

export const emitLnhpdImport = (
  corpusRoot: string,
  plan: LnhpdImportPlan,
): EmitResult => {
  const root = resolve(corpusRoot);
  const result: EmitResult = { written: [], unchanged: [] };
  for (const file of [...plan.records, plan.manifest, ...plan.reports]) {
    writeIfChanged(root, file, result);
  }
  result.written.sort();
  result.unchanged.sort();
  return result;
};

/** Every path the plan owns, for a caller that wants to diff before writing. */
export const plannedPaths = (plan: LnhpdImportPlan): string[] =>
  [...plan.records, plan.manifest, ...plan.reports].map((file) => file.path).sort();
