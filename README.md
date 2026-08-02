# manasource / source

The open, evidence-backed content corpus behind
**[manasource.io](https://manasource.io)**.

Every food, supplement, exercise, and habit that Manasource scores earns its
place from published research—not opinion or marketing. This repository is the
canonical product corpus: inspectable, challengeable, and revised as the
science changes. Consumers compile a pinned repository revision into static
artifacts; they do not parse YAML on request.

## Corpus layout

Each logical entity has exactly one YAML file. An entity may also have a
same-directory, same-stem Markdown file containing narrative body only.

```text
source/
├── resources/<section>[/<section>...]/<slug>.yaml
├── masteries/<group>/<slug>.yaml
├── records/<record_type>/<id-shard>/<id>.yaml
├── manifests/<source>/<batch-id>.yaml
├── schemas/                         # Draft 2020-12 JSON Schemas
└── src/                             # build-time validation and formatting
```

Every entity YAML has `schema_version`, an immutable typed `id`, `kind`,
`entity_type`, `slug`, `title`, `lifecycle`, authoritative `identifiers`, and
typed cross-entity `links`. Each kind then adds its own data:

- Resources require `provenance`, `category`, `description`, `score`,
  `associations`, `claims`, and `references`. Claims keep the existing 30–80
  character `label`; references use `url`, `title`, and `date`. Optional local
  reference IDs and claim citations may be added when the source data actually
  contains that relationship.
- Masteries require `provenance`, `description`, and an `associations` list of
  canonical slugs; `nav_label` and an absolute-path `href` are optional.
- Imported records require `canonical_name`, `normalized_name`, and at least
  one attributed `sources` row. One YAML file contains one record.

Markdown is optional narrative body. If present, it must not contain YAML
frontmatter; Markdown without a same-stem YAML peer is invalid. See
[`schemas/`](./schemas/) and [`tests/fixtures/valid/`](./tests/fixtures/valid/)
for the exact contracts and complete examples.

Import manifests are batch metadata, not multi-record shards. Their safe path
`source` is distinct from `source_namespace`: the namespace must match source
rows on every listed record. They preserve importer and normalization versions,
record/source counts, quarantine reason counts, retrieval metadata, and the
imported record IDs. Each imported record still has its own YAML entity file.

## Typed IDs

Entity IDs are eight uppercase characters: a registered two-character prefix
plus six Crockford Base32 characters from
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`.

| Domain | Entity type | Prefix |
|---|---|---|
| record | `supplement_ingredient` | `SI` |
| record | `supplement_product` | `SP` |
| record | `food` | `FD` |
| record | `drug_ingredient` | `DI` |
| record | `precise_ingredient` | `PI` |
| record | `compound` | `CP` |
| curated | `exercise` | `EX` |
| curated | `habit` | `HB` |
| curated | `restoration` | `RS` |
| curated | `circadian` | `CI` |
| curated | `wellbeing` | `WB` |
| curated | `abstinence` | `AB` |
| curated | `diet` | `DT` |
| curated | `app_synthetic` | `XA` |

The record shard is the first two characters of the six-character suffix. For
example, `FDAB0001` belongs under `records/food/AB/FDAB0001.yaml`.

## Tooling

Install dependencies once with `bun install --frozen-lockfile`, then use:

```sh
bun test
bun run typecheck
bun run corpus:validate -- tests/fixtures/valid
bun run corpus:format:check -- tests/fixtures/valid
bun run corpus:format -- <corpus-root>
```

Validation is deterministic and reports all diagnostics in path order. It
rejects schema and unknown-field errors, duplicate IDs and identifiers, typed
ID/domain mismatches, malformed URLs and dates, unsafe or mismatched paths,
incorrect record shards, broken links, pairing/frontmatter errors, and
non-canonical YAML. `corpus:format` rewrites YAML deterministically;
`corpus:format:check` is read-only. After migration, validate the whole corpus
with `bun run corpus:validate -- .`.

### Temporary migration state

The 117 resource pages currently on `master` use the legacy Markdown-only
frontmatter format. Their one-entity YAML migration is deliberately separate
work. Until it lands, full-root validation correctly fails with
`pairing/orphan-markdown` diagnostics. The focused tests and valid fixture are
the passing gate for the schema/tooling change; do not add placeholder YAML or
silence the orphan diagnostics.

## Repository contract

- This repository, not Supabase, is canonical storage for the product corpus.
- YAML is an authoring/build input, never a request-time data format.
- Entity paths, typed IDs, and the `master` branch are public interfaces.
- Changes must pass the tests, typecheck, validation, and canonical format
  check appropriate to their migration stage.

## License

Corpus data is licensed under
**[Creative Commons Attribution-ShareAlike 4.0 International](./LICENSE)**
(CC BY-SA 4.0). You may share and adapt it, including commercially, provided
you give appropriate credit and license adaptations under the same terms.

## Downstream consumption

The Manasource web build treats this repository as a versioned build input. It
materializes deterministic summary, search, and detail artifacts from a pinned
ref instead of reading a working copy or parsing authoring YAML at request time.
The source repository and ref are selected with `SOURCE_REPOSITORY` and
`SOURCE_REF`.

## Contributing

Proposing an entity, challenging a claim, or adding a reference? See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
