# Retrieval methodology and limitations

## Reproduce

```bash
npm test
npm run benchmark:retrieval -- --output=out/retrieval-benchmark.json
```

Use `--quick` for one round with smaller vaults. The full run uses five rounds
per workload and mode, 10 warmups followed by 100 timed queries per round. Mode
order alternates across rounds. Every mode/round loads a fresh `ContextManager`
from the same fixture folder. Loading is not included in query latency.

The CLI uses the real parser, file loader, graph index, shortest-path search, and
context formatter. Only VS Code configuration access is stubbed. It makes no
provider requests and does not time cloud sync or model inference. First-query
latency includes lazy vocabulary/graph caches; warm query latency does not.
There are no timing thresholds in CI because local timing is environment-dependent.

Raw samples, environment information, first-query times, warm median/p95,
serialized payload bytes, per-case selected sources, and evaluation aggregates
are written to the specified JSON report. The standard output path is ignored
by Git and excluded from the VSIX. Temporary fixture files are removed afterward.

## Supporting-fact evaluation

`scripts/retrieval-fixtures.cjs` contains eight manually labeled synthetic cases:
direct links, backlinks, a multi-hop chain, a stronger-tag link, unlinked exact
matches, broken links, no lexical seed, and a noisy-link counterexample.

Both modes use identical file and byte caps within a case. A fact is counted
only when its expected source and expected text appear in the emitted facts.
Micro recall is retrieved labeled facts divided by all labeled facts. Micro
precision is retrieved labeled facts divided by returned records; this fixture
has one labeled fact per useful record. A no-match case contributes neither a
gold fact nor a selected record but checks that unrelated context is not injected.

The fixtures have 15 labeled facts. Lexical retrieval returns 10/15 and hybrid
returns 14/15. Precision is 10/17 versus 14/17. Four cases improve, one regresses,
and three are unchanged. The noisy-link case demonstrates that a correct
shortest path can lead to an irrelevant note and displace a useful direct match.
The eight-case set is deliberately small and diagnostic, not representative
of team vaults, a blinded evaluation, or a measurement of model answer quality.

Aggregate context payload is 1,966 bytes in lexical mode and 2,295 bytes in hybrid
mode on these cases, including path provenance. Hybrid is not inherently a token
reduction method. These are UTF-8 bytes, not provider token counts. Do not use
the fixture recall/precision figures as a general production resume claim.

## Timing workloads

- **Unlinked vault:** 10,000 notes, 1% lexical matches, no graph edges. Checks the
  fallback and lazy empty graph behavior.
- **Linked vault:** 10,000 notes, 1% lexical matches, two outgoing links per note.
  Checks graph construction and bounded warm traversal.
- **Long query:** 1,000 linked notes and 5,001 query terms. Checks the cached
  smaller-vocabulary intersection path alongside graph expansion.
- **High-degree hub:** one lexical hub plus 10,000 notes linking to it. The
  default edge budget prevents full expansion of the hub; lexical fallback remains.

The defaults are a 4,096-byte output cap, five returned files, graph distance 4,
200 settled graph nodes, and 4,000 scanned edges. At most two supporting notes
use up to half the file slots. Passage rendering also stops after at most ten
attempts per file slot, avoiding a full formatting scan when nothing can fit.
Graph indexing uses the first 64 link entries per note; query traversal limits
do not bound the one-time index-building work over all loaded notes.

## Local observations

The table below records a local full run. Values are milliseconds; rerun on the
target machine rather than treating them as fixed service-level guarantees.

<!-- timing-results:start -->
Environment: v24.14.0, linux/x64, 13th Gen Intel(R) Core(TM) i9-13900H.

| Workload | Notes | Warm lexical median / p95 | Warm hybrid median / p95 | First query lexical / hybrid | Bytes lexical / hybrid |
|---|---:|---:|---:|---:|---:|
| unlinked-vault | 10,000 | 1.43 / 2.39 | 1.53 / 2.46 | 11.49 / 11.98 | 644 / 644 |
| linked-vault | 10,000 | 1.45 / 1.82 | 1.66 / 2.36 | 11.92 / 45.39 | 644 / 738 |
| long-query-linked-vault | 1,000 | 1.99 / 2.11 | 2.14 / 2.29 | 2.92 / 5.98 | 639 / 729 |
| high-degree-hub | 10,001 | 1.76 / 2.06 | 1.78 / 2.04 | 8.50 / 29.53 | 97 / 97 |
<!-- timing-results:end -->

Hybrid may add a small warm-query cost and a larger first-query index cost.
Lexical remains the default because the graph can improve supporting-fact recall
when links are useful, but can also reduce relevance when links are noisy.
Graph results include their cached-note route and distance for inspection.

## Interpreting shortest paths and budgets

The graph contains explicit cached-note wikilinks and their backlinks. Link cost
is `2 - Jaccard(tagsA, tagsB)`, ranging from 1 to 2. Up to three lexical seeds
receive a virtual query-edge cost `1 - lexicalScore / bestLexicalScore`.
Multi-source Dijkstra minimizes cumulative cost in this indexed graph, using a
binary min-heap and returning only settled nodes. It does not minimize exact
LLM tokens, solve optimal subset selection, or establish that a note is true.

Cycles, disconnected nodes, multi-source costs, stale heap entries, aliases,
headings, missing targets, search bounds, and graph invalidation are covered by
automated tests. Dijkstra distances and reconstructed path costs are also
compared against an independent Bellman-Ford oracle on 100 deterministic
generated graphs. These are 100 cases inside one test, not 100 separate tests.

The UTF-8 byte cap preserves whole JSON records and facts. It may omit notes that
cannot fit, and the bounded packing policy is not an optimal knapsack algorithm.
Model-specific prompt budgeting runs afterward; it can prune prefixed team
context under pressure. Real-model answer quality and exact provider token
savings require separate measurement.

## Defensible resume wording

“Implemented hybrid context retrieval combining lexical ranking with bounded
multi-source Dijkstra traversal over tag-weighted conversation links.”

Shortest-path implementation can now be claimed. The previous 25% token-saving
and 30% schema-compaction figures remain unverified. The earlier approximately
97% synthetic lexical retrieval speedup is a separate historical optimization;
it must not be attributed to this graph expansion feature.
