import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MinHeap } from '../context/MinHeap';
import { buildContextGraph, dijkstra, WeightedGraph } from '../context/ContextGraph';
import { ContextFile } from '../types';

const limits = { maxDistance: 20, maxVisited: 200, maxEdges: 2000 };
const note = (filename: string, tags: string[], links: string[] = []): ContextFile => ({
  filename, tags, links, username: 'alice', topic: filename, summary: '', keyDecisions: [], tokens: [], modifiedAt: new Date(0),
});
const graph = (entries: Array<[string, Array<[string, number]>]>): WeightedGraph => new Map(entries.map(([id, edges]) => [id, new Map(edges)]));

test('binary heap orders duplicates and interleaved operations without losing entries', () => {
  const heap = new MinHeap<number>((a, b) => a - b);
  const values = Array.from({ length: 200 }, (_, i) => (i * 73) % 101);
  values.forEach(value => heap.push(value));
  assert.equal(heap.pop(), 0);
  heap.push(-1);
  const result: number[] = [];
  while (heap.size) result.push(heap.pop()!);
  assert.deepEqual(result, [-1, ...[...values].sort((a, b) => a - b).slice(1)]);
  assert.equal(heap.pop(), undefined);
});

test('Dijkstra improves a tentative route and reconstructs the cheaper multi-hop path', () => {
  const result = dijkstra(graph([['a', [['b', 7], ['c', 1]]], ['c', [['b', 2]]], ['b', [['d', 1]]]]), [{ id: 'a', distance: 0 }], limits);
  assert.deepEqual(result.paths.get('d'), { distance: 4, source: 'a', path: ['a', 'c', 'b', 'd'] });
  assert.equal(result.paths.get('b')?.distance, 3);
  assert.equal(result.visitedNodes, 4);
});

test('multiple seeds use the cheapest total route including the query-to-seed cost', () => {
  const result = dijkstra(graph([['a', [['c', 2]]], ['b', [['c', 1]]]]), [{ id: 'a', distance: 0 }, { id: 'b', distance: 0.5 }], limits);
  assert.deepEqual(result.paths.get('c'), { distance: 1.5, source: 'b', path: ['b', 'c'] });
});

test('cycles, zero-cost edges, duplicate seeds and disconnected nodes terminate correctly', () => {
  const result = dijkstra(graph([['a', [['b', 0]]], ['b', [['a', 0]]], ['unreachable', []]]), [{ id: 'a', distance: 1 }, { id: 'a', distance: 0 }], limits);
  assert.deepEqual([...result.paths.keys()], ['a', 'b']);
  assert.deepEqual(result.paths.get('b')?.path, ['a', 'b']);
  assert.equal(dijkstra(new Map(), [], limits).visitedNodes, 0);
});

test('distance and node limits return only settled paths', () => {
  const weighted = graph([['a', [['b', 1]]], ['b', [['c', 1]]]]);
  assert.deepEqual([...dijkstra(weighted, [{ id: 'a', distance: 0 }], { ...limits, maxDistance: 1 }).paths.keys()], ['a', 'b']);
  const bounded = dijkstra(weighted, [{ id: 'a', distance: 0 }], { ...limits, maxVisited: 1 });
  assert.equal(bounded.visitedNodes, 1);
  assert.equal(bounded.truncated, true);
});

test('a high-degree hub cannot bypass the edge budget or expose tentative paths', () => {
  const weighted = graph([['a', [['hub', 1], ['b', 5]]], ['hub', [['b', 1], ['c', 1], ['d', 1]]]]);
  const result = dijkstra(weighted, [{ id: 'a', distance: 0 }], { ...limits, maxEdges: 3 });
  assert.equal(result.scannedEdges, 2);
  assert.equal(result.paths.has('b'), false);
  assert.deepEqual(result.paths.get('hub')?.path, ['a', 'hub']);
  assert.equal(result.truncated, true);
});

