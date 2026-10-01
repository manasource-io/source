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
      "[--endpoint <url>] [--page-size <rows>]",
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
    !["--out", "--retrieved-at", "--endpoint", "--page-size"].includes(key) ||
    options.has(key)
  ) {
    usage();
  }
  options.set(key, value);
}

const directory = options.get("--out");
const retrievedAt = options.get("--retrieved-at");
if (directory === undefined || retrievedAt === undefined) usage();

const pageSizeText = options.get("--page-size") ?? "10000";
if (!/^\d+$/.test(pageSizeText)) usage();
const pageSize = Number(pageSizeText);

try {
  const snapshot = await acquireWikidataSnapshot({
    directory: resolve(directory),
    retrievedAt,
    endpoint: options.get("--endpoint") ?? WIKIDATA_SPARQL_ENDPOINT,
    pageSize,
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
