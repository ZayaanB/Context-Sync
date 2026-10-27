import { ContextFile } from '../types';
import { MinHeap } from './MinHeap';

export type WeightedGraph = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface GraphSeed {
  id: string;
  /** Cost of the virtual query-to-note edge. */
  distance: number;
}

export interface GraphPath {
  distance: number;
  source: string;
  path: string[];
}

export interface GraphSearchResult {
  paths: Map<string, GraphPath>;
  visitedNodes: number;
  scannedEdges: number;
  truncated: boolean;
}

export interface GraphSearchOptions {
  maxDistance: number;
  maxVisited: number;
  maxEdges: number;
}

const compareNames = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function noteName(name: string): string {
  const stem = name.replace(/\.md$/i, '');
  return process.platform === 'win32' ? stem.toLowerCase() : stem;
}

/** Resolve only cached, flat-vault targets. No link can trigger a filesystem read. */
export function buildContextGraph(files: Iterable<ContextFile>): WeightedGraph {
  const notes = [...files];
  const linked = notes.filter(note => note.links.length > 0);
  const graph = new Map<string, Map<string, number>>();
  if (!linked.length) return graph;

  const targets = new Map<string, ContextFile | undefined>();
  for (const note of notes) {
    const key = noteName(note.filename);
    // Two differently cased extensions can share a stem on a case-sensitive FS.
    targets.set(key, targets.has(key) ? undefined : note);
  }
  const tags = new Map(notes.map(note => [note.filename, new Set(note.tags)]));
  const add = (from: string, to: string, cost: number) => {
    let edges = graph.get(from);
    if (!edges) { edges = new Map(); graph.set(from, edges); }
    edges.set(to, cost);
  };

  for (const note of linked.sort((a, b) => compareNames(a.filename, b.filename))) {
    // Exports generate at most three links; bound manually edited notes as well.
    for (const link of [...new Set(note.links.slice(0, 64))].sort(compareNames)) {
      const target = link.split('|', 1)[0].split('#', 1)[0].trim();
      if (!target || /[/\\\r\n]/.test(target) || target === '.' || target === '..') continue;
      const neighbor = targets.get(noteName(target));
      if (!neighbor || neighbor.filename === note.filename || graph.get(note.filename)?.has(neighbor.filename)) continue;
      const left = tags.get(note.filename)!;
      const right = tags.get(neighbor.filename)!;
      let shared = 0;
      for (const tag of left) if (right.has(tag)) shared++;
      const union = left.size + right.size - shared;
      // Jaccard similarity provides positive, non-uniform costs in [1, 2].
      const cost = 2 - (union ? shared / union : 0);
      add(note.filename, neighbor.filename, cost);
      add(neighbor.filename, note.filename, cost); // Obsidian-style backlinks.
    }
  }
  return graph;
}

/** Bounded multi-source Dijkstra. Only settled nodes are returned as shortest paths. */
export function dijkstra(
  graph: WeightedGraph, seeds: readonly GraphSeed[], options: GraphSearchOptions
): GraphSearchResult {
  if (!Number.isFinite(options.maxDistance) || options.maxDistance < 0 ||
      !Number.isSafeInteger(options.maxVisited) || options.maxVisited < 1 ||
      !Number.isSafeInteger(options.maxEdges) || options.maxEdges < 0) {
    throw new Error('Invalid graph traversal limits.');
  }
  type Entry = { id: string; distance: number; order: number };
  type Best = { distance: number; source: string; parent?: string };
  const queue = new MinHeap<Entry>((a, b) => a.distance - b.distance || a.order - b.order);
  const best = new Map<string, Best>();
  const settled = new Set<string>();
  const paths = new Map<string, GraphPath>();
  let order = 0;
  let scannedEdges = 0;
  let truncated = false;

  for (const seed of seeds) {
    if (!Number.isFinite(seed.distance) || seed.distance < 0) throw new Error('Invalid graph seed cost.');
    if (seed.distance > options.maxDistance || (best.get(seed.id)?.distance ?? Infinity) <= seed.distance) continue;
    best.set(seed.id, { distance: seed.distance, source: seed.id });
    queue.push({ ...seed, order: order++ });
  }

  while (queue.size) {
    const current = queue.pop()!;
    if (settled.has(current.id) || current.distance !== best.get(current.id)?.distance) continue;
    if (current.distance > options.maxDistance) break;
    const record = best.get(current.id)!;
    settled.add(current.id);
    const path: string[] = [current.id];
    let parent = record.parent;
    while (parent !== undefined) { path.push(parent); parent = best.get(parent)?.parent; }
    paths.set(current.id, { distance: current.distance, source: record.source, path: path.reverse() });

    const edges = graph.get(current.id);
    if (settled.size >= options.maxVisited) {
      truncated = queue.size > 0 || (edges?.size ?? 0) > 0;
      break;
    }
    // Stop before partially expanding a hub; later tentative distances would not be final.
    if (scannedEdges + (edges?.size ?? 0) > options.maxEdges) { truncated = true; break; }
    for (const [neighbor, cost] of edges ?? []) {
      scannedEdges++;
      if (!Number.isFinite(cost) || cost < 0) throw new Error('Dijkstra requires finite, non-negative edge costs.');
      if (settled.has(neighbor)) continue;
      const distance = current.distance + cost;
      if (distance > options.maxDistance || distance >= (best.get(neighbor)?.distance ?? Infinity)) continue;
      best.set(neighbor, { distance, source: record.source, parent: current.id });
      queue.push({ id: neighbor, distance, order: order++ });
    }
  }
  return { paths, visitedNodes: settled.size, scannedEdges, truncated };
}