test('Dijkstra rejects invalid limits, seed costs and traversed edge weights', () => {
  for (const cost of [-1, NaN, Infinity]) {
    assert.throws(() => dijkstra(graph([['a', [['b', cost]]]]), [{ id: 'a', distance: 0 }], limits));
    assert.throws(() => dijkstra(new Map(), [{ id: 'a', distance: cost }], limits));
  }
  assert.throws(() => dijkstra(new Map(), [], { ...limits, maxVisited: 0 }));
});

test('wikilinks create tag-weighted edges and backlinks, resolving aliases and headings', () => {
  const weighted = buildContextGraph([
    note('a.md', ['auth', 'backend'], ['b.md#Decision|Read more', 'c', 'b']),
    note('b.md', ['auth', 'backend']), note('c.md', ['frontend']),
  ]);
  assert.equal(weighted.get('a.md')?.get('b.md'), 1);
  assert.equal(weighted.get('b.md')?.get('a.md'), 1);
  assert.equal(weighted.get('a.md')?.get('c.md'), 2);
  assert.equal(weighted.get('a.md')?.size, 2);
});

test('graph ignores self-links, missing targets, paths, external links and ambiguous stems', () => {
  const weighted = buildContextGraph([
    note('a.md', [], ['a', 'missing', '../b', 'folder/b', 'https://example.com/b', 'b', 'dup']),
    note('b.MD', []), note('dup.md', []), note('dup.MD', []),
  ]);
  assert.deepEqual([...weighted.get('a.md')!.keys()], ['b.MD']);
  assert.equal(weighted.get('a.md')?.get('b.MD'), 2);
});

test('graph weights and traversal are deterministic regardless of cache load order', () => {
  const files = [note('a.md', ['x'], ['c', 'b']), note('b.md', ['x', 'y'], ['c']), note('c.md', ['y'])];
  const first = dijkstra(buildContextGraph(files), [{ id: 'a.md', distance: 0 }], limits);
  const second = dijkstra(buildContextGraph([...files].reverse()), [{ id: 'a.md', distance: 0 }], limits);
  assert.deepEqual(first.paths, second.paths);
  assert.equal(buildContextGraph([note('a.md', [])]).size, 0);
});

test('graph indexing bounds manually edited notes to their first 64 link entries', () => {
  const files = [note('root.md', [], Array.from({ length: 100 }, (_, i) => `n${i}`)),
    ...Array.from({ length: 100 }, (_, i) => note(`n${i}.md`, []))];
  const weighted = buildContextGraph(files);
  assert.equal(weighted.get('root.md')?.size, 64);
  assert.equal(weighted.get('root.md')?.has('n99.md'), false);
});

test('Dijkstra distances agree with an independent Bellman-Ford oracle on deterministic random graphs', () => {
  let random = 1234567;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let trial = 0; trial < 100; trial++) {
    const ids = Array.from({ length: 8 }, (_, i) => String(i));
    const weighted = new Map(ids.map(id => [id, new Map<string, number>()]));
    for (const from of ids) for (const to of ids) {
      if (from !== to && next() % 3 === 0) weighted.get(from)!.set(to, next() % 10);
    }
    const seeds = [{ id: '0', distance: 0 }, { id: '4', distance: 0.5 }];
    const distances = new Map(ids.map(id => [id, Infinity]));
    seeds.forEach(seed => distances.set(seed.id, seed.distance));
    for (let pass = 0; pass < ids.length - 1; pass++) {
      for (const [from, edges] of weighted) for (const [to, cost] of edges) {
        distances.set(to, Math.min(distances.get(to)!, distances.get(from)! + cost));
      }
    }
    const actual = dijkstra(weighted, seeds, { ...limits, maxDistance: 100 });
    for (const id of ids) {
      const path = actual.paths.get(id);
      assert.equal(path?.distance ?? Infinity, distances.get(id), `trial ${trial}, node ${id}`);
      if (path) {
        let total = seeds.find(seed => seed.id === path.source)!.distance;
        for (let i = 1; i < path.path.length; i++) total += weighted.get(path.path[i - 1])!.get(path.path[i])!;
        assert.equal(total, path.distance);
        assert.equal(path.path[0], path.source);
        assert.equal(path.path[path.path.length - 1], id);
      }
    }
  }
});
