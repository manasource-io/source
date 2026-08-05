# Curated resource migration report

One-time migration of the curated resource corpus from legacy Markdown files
with YAML frontmatter to canonical same-stem YAML + Markdown pairs (M-182).
YAML now owns every structured field; Markdown owns narrative body only.

## Counts

| Measure | Value |
|---|---|
| Legacy Markdown resources migrated | 117 |
| Canonical YAML files written | 117 |
| Markdown bodies retained | 117 |
| Orphan Markdown remaining | 0 |
| Resource paths added, removed, or renamed | 0 |
| Markdown body bytes changed | 0 |
| Claims preserved | 425 |
| References preserved | 323 |
| Associations preserved | 336 |
| Scores preserved | 108 |
| `components` lists preserved | 98 |
| `sub_category` values preserved | 40 |
| `pairing` lists preserved | 5 |
| `input_type` values preserved | 5 |
| Lifecycle `published` / `draft` | 107 / 10 |

## Section to entity type mapping

Every resource uses an already-registered curated entity type and its
registered ID prefix. No type was added to the registry.

| Section | `entity_type` | ID prefix | Resources |
|---|---|---|---|
| `resources/abstinence/` | `abstinence` | `AB` | 3 |
| `resources/circadian/` | `circadian` | `CI` | 2 |
| `resources/exercise/` | `exercise` | `EX` | 33 |
| `resources/habits/` | `habit` | `HB` | 5 |
| `resources/nutrition/diet/` | `diet` | `DT` | 4 |
| `resources/nutrition/food/` | `diet` | `DT` | 40 |
| `resources/nutrition/supplements/` | `diet` | `DT` | 25 |
| `resources/restoration/` | `restoration` | `RS` | 1 |
| `resources/wellbeing/` | `wellbeing` | `WB` | 4 |

Nutrition resources are curated editorial pages, not imported records, so they
take the curated `diet` type rather than the record-domain `food` or
`supplement_ingredient` types. Their finer taxonomy is preserved unchanged in
`category` (`food`, `drink`, `snack`, `supplement`, `diet`) and `sub_category`
(`fruit`, `vegetable`, `grain`, `legume`, `seed-nut`, `spice`, `protein`,
`juice`, `other`).

## Identifier and ID assignment rule

Each resource carries two authoritative identifiers:

- `source_slug` — `<section-path>:<slug>`, where the section path is the
  directory path below `resources/` (for example `exercise:walking`,
  `habits:walking`, `nutrition/food:tomatoes`). Section qualification keeps the
  three repeated stems (`social-connection`, `stretching`, `walking`) unique.
- `legacy_code` — the legacy frontmatter `code`, verbatim. All 117 are unique.

Typed IDs are derived deterministically from the `source_slug`:

```text
digest = SHA-256("manasource/resource/" + source_slug)
suffix = the first 30 bits of the digest, encoded as six Crockford Base32
         characters from 0123456789ABCDEFGHJKMNPQRSTVWXYZ
id     = <registered prefix for entity_type> + suffix
```

Entities are processed in `source_slug` order. If a candidate ID were already
taken, the input is re-hashed as `manasource/resource/<source_slug>#<n>` with
`n` counting up from 1 until the ID is free. No collision occurred in this
migration; all 117 IDs are unique on the first attempt. IDs are immutable from
this commit onward: rerunning the rule reproduces them exactly, but a later
path or slug change must keep the existing ID rather than re-derive one.

## Field mapping

| Legacy frontmatter | Canonical YAML |
|---|---|
| file path | unchanged path, `.yaml` peer beside the `.md` |
| filename stem | `slug` |
| `title` | `title` |
| `description` | `description` |
| `code` | `identifiers[] {kind: legacy_code}` |
| (section + slug) | `identifiers[] {kind: source_slug}` |
| `draft: true` / `draft: false` | `lifecycle: draft` / `lifecycle: published` |
| `createdAt` | `provenance.created_at` |
| `updatedAt` | `provenance.updated_at` |
| — | `provenance.source: Manasource editorial` |
| `category` | `category` |
| `subCategory` | `sub_category` |
| `components` | `components` |
| `score` | `score` |
| `associations` | `associations` |
| `claims` | `claims` |
| `references` | `references` |
| `inputType` | `input_type` |
| `pairing` | `pairing` |
| (section) | `entity_type` |
| — | `id`, `kind: resource`, `schema_version: 1`, `links: []` |
| body after the frontmatter fence | `<same-stem>.md`, byte-identical |

`provenance.source` is the editorial origin these curated pages already have in
this repository; it matches the value used by the committed fixtures. `links`
is empty everywhere because the legacy data contains no typed cross-entity
relationships — none were invented.

