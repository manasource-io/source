# Abridged Wikidata acquisition fixture

Date: 2026-10-01

This is a modified, abridged Wikidata SPARQL result retained for offline tests, in the `manasource.wikidata-sparql.v2` shape: one row per property value of an item, never a cross-product. It contains six items, selected to preserve the acquisition shapes the records importer depends on:

- Q7049784 (Noopept/omberacetam), every row the endpoint returned on 2026-10-01: its UNII, CAS number and PubChem CID, P2868 roles including Q742487 (`nootropic`), its P31 class, its English label and aliases. It has no peptide row: Wikidata does not place it under Q172847.
- Q4415058 (Semax), every row returned: the item carries a CAS number and no UNII, so it is reachable by CAS alone.
- Q27269822 (elamipretide), every row returned, including the one peptide-membership row in the fixture.
- Q57055 (paracetamol), abridged to its UNII, English label and ATC P267 rows, omitting its role, class, alias and other identifier rows, making its fixture classification signal intentionally ATC-only;
- two synthetic test items, Q90000001 and Q90000002, that intentionally share the synthetic UNII `A1B2C3D4E5` so ambiguity handling can be tested without pretending either match is authoritative.

Rows not needed for those cases were removed. The ambiguity items, their labels and their UNII were created for this fixture and must not be treated as Wikidata claims. The result is in the exact deterministic serialization emitted by the acquisition helper, and the adjacent receipt hashes those exact bytes. The receipt's selection digests cover the five UNIIs and three CAS numbers these rows were selected by.

Wikidata structured data is available under the Creative Commons CC0 1.0 Universal Public Domain Dedication: https://creativecommons.org/publicdomain/zero/1.0/
