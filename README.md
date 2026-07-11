# manasource / source

The open, evidence-backed content corpus behind **[manasource.io](https://manasource.io)**.

Every food, supplement, exercise, and habit that Manasource scores earns its
place from published research — not opinion, not marketing. This repository is
where that evidence lives in the open: inspectable, challengeable, and revised
as the science changes.

Right now this repo publishes the **resource corpus** (`resources/`). It is the
same content the app reads to build its scored library. Additional surfaces
(e.g. `masteries/`) are published from here over time; see
[Scope & roadmap](#scope--roadmap).

## Repository layout

```text
source/
├── resources/          # the publishable evidence corpus (117 markdown pages)
│   ├── abstinence/
│   ├── circadian/
│   ├── exercise/
│   ├── habits/
│   ├── nutrition/
│   │   ├── diet/
│   │   ├── food/
│   │   └── supplements/
│   ├── restoration/
│   └── wellbeing/
├── LICENSE             # CC BY-SA 4.0 — governs the data
├── README.md
└── CONTRIBUTING.md
```

Each resource is a single markdown file at:

```
resources/<section>/<slug>.md
```

`<section>` is the top-level folder (`exercise`, `restoration`, …) and `<slug>`
is the filename. **This layout is load-bearing:** the app deep-links edit and
"add a resource" buttons straight to `resources/<section>/<slug>.md` on the
`master` branch, so paths and the branch name must stay stable.

## Resource frontmatter schema

Every page carries YAML frontmatter. Fields:

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Human-readable resource name. |
| `code` | string | Short stable identifier (e.g. `RSQ1`). |
| `category` | string | Fine-grained taxonomy value (e.g. `food`, `supplement`, `strength`). Distinct from the `<section>` folder. |
| `subCategory` | string | Optional finer grouping (singular) when present. |
| `components` | list | Tags used to compose coverage (e.g. `pressing-strength`). Required for phase-1 food, supplement, and exercise resources. |
| `description` | string | One- or two-sentence summary of why the resource matters. |
| `score` | number | Overall evidence-weighted score, `0`–`10`. |
| `associations` | list | Health-domain effects — see below. |
| `claims` | list | Evidence claims — see below. |
| `references` | list | Sources backing the claims — see below. |
| `updatedAt` | date | ISO `YYYY-MM-DD` last content update. |
| `createdAt` | date | ISO `YYYY-MM-DD` first authored. |
| `draft` | boolean | `true` hides the page from the published build. |

**`associations[]`** — how the resource moves a health domain:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Health-domain id (e.g. `mortality`, `cardio-health`). |
| `delta` | number | Direction/magnitude of the effect on that domain. |
| `benefit` | number | Effect size, `0`–`5`. |
| `trust` | number | Strength of the underlying evidence, `1`–`5`. |

**`claims[]`** — the specific, checkable assertions:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable claim id, unique within the resource. |
| `label` | string | The claim itself. A **30–80 character** contract; must **not** repeat the resource name. |

**`references[]`** — sources backing the claims:

| Field | Type | Notes |
|-------|------|-------|
| `url` | string | Link to the study, review, or primary source. |
| `title` | string | Source title. |
| `date` | date | ISO `YYYY-MM-DD` publication date. |

## Repository contract

- `resources/` stays **publishable and content-focused**. It is a public
  knowledge surface — no app runtime code, no build tooling, no operational
  scratch files belong here.
- The `resources/<section>/<slug>.md` layout and the **`master`** branch name
  are part of the public interface (the app links to them). Don't rename or
  restructure without updating the consuming app.
- Content-only changes: edits should touch markdown under `resources/`.

## License

The data in this repository is licensed under
**[Creative Commons Attribution-ShareAlike 4.0 International](./LICENSE)**
(CC BY-SA 4.0). You may share and adapt it, including commercially, provided you
give appropriate credit and license your adaptations under the same terms.

If scripts or other code are ever added to this repo, they will carry their own
license note; today the repository is content-only, so CC BY-SA 4.0 covers
everything here.

## How it's consumed downstream

The Manasource web build treats this repository as a **versioned build input**.
It materializes the corpus at build time from a pinned ref rather than reading a
working copy, configured via environment variables:

- `SOURCE_REPOSITORY` — defaults to `https://github.com/manasource-io/source.git`
- `SOURCE_REF` — defaults to `master`

Because the build pins a ref, changes here don't reach production until the
consuming app bumps that ref. This keeps the published site reproducible and
lets content review happen against a specific commit or tag.

## Scope & roadmap

This repo currently publishes **resources only**. The Manasource build also
reads a sibling `masteries/` surface from the corpus root; until that content is
published here, the canonical build source remains the in-monorepo development
mirror. Publishing `masteries/` and flipping production builds to consume this
repo as the sole source are tracked as follow-up work.

## Contributing

Proposing a new resource, challenging a score, or adding a reference? See
[CONTRIBUTING.md](./CONTRIBUTING.md).
