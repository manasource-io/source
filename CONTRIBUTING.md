# Contributing to the Manasource corpus

This repository is the open evidence base behind
**[manasource.io](https://manasource.io)**. Its value is only as good as the
evidence behind it, so contributions live and die by their sources. Whether
you're proposing a new resource, challenging a score, or adding a reference,
the bar is the same: **show the evidence.**

By contributing you agree that your contribution is licensed under
[CC BY-SA 4.0](./LICENSE), the same license as the rest of the data.

## Ways to contribute

### Propose a new resource

1. Pick the right home: `resources/<section>/<slug>.md`, where `<section>` is
   one of the existing top-level folders (`abstinence`, `circadian`,
   `exercise`, `habits`, `nutrition/{food,diet,supplements}`, `restoration`,
   `wellbeing`). Use a lowercase, hyphenated `<slug>`.
2. Copy the frontmatter shape of a nearby resource in the same section. The
   full field-by-field schema is documented in the
   [README](./README.md#resource-frontmatter-schema).
3. Every `score` and `association` must be defensible from the `references` you
   list. New pages with unsettled evidence should start with `draft: true`.
4. Open a pull request describing what the resource is and why the evidence
   supports its scoring.

The app links a **"add a resource"** button to
`https://github.com/manasource-io/source/new/master/resources/<section>` — that
lands you here with the right folder pre-selected.

### Challenge a score or an association

Scores (`0`–`10`) and association `benefit`/`trust` values are meant to be
argued about. To challenge one:

1. Open the resource's markdown file. The app's edit button deep-links to
   `https://github.com/manasource-io/source/edit/master/resources/<section>/<slug>.md`.
2. Propose the new value **and** cite the evidence that justifies it. A score
   change without a supporting reference will be closed.
3. Prefer the stronger, more recent, or higher-quality evidence. `trust`
   (`1`–`5`) should reflect study quality, not how much you like the result.

### Add or improve a reference

Good references are the backbone of the corpus. Each entry needs:

- `url` — a link to the study, systematic review, or primary source
  (prefer PubMed / PMC / DOI links or reputable evidence aggregators).
- `title` — the source's actual title.
- `date` — the publication date, `YYYY-MM-DD`.

Adding a reference that strengthens (or honestly weakens) an existing claim is
always welcome.

## Content standards

- **Claims are a contract.** Each `claims[].label` must be **30–80 characters**
  and must **not** repeat the resource's own name. Keep them specific and
  checkable ("Optimal 7–8hrs reduces mortality…"), not vague ("is good for
  you").
- **Evidence over opinion.** The project curates for correctness, not
  completeness. If the evidence is weak or mixed, say so in the scoring and the
  claims rather than overstating it.
- **Content only.** Changes should touch markdown under `resources/`. This repo
  deliberately holds no app code or build tooling.
- **Stable paths.** Don't rename or move files without reason — the app links
  directly to `resources/<section>/<slug>.md` on `master`.

## Pull request checklist

- [ ] File lives at `resources/<section>/<slug>.md` with a lowercase-hyphenated slug.
- [ ] Frontmatter matches the [schema](./README.md#resource-frontmatter-schema).
- [ ] Every score/association is backed by a listed reference.
- [ ] Claim labels are 30–80 chars and don't repeat the resource name.
- [ ] New, unsettled content is marked `draft: true`.

Thanks for helping keep health information open, evidence-backed, and honest.
