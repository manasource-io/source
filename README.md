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
├── reports/<source>/<batch-id>-<kind>.json   # durable import audit trail
├── schemas/                         # Draft 2020-12 JSON Schemas
├── scripts/                         # importers
└── src/                             # build-time validation and formatting
```

Only the first four are corpus directories: validation reads `resources/`,
`masteries/`, `records/` and `manifests/`, and everything else is tooling or
audit trail. Reports sit outside the corpus on purpose — they describe an
import rather than being content — but they are committed, because provenance
that only survives in a file the reader does not have is not provenance.

Every entity YAML has `schema_version`, an immutable typed `id`, `kind`,
`entity_type`, `slug`, `title`, `lifecycle`, authoritative `identifiers`, and
typed cross-entity `links`. Each kind then adds its own data:

- Resources require `provenance`, `category`, `description`, `associations`,
  `claims`, and `references`, plus `score` once `lifecycle` leaves `draft`.
  Claims keep the existing 30–80 character `label`; references use `url`,
  `title`, and `date`. Optional local reference IDs and claim citations may be
  added when the source data actually contains that relationship. An association
  may likewise carry a non-empty, duplicate-free `claims` list of claim IDs from
  that same resource; validation rejects IDs that do not resolve locally.
  Optional `sub_category`, `components`, `input_type`, and `pairing` carry the
  curated taxonomy, tracking input, and pairing notes.
- Masteries require `provenance`, `description`, and an `associations` list of
  canonical slugs; `nav_label` and an absolute-path `href` are optional.
- Imported records require `canonical_name`, `normalized_name`, and at least
  one attributed `sources` row. One YAML file contains one record. Records may
  also carry an optional `facts` list of independently attributed reference
  facts. The first supported kind is `dose_range`, with explicit non-negative
  `minimum` and `maximum` bounds and a controlled unit (`mcg`, `mg`, `g`, `mL`,
  or `IU`). Every fact repeats the complete source namespace, source record ID,
  HTTPS URL, and attribution; it never points positionally into `sources`.
  Facts remain identity/reference data only: they are not claims, evidence
  scores, associations, rankings, or grades, and promotion to a curated
  resource is the only path into evidence.

Markdown is optional narrative body. If present, it must not contain YAML
frontmatter; Markdown without a same-stem YAML peer is invalid. See
[`schemas/`](./schemas/) and [`tests/fixtures/valid/`](./tests/fixtures/valid/)
for the exact contracts and complete examples.

Import manifests are batch metadata, not multi-record shards. Their safe path
`source` is distinct from `source_namespace`: the namespace must match source
rows on every listed record. They preserve importer and normalization versions,
record/source counts, quarantine reason counts, retrieval metadata, and the
imported record IDs. Each imported record still has its own YAML entity file.

### Imported reference facts

Records may carry attributed reference facts. The one supported kind is
`dose_range`, and the batch that populates it is Health Canada's **Licensed
Natural Health Products Database (LNHPD)**, imported under
`manifests/hc-lnhpd/`. A dose range is what a licence holder stated on a
licensed product, reproduced with the citation and attribution it came with. It
is not a recommendation, an intake target, an upper limit or an evidence claim,
and nothing on this path reaches an evidence score, grade, ranking, association
or app mechanic — promotion to a curated resource remains the only route into
evidence.

The batch publishes exactly the licensed products carrying at least one dose row
stated in a unit the fact vocabulary holds. Products whose dose is counted in
capsules, tablets or drops are held rather than published as records asserting
nothing, and every held row is counted under a stated reason in the manifest and
the quarantine report. LNHPD's `medicinalingredient` and `productrisk` datasets
were not acquired, so this corpus claims nothing about ingredient content,
potency or risk statements.

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
bun run corpus:validate
bun run corpus:format:check
bun run corpus:format
```

Importers live in [`scripts/`](./scripts/). Each separates acquisition from
import, so a re-import is a function of a snapshot on disk rather than of
whatever the upstream feed served while it ran:

```sh
bun run records:import:lnhpd acquire <snapshot-dir>
bun run records:import:lnhpd plan   <snapshot-dir> [corpus-root]
bun run records:import:lnhpd import <snapshot-dir> [corpus-root]
```