## Preserved paths and bodies

- Path stability: the 117 resource paths are byte-identical to their pre-migration
  values. `git status` reports no added, deleted, or renamed `.md` file.
- Body stability: `git diff -U0 -- 'resources/**/*.md'` reports 5,935 deleted
  lines and **zero inserted lines** across all 117 files. The only change to any
  Markdown file is removal of the frontmatter block; every narrative byte after
  the closing fence is untouched.
- Claim anchors: all 425 claim IDs still resolve to a `{#claim-id}` heading
  anchor in their paired Markdown body. Four narrative-only anchors
  (`avocado:gut-microbiome`, `tomatoes:cooking-pairing`,
  `turmeric:bioavailability`, `creatine:aging`) have no claim, as before.
- Value stability: a field-by-field parity check compared every migrated YAML
  value against the captured pre-migration frontmatter. All titles, slugs,
  categories, sub-categories, components, scores, associations, claims (IDs and
  labels), references (URL, title, date), pairings, and input types match
  exactly. Effect size (`delta`, `benefit`) and evidence strength (`trust`) stay
  in their existing separate association fields; nothing was recomputed and no
  score was derived from any other value.

## Intentional corrections

Every deviation from the legacy bytes is listed here. There are three kinds,
covering ten resources.

### 1. Non-date `updatedAt` normalised to a date (1 resource)

`provenance.updated_at` is schema-typed as a calendar date.

| Resource | Legacy `updatedAt` | Canonical `provenance.updated_at` |
|---|---|---|
| `resources/nutrition/food/red-berries` | `2026-04-11T00:00:00.000Z` | `2026-04-11` |

The instant is midnight UTC, so no information is lost. Every other resource
already carried a plain `YYYY-MM-DD` date.

### 2. Absent list fields normalised to empty lists (10 resources)

`claims` and `references` are required lists. Where the legacy frontmatter
omitted the key entirely, the canonical YAML records an empty list rather than
inventing entries.

- `claims: []` — `exercise/burpees`, `exercise/crunches`, `exercise/lunges`,
  `exercise/planks`, `exercise/pull-ups`, `exercise/push-ups`,
  `exercise/squats`, `habits/social-connection`, `nutrition/food/red-berries`.
- `references: []` — `nutrition/food/red-berries`.

### 3. `score` made conditional on lifecycle (schema change, 9 resources)

Nine legacy resources carry no `score`. All nine are `draft: true`, and a score
is an evidence-weighted efficacy rating that cannot be invented or derived from
other fields. `schemas/resource.schema.json` therefore requires `score` only
once `lifecycle` is `published` or `retired`; drafts may omit it. All 107
published resources carry their original score.

Resources migrated without a score, all `lifecycle: draft`:
`exercise/burpees`, `exercise/crunches`, `exercise/lunges`, `exercise/planks`,
`exercise/pull-ups`, `exercise/push-ups`, `exercise/squats`,
`habits/social-connection`, `nutrition/food/red-berries`.

The tenth draft, `nutrition/food/black-pepper`, has a legacy score and keeps it.

## Schema changes

`schemas/resource.schema.json` gained exactly what the legacy data needs and
nothing more. `schemas/common.schema.json` and the typed-ID registry are
unchanged.

- `score` moved out of the unconditional `required` list into an
  `if lifecycle in {published, retired} then require score` branch (see
  correction 3).
- `input_type` (optional slug) — home for legacy `inputType`, the tracking input
  a resource is logged with (`score` on four resources, `hours` on
  `nutrition/diet/fasting-period`).
- `pairing` (optional list) — home for legacy `pairing`, the curated
  combination notes on `nutrition/food/olive-oil`, `nutrition/food/tomatoes`,
  `nutrition/food/turmeric`, `nutrition/supplements/curcumin`, and
  `nutrition/supplements/vitamin-k2`. Each entry keeps its `type`, `note`, and
  optional `condition` and `resource`. The `resource` value is the legacy soft
  reference string as authored (for example `food/black-pepper`); it is
  deliberately not resolved into a typed `links` entry, because two entries name
  no resource at all and resolving the rest would mean asserting relationships
  the legacy data does not state.

Both new fields are optional, so entities that never had them are unaffected.
`tests/corpus.test.ts` covers the conditional score rule and the `input_type` /
`pairing` contract.

## Gates

`bun test`, `bun run typecheck`, `bun run corpus:validate`, and
`bun run corpus:format:check` all pass against the repository root. Full-root
validation covers 234 files with zero diagnostics; before this migration it
reported 117 `pairing/orphan-markdown` errors.
