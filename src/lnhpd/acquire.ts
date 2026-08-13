import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LNHPD_API_BASE,
  LNHPD_DATASETS,
  LnhpdImportError,
} from "./format.ts";
import type { LnhpdDataset } from "./format.ts";
import { LNHPD_ACQUISITION_CONTRACT } from "./read.ts";
import type { LnhpdAcquiredDataset, LnhpdAcquisition } from "./read.ts";

/**
 * The only part of this importer that touches the network, kept apart from
 * every part that decides what gets published.
 *
 * It downloads each bulk dataset once, proves the transfer was whole, writes the
 * bytes to a snapshot directory and writes a receipt naming what it did. Nothing
 * downstream fetches anything: `read.ts` re-verifies the snapshot against the
 * receipt and refuses a file that has changed since, so an import is a function
 * of a snapshot on disk rather than of whatever the feed happened to serve while
 * it ran.
 *
 * **The snapshot is transient by design.** It is 221 MB of Health Canada's data
 * and it does not belong in this repository; what belongs here is the corpus it
 * produces plus the acquisition report that says exactly which bytes produced
 * it. Anyone can repeat the download from the URLs and instants the report
 * records and check the digests.
 *
 * **Wholeness is proven, not assumed.** The bulk endpoints publish a plain JSON
 * array with no pagination block, so there are no page counts to reconcile.
 * Instead the response must be a 200, must declare a `content-length`, and must
 * deliver exactly that many bytes; a short read is refused here and would fail
 * again in `read.ts` when the body did not parse.
 */

export const datasetUrl = (dataset: LnhpdDataset): string =>
  `${LNHPD_API_BASE}/${dataset}/?lang=en&type=json`;

export type AcquireOptions = {
  directory: string;
  datasets?: readonly LnhpdDataset[];
  fetchImplementation?: typeof fetch;
  onProgress?: (message: string) => void;
};

const rowCountOf = (text: string, dataset: LnhpdDataset): number => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LnhpdImportError(
      `The ${dataset} download is not valid JSON: ${(error as Error).message}. ` +
        `That is what a truncated transfer looks like, so the snapshot is refused.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new LnhpdImportError(
      `The ${dataset} download is not the JSON array the bulk endpoint returns.`,
    );
  }
  if (parsed.length === 0) {
    throw new LnhpdImportError(`The ${dataset} download carries no rows.`);
  }
  return parsed.length;
};

export const acquireLnhpdSnapshot = async ({
  directory,
  datasets = LNHPD_DATASETS,
  fetchImplementation = fetch,
  onProgress = () => {},
}: AcquireOptions): Promise<LnhpdAcquisition> => {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });

  const acquired: LnhpdAcquiredDataset[] = [];
  for (const dataset of datasets) {
    const url = datasetUrl(dataset);
    onProgress(`fetching ${url}`);
    // `identity` on purpose. Offered a compressed encoding, Health Canada sends
    // a `content-length` describing the *compressed* body, which a client that
    // transparently decompresses then drops — leaving nothing to check the
    // transfer against. Asking for the bytes uncompressed makes the declared
    // length the length of what must arrive, which is the whole point of the
    // check.
    const response = await fetchImplementation(url, {
      headers: { "accept-encoding": "identity" },
    });

    if (response.status !== 200) {
      throw new LnhpdImportError(
        `${url} answered HTTP ${response.status}. Only a 200 carries a complete body.`,
      );
    }

    const encoding = response.headers.get("content-encoding");
    if (encoding !== null) {
      throw new LnhpdImportError(
        `${url} answered with content-encoding '${encoding}' despite being asked for ` +
          `identity, so its content-length describes bytes other than the body.`,
      );
    }

    const declaredHeader = response.headers.get("content-length");
    if (declaredHeader === null) {
      throw new LnhpdImportError(
        `${url} declared no content-length, so the transfer cannot be proven whole.`,
      );
    }
    const declaredBytes = Number(declaredHeader);
    if (!Number.isInteger(declaredBytes) || declaredBytes < 1) {
      throw new LnhpdImportError(
        `${url} declared content-length '${declaredHeader}', which is not a positive integer.`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== declaredBytes) {
      throw new LnhpdImportError(
        `${url} delivered ${bytes.byteLength} bytes for a declared content-length of ` +
          `${declaredBytes}, so the download is a fragment rather than the dataset.`,
      );
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const rowCount = rowCountOf(text, dataset);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = `${dataset}.json`;
    writeFileSync(resolve(root, file), bytes);

    // The response's own `date` header, not this machine's clock: the instant
    // published is when Health Canada served the bytes.
    const servedAt = new Date(
      response.headers.get("date") ?? "",
    ).toISOString();

    onProgress(
      `${dataset}: ${rowCount} rows, ${declaredBytes} bytes, sha256 ${sha256}`,
    );
    acquired.push({
      dataset,
      url,
      file,
      httpStatus: 200,
      declaredBytes,
      observedBytes: bytes.byteLength,
      sha256,
      rowCount,
      servedAt,
    });
  }

  // The batch's retrieval instant is the newest of the downloads, so it is never
  // earlier than any byte in the snapshot.
  const retrievedAt = acquired
    .map((entry) => entry.servedAt)
    .sort()
    .at(-1);
  if (retrievedAt === undefined) {
    throw new LnhpdImportError("No dataset was acquired.");
  }

  const acquisition: LnhpdAcquisition = {
    contract: LNHPD_ACQUISITION_CONTRACT,
    retrievedAt,
    datasets: acquired,
  };
  writeFileSync(
    resolve(root, "acquisition.json"),
    `${JSON.stringify(acquisition, null, 2)}\n`,
    "utf8",
  );
  return acquisition;
};
