const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fixtures = require('./retrieval-fixtures.cjs');

// The CLI cannot load VS Code's host-only module. Only configuration is stubbed;
// fixtures use the real filesystem loader, parser, graph builder and retriever.
const settings = { maxContextFiles: 5, maxContextBytes: 4096, maxGraphDistance: 4, maxGraphNodes: 200, retrievalMode: 'lexical' };
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === 'vscode'
    ? { workspace: { getConfiguration: () => ({ get: key => settings[key] }) }, window: { showWarningMessage: message => { throw new Error(message); } } }
    : originalLoad.call(this, name, ...args);
};
const { ContextManager } = require('../out/context/ContextManager');
Module._load = originalLoad;

const quick = process.argv.includes('--quick');
const rounds = quick ? 1 : 5;
const iterations = quick ? 10 : 100;
const output = process.argv.find(argument => argument.startsWith('--output='))?.slice('--output='.length);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const parse = block => block ? block.split('\n').map(line => JSON.parse(line)) : [];
const markdown = note => [
  '---', `topic: ${JSON.stringify(note.topic)}`, `tags: ${JSON.stringify(note.tags ?? ['auth'])}`, '---',
  '## Summary', note.summary, '## Related Conversations', ...(note.links ?? []).map(link => `- [[${link}]]`),
].join('\n');

async function writeNotes(folder, notes) {
  await fs.mkdir(folder);
  for (let i = 0; i < notes.length; i += 50) {
    await Promise.all(notes.slice(i, i + 50).map(note => fs.writeFile(path.join(folder, note.name), markdown(note))));
  }
}

function validate(block) {
  assert.ok(Buffer.byteLength(block) <= settings.maxContextBytes, 'Context byte budget exceeded');
  const entries = parse(block);
  assert.ok(entries.length <= settings.maxContextFiles, 'Context file budget exceeded');
  assert.equal(new Set(entries.map(entry => entry.source)).size, entries.length, 'Duplicate source');
  return entries;
}

async function evaluate(root) {
  const cases = [];
  for (const fixture of fixtures) {
    const folder = path.join(root, fixture.id);
    await writeNotes(folder, fixture.notes);
    const manager = new ContextManager();
    await manager.loadFromFolder(folder);
    settings.maxContextFiles = fixture.maxFiles;
    const modes = {};
    for (const mode of ['lexical', 'hybrid']) {
      settings.retrievalMode = mode;
      const block = manager.buildContextBlock(fixture.query);
      const entries = validate(block);
      const retrievedFacts = fixture.gold.filter(expected => entries.some(entry =>
        entry.source === expected.source && entry.facts.some(fact => fact.includes(expected.fact))));
      modes[mode] = { sources: entries.map(entry => entry.source), hits: retrievedFacts.length, gold: fixture.gold.length, selected: entries.length, bytes: Buffer.byteLength(block) };
    }
    cases.push({ id: fixture.id, ...modes });
  }
  const aggregate = {};
  for (const mode of ['lexical', 'hybrid']) {
    const totals = cases.reduce((sum, entry) => ({ hits: sum.hits + entry[mode].hits, gold: sum.gold + entry[mode].gold, selected: sum.selected + entry[mode].selected, bytes: sum.bytes + entry[mode].bytes }), { hits: 0, gold: 0, selected: 0, bytes: 0 });
    aggregate[mode] = { ...totals, factRecall: totals.hits / totals.gold, factPrecision: totals.hits / totals.selected };
  }
  return {
    aggregate,
    improvedCases: cases.filter(entry => entry.hybrid.hits > entry.lexical.hits).map(entry => entry.id),
    regressedCases: cases.filter(entry => entry.hybrid.hits < entry.lexical.hits).map(entry => entry.id),
    cases,
  };
}

async function timeScenario(root, scenario) {
  const folder = path.join(root, scenario.id);
  await writeNotes(folder, scenario.notes);
  settings.maxContextFiles = 5;
  const samples = { lexical: [], hybrid: [] };
  const cold = { lexical: [], hybrid: [] };
  const sizes = {};
  for (let round = 0; round < rounds; round++) {
    const modes = round % 2 ? ['hybrid', 'lexical'] : ['lexical', 'hybrid'];
    for (const mode of modes) {
      settings.retrievalMode = mode;
      const manager = new ContextManager();
      await manager.loadFromFolder(folder);
      const initial = performance.now();
      validate(manager.buildContextBlock(scenario.query));
      cold[mode].push(performance.now() - initial);
      for (let i = 0; i < 10; i++) manager.buildContextBlock(scenario.query);
      let block;
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        block = manager.buildContextBlock(scenario.query);
        samples[mode].push(performance.now() - start);
      }
      validate(block);
      sizes[mode] = Buffer.byteLength(block);
    }
  }
  const modes = {};
  for (const mode of ['lexical', 'hybrid']) modes[mode] = {
    medianMs: percentile(samples[mode], 0.5), p95Ms: percentile(samples[mode], 0.95),
    firstQueryMedianMs: percentile(cold[mode], 0.5), bytes: sizes[mode], samples: samples[mode],
  };
  return { id: scenario.id, notes: scenario.notes.length, rounds, iterationsPerRound: iterations, ...modes };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-retrieval-benchmark-'));
  try {
    const evaluation = await evaluate(root);
    const makeNotes = (count, linked, longQuery = false) => Array.from({ length: count }, (_, i) => ({
      name: `n${String(i).padStart(5, '0')}.md`, topic: longQuery || i % 100 === 0 ? `JWT rotation ${i}` : `Worker rollout ${i}`,
      summary: 'Verify the generation before accepting writes.', tags: ['backend'],
      links: linked ? [`n${String((i + 1) % count).padStart(5, '0')}`, `n${String((i + 7) % count).padStart(5, '0')}`] : [],
    }));
    const count = quick ? 1000 : 10000;
    const scenarios = [
      { id: 'unlinked-vault', notes: makeNotes(count, false), query: 'jwt rotation' },
      { id: 'linked-vault', notes: makeNotes(count, true), query: 'jwt rotation' },
      { id: 'long-query-linked-vault', notes: makeNotes(1000, true, true), query: Array.from({ length: 5000 }, (_, i) => `identifier_${i}`).join(' ') + ' jwt' },
      { id: 'high-degree-hub', notes: [
        { name: 'hub.md', topic: 'JWT rotation policy', summary: 'A central index.', tags: ['backend'] },
        ...Array.from({ length: count }, (_, i) => ({ name: `leaf_${i}.md`, topic: `Worker rollout ${i}`, summary: 'A deployment decision.', tags: ['backend'], links: ['hub'] })),
      ], query: 'jwt rotation policy' },
    ];
    const timings = [];
    for (const scenario of scenarios) {
      timings.push(await timeScenario(root, scenario));
      console.log(`Completed ${scenario.id}`);
    }
    const result = {
      environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model },
      methodology: 'Synthetic local fixtures; real loader/parser/retriever, configuration stubbed; no network or model calls. Setup/loading excluded. First query includes lazy cache/index construction; warm timings follow 10 warmups. Mode order alternates by round. Byte counts are not tokenizer counts. Eight manually labeled cases are not a representative answer-quality study.',
      evaluation, timings,
    };
    if (output) await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ evaluation, timings: timings.map(({ lexical, hybrid, ...rest }) => ({ ...rest, lexical: { ...lexical, samples: undefined }, hybrid: { ...hybrid, samples: undefined } })) }, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