`acquire` downloads Health Canada's bulk datasets, proves each transfer whole
against the `content-length` its own response declared, and writes the bytes
plus a receipt recording the URL, the instant served, the byte count and a
SHA-256 digest. `plan` reports exactly what an import would change; `import`
writes it. Snapshots are transient and are not committed — the acquisition
report records which bytes produced the corpus, so anyone can repeat the
download and check the digests. Re-running `import` over the corpus it produced
writes nothing at all.

Every command defaults to the repository root, so they cover the whole corpus.
Pass an explicit root (for example `bun run corpus:validate -- tests/fixtures/valid`)
to check a subset.

Validation is deterministic and reports all diagnostics in path order. It
rejects schema and unknown-field errors, duplicate IDs and identifiers, typed
ID/domain mismatches, malformed URLs and dates, unsafe or mismatched paths,
incorrect record shards, broken links, exercise resources outside the four
published types, pairing/frontmatter errors, and non-canonical YAML.
`corpus:format` rewrites YAML deterministically; `corpus:format:check` is
read-only.

### Curated resource identifiers

Every curated resource carries a section-qualified `source_slug`
(`<section-path>:<slug>`, for example `nutrition/food:tomatoes`) that stays
unique when a stem repeats across sections. Resources migrated off Markdown
frontmatter also carry the `legacy_code` they were authored under; a resource
authored after that migration has no legacy code and carries `source_slug`
alone. Typed IDs are derived once from the `source_slug` and are immutable
thereafter. See
[`resource-migration-report.md`](./resource-migration-report.md) for the
derivation rule and the record of the one-time migration off Markdown
frontmatter.

### Published exercise types

`resources/exercise/` publishes exercise as evidence **types**, not as an
activity list. There are exactly four, and validation rejects any other slug
under that section:

| Resource | Path slug | Typed ID |
|---|---|---|
| Aerobic / Endurance | `aerobic-exercise` | `EX1V3KF3` |
| Strength / Resistance | `strength-training` | `EX309HCG` |
| Mobility / Flexibility | `stretching` | `EX01Y5Z7` |
| Balance / Coordination | `balance-coordination` | `EX68YE08` |

Named sports, activities, movements, equipment, routines, protocols, and
non-exercise exposures such as sauna or infrared light are **app-owned log
targets**, not corpus resources. The app owns that catalog of named targets
outright: it may group genuine exercises under one of these broad types where
that grouping is honest, and it may keep a protocol, exposure, or piece of
equipment as an app-only target with no public resource and no forced mapping
onto an exercise type. Source owns only the type-level evidence. A named
activity therefore never earns a resource here, and this repository publishes no
compatibility alias or redirect stub for one.

The path slugs and typed IDs above are immutable public interfaces, so three of
them keep the slug they were authored under rather than one matching their
current title. A type with no curated evidence publishes empty `claims`,
`references`, and `associations` and `score: 0`: evidence is recorded only where
a resource-local reference supports the statement for the whole class, never by
generalizing a result for one named activity into its type.

## Repository contract

- This repository, not Supabase, is canonical storage for the product corpus.
- YAML is an authoring/build input, never a request-time data format.
- Entity paths, typed IDs, and the `master` branch are public interfaces.
- Changes must pass the tests, typecheck, full-root validation, and the
  canonical format check.

## License

Corpus data is licensed under
**[Creative Commons Attribution-ShareAlike 4.0 International](./LICENSE)**
(CC BY-SA 4.0). You may share and adapt it, including commercially, provided
you give appropriate credit and license adaptations under the same terms.

Imported records additionally carry the terms of the dataset they came from, on
every source row and in their manifest's `license` and `notice`. Health Canada
LNHPD content is used under the
**[Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada)**,
which requires that the Information be attributed, that modifications be
declared, and that no endorsement be implied. The LNHPD manifest states which
modifications this repository made; the records are not an official version of
the Information, and neither Health Canada nor the Government of Canada endorses
them.

## Downstream consumption

The Manasource web build treats this repository as a versioned build input. It
materializes deterministic summary, search, and detail artifacts from a pinned
ref instead of reading a working copy or parsing authoring YAML at request time.
The source repository and ref are selected with `SOURCE_REPOSITORY` and
`SOURCE_REF`.

## Contributing

Proposing an entity, challenging a claim, or adding a reference? See
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
