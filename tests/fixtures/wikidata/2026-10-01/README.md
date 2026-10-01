# Abridged Wikidata acquisition fixture

Date: 2026-10-01

This is a modified, abridged Wikidata SPARQL result retained for offline tests. It contains four items, selected to preserve the acquisition shapes needed by the records importer work that follows this slice:

- Q7049784 (Noopept/omberacetam), including P2868 role Q742487 (`nootropic`);
- Q57055 (paracetamol), abridged to retain ATC P267 while omitting role and class bindings, making its fixture classification signal intentionally ATC-only;
- two synthetic test bindings, Q90000001 and Q90000002, that intentionally share the synthetic UNII `A1B2C3D4E5` so ambiguity handling can be tested without pretending either match is authoritative.

Rows and fields not needed for those cases were removed. The ambiguity bindings and their labels/UNII were created for this fixture and must not be treated as Wikidata claims. The result remains in the exact deterministic serialization emitted by the acquisition helper, and the adjacent receipt hashes those exact bytes.

Wikidata structured data is available under the Creative Commons CC0 1.0 Universal Public Domain Dedication: https://creativecommons.org/publicdomain/zero/1.0/
