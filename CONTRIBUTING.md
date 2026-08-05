# Contributing to the Manasource corpus

This repository is the open evidence base behind
**[manasource.io](https://manasource.io)**. Contributions live and die by their
sources: show the evidence, represent uncertainty honestly, and keep structured
data machine-valid.

By contributing you agree that corpus data in your contribution is licensed
under [CC BY-SA 4.0](./LICENSE).

## Add or update an entity

1. Choose the canonical path:
   `resources/<section>[/<section>...]/<slug>.yaml`,
   `masteries/<group>/<slug>.yaml`, or
   `records/<record_type>/<id-shard>/<id>.yaml`.
2. Start from the matching schema in [`schemas/`](./schemas/) and examples in
   [`tests/fixtures/valid/`](./tests/fixtures/valid/). Use one entity per YAML
   file and an immutable registered typed ID.
3. Put all structured fields in YAML. If narrative is useful, add
   `<same-stem>.md` beside it without frontmatter. YAML-only entities are valid;
   Markdown-only entities are not.
4. For resources, preserve the current claim and reference facts. Local
   reference IDs and claim citations are optional; add them only when the
   evidence data provides that relationship. Use `links` for typed cross-entity
   relationships. Give the resource a section-qualified `source_slug`
   identifier (`<section-path>:<slug>`) so repeated stems stay unique, and add
   `score` before moving `lifecycle` off `draft`.
5. Run the checks below and open a pull request explaining the evidence and the
   change.

Imported batches use `manifests/<source>/<batch-id>.yaml`. A manifest's
`source_namespace` covers matching source rows on every record ID it lists, and
its source count must equal those rows. Every record remains a separate YAML
file in `records/` and needs at least one source row with `namespace`,
`source_record_id`, HTTPS `url`, and `attribution`.

## Content standards

- Evidence over opinion. Prefer primary research, systematic reviews, and
  reputable evidence aggregators.
- Do not overstate mixed or weak evidence; represent lifecycle and claims
  honestly.
- Keep slugs and every resource section path segment lowercase kebab-case.
  Record type directories use the registered snake-case type and record shard
  directories use the ID's two shard characters.
- Do not reuse a typed ID or an authoritative `kind`/`value` identifier pair.
- Do not put corpus data in Supabase or introduce request-time YAML parsing.

## Required checks

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run corpus:validate
bun run corpus:format:check
```

`corpus:validate` and `corpus:format:check` default to the repository root and
cover the whole corpus. Run `bun run corpus:format` first if you hand-edited
YAML; it rewrites files into canonical form.

## Pull request checklist

- [ ] Exactly one logical entity per `.yaml` file.
- [ ] ID prefix matches `entity_type`; records use the correct type and shard path.
- [ ] Filename stem matches `slug` (or record ID / manifest batch ID).
- [ ] Optional Markdown has the same stem and contains no frontmatter.
- [ ] Required fields match the kind schema; legacy `code` lives in `identifiers`, not as a field, and no Markdown frontmatter remains anywhere.
- [ ] Tests, typecheck, validation, and format check pass for the changed corpus surface.

Thanks for helping keep health information open, evidence-backed, and honest.
