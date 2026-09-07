#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  checkCorpusFormatting,
  EVIDENCE_INTEGRITY_SUSPENDED,
  formatCorpus,
  type Diagnostic,
  validateCorpus,
} from "./corpus.ts";

function usage(): never {
  console.error("Usage: bun run src/cli.ts <validate|format|format-check> [corpus-root]");
  process.exit(2);
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    console.error(`${diagnostic.path} [${diagnostic.code}] ${diagnostic.message}`);
  }
}

/**
 * Evidence-integrity findings still print while the suspension holds, so the
 * planned accuracy pass inherits a list rather than a silence.
 */
function printWarnings(warnings: Diagnostic[]): void {
  if (warnings.length === 0) return;
  for (const warning of warnings) {
    console.warn(`${warning.path} [${warning.code}] ${warning.message} (evidence-integrity: not enforced)`);
  }
  console.warn(
    `${warnings.length} evidence-integrity finding(s) reported but not enforced; see docs/specs/evidence-integrity-suspension.md in the monorepo.`,
  );
}

const [command, rootArgument = ".", ...extraArguments] = process.argv.slice(2);
if (!command || extraArguments.length > 0) usage();

const root = resolve(rootArgument);
if (command === "validate") {
  const result = validateCorpus(root);
  printDiagnostics(result.diagnostics);
  printWarnings(result.warnings);
  if (!result.ok) {
    console.error(`Corpus validation failed with ${result.diagnostics.length} error(s).`);
    process.exit(1);
  }
  const suspensionNote = EVIDENCE_INTEGRITY_SUSPENDED
    ? ` Evidence integrity is suspended: ${result.warnings.length} finding(s) reported, none enforced.`
    : "";
  console.log(`Corpus validation passed (${result.filesChecked} file(s) checked).${suspensionNote}`);
} else if (command === "format-check") {
  const result = checkCorpusFormatting(root);
  printDiagnostics(result.diagnostics);
  if (!result.ok) {
    console.error(`Corpus format check failed with ${result.diagnostics.length} error(s).`);
    process.exit(1);
  }
  console.log(`Corpus format check passed (${result.filesChecked} YAML file(s) checked).`);
} else if (command === "format") {
  const result = formatCorpus(root);
  printDiagnostics(result.diagnostics);
  if (!result.ok) {
    console.error(`Corpus format failed with ${result.diagnostics.length} error(s).`);
    process.exit(1);
  }
  console.log(`Formatted ${result.filesFormatted} of ${result.filesChecked} YAML file(s).`);
} else {
  usage();
}
