#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  WIKIDATA_SPARQL_ENDPOINT,
  WikidataAcquisitionError,
  acquireWikidataSnapshot,
} from "../src/wikidata/acquire.ts";

function usage(): never {
  console.error(
    "Usage: bun run records:acquire:wikidata --out <directory> --retrieved-at <ISO-instant> " +
      "[--corpus <corpus-root>] [--endpoint <url>] [--batch-size <identifiers>]",
  );
  process.exit(2);
}

const options = new Map<string, string>();
const arguments_ = process.argv.slice(2);
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index];
  const value = arguments_[index + 1];
  if (
    key === undefined ||
    value === undefined ||
    !["--out", "--retrieved-at", "--corpus", "--endpoint", "--batch-size"].includes(key) ||
    options.has(key)
  ) {
    usage();
  }
  options.set(key, value);
}

const directory = options.get("--out");
const retrievedAt = options.get("--retrieved-at");
if (directory === undefined || retrievedAt === undefined) usage();

const batchSizeText = options.get("--batch-size") ?? "500";
if (!/^\d+$/.test(batchSizeText)) usage();
const batchSize = Number(batchSizeText);

try {
  const snapshot = await acquireWikidataSnapshot({
    directory: resolve(directory),
    retrievedAt,
    corpusRoot: resolve(options.get("--corpus") ?? resolve(import.meta.dir, "..")),
    endpoint: options.get("--endpoint") ?? WIKIDATA_SPARQL_ENDPOINT,
    batchSize,
    onProgress: (message) => console.log(message),
  });
  console.log(`result ${snapshot.resultPath}`);
  console.log(`receipt ${snapshot.receiptPath}`);
} catch (error) {
  if (error instanceof WikidataAcquisitionError) {
    console.error(`${error.name}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
