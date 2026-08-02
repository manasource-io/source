#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  checkCorpusFormatting,
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

const [command, rootArgument = ".", ...extraArguments] = process.argv.slice(2);
if (!command || extraArguments.length > 0) usage();

const root = resolve(rootArgument);
if (command === "validate") {
  const result = validateCorpus(root);
  printDiagnostics(result.diagnostics);
  if (!result.ok) {
    console.error(`Corpus validation failed with ${result.diagnostics.length} error(s).`);
    process.exit(1);
  }
  console.log(`Corpus validation passed (${result.filesChecked} file(s) checked).`);
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
