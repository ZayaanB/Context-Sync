// Hand-labeled synthetic cases, including an explicit noisy-link counterexample.
// These evaluate supporting-fact retrieval, not LLM answer quality.
module.exports = [
  {
    id: 'linked-prerequisite', query: 'jwt rotation policy', maxFiles: 2,
    notes: [
      { name: 'seed.md', topic: 'JWT rotation policy', summary: 'Rotate credentials after a verified exchange.', links: ['custody'] },
      { name: 'custody.md', topic: 'Key custody', summary: 'Signing material stays in the managed vault.' },
      { name: 'glossary.md', topic: 'JWT glossary', summary: 'A separate terminology discussion.' },
    ],
    gold: [{ source: 'seed.md', fact: 'Rotate credentials after a verified exchange.' }, { source: 'custody.md', fact: 'Signing material stays in the managed vault.' }],
  },
  {
    id: 'backlink-decision', query: 'payments retry policy', maxFiles: 2,
    notes: [
      { name: 'seed.md', topic: 'Payments retry policy', summary: 'Retry only transient failures.', tags: ['billing'] },
      { name: 'settlement.md', topic: 'Settlement guide', summary: 'Reject duplicate settlement identifiers.', tags: ['billing'], links: ['seed#Decision|Current policy'] },
      { name: 'glossary.md', topic: 'Payments glossary', summary: 'A terminology list.' },
    ],
    gold: [{ source: 'seed.md', fact: 'Retry only transient failures.' }, { source: 'settlement.md', fact: 'Reject duplicate settlement identifiers.' }],
  },
  {
    id: 'multi-hop-support', query: 'cache invalidation fencing', maxFiles: 5,
    notes: [
      { name: 'seed.md', topic: 'Cache invalidation fencing', summary: 'Consult the lease coordination decision.', tags: ['redis'], links: ['lease'] },
      { name: 'lease.md', topic: 'Lease coordination', summary: 'Every worker must own a live lease.', tags: ['redis'], links: ['epochs'] },
      { name: 'epochs.md', topic: 'Worker generations', summary: 'Reject stale epoch identifiers.', tags: ['redis'] },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `glossary_${i}.md`, topic: 'Cache glossary', summary: `Unrelated terminology ${i}.` })),
    ],
    gold: [{ source: 'seed.md', fact: 'Consult the lease coordination decision.' }, { source: 'lease.md', fact: 'Every worker must own a live lease.' }, { source: 'epochs.md', fact: 'Reject stale epoch identifiers.' }],
  },
  {
    id: 'stronger-tag-link', query: 'session cookies rotation', maxFiles: 2,
    notes: [
      { name: 'seed.md', topic: 'Session cookies rotation', summary: 'Rotate credentials on successful renewal.', tags: ['auth', 'security'], links: ['device', 'palette'] },
      { name: 'device.md', topic: 'Device binding', summary: 'Bind refresh credentials to a device identifier.', tags: ['auth', 'security'] },
      { name: 'palette.md', topic: 'Brand palette', summary: 'Use blue for the logo.', tags: ['design'] },
      { name: 'glossary.md', topic: 'Session glossary', summary: 'An unrelated terminology list.' },
    ],
    gold: [{ source: 'seed.md', fact: 'Rotate credentials on successful renewal.' }, { source: 'device.md', fact: 'Bind refresh credentials to a device identifier.' }],
  },
  {
    id: 'unlinked-exact-matches', query: 'postgres vacuum policy', maxFiles: 2,
    notes: [
      { name: 'seed.md', topic: 'Postgres vacuum policy', summary: 'Run maintenance during the low-traffic window.' },
      { name: 'schedule.md', topic: 'Vacuum schedule', summary: 'Alert if maintenance exceeds its time window.' },
      { name: 'other.md', topic: 'Frontend colors', summary: 'Use blue buttons.' },
    ],
    gold: [{ source: 'seed.md', fact: 'Run maintenance during the low-traffic window.' }, { source: 'schedule.md', fact: 'Alert if maintenance exceeds its time window.' }],
  },
  {
    id: 'broken-links-fallback', query: 'tls certificates policy', maxFiles: 2,
    notes: [
      { name: 'seed.md', topic: 'TLS certificates policy', summary: 'Renew before the expiry window.', links: ['missing', '../outside', 'https://example.com/note'] },
      { name: 'inventory.md', topic: 'Certificates inventory', summary: 'Track the owner of every credential.' },
    ],
    gold: [{ source: 'seed.md', fact: 'Renew before the expiry window.' }, { source: 'inventory.md', fact: 'Track the owner of every credential.' }],
  },
  {
    id: 'no-seed-no-injection', query: 'kubernetes autoscaling', maxFiles: 2,
    notes: [
      { name: 'auth.md', topic: 'JWT policy', summary: 'Rotate credentials.', links: ['billing'] },
      { name: 'billing.md', topic: 'Invoice reconciliation', summary: 'Record settlement identifiers.' },
    ],
    gold: [],
  },
  {
    id: 'noisy-link-counterexample', query: 'api retries policy', maxFiles: 2,
    notes: [
      { name: 'seed.md', topic: 'API retries policy', summary: 'Retry only transient failures.', links: ['palette'] },
      { name: 'backoff.md', topic: 'Retries backoff', summary: 'Use exponential delays for transient errors.' },
      { name: 'palette.md', topic: 'Brand palette', summary: 'Use blue for the logo.', tags: ['design'] },
    ],
    gold: [{ source: 'seed.md', fact: 'Retry only transient failures.' }, { source: 'backoff.md', fact: 'Use exponential delays for transient errors.' }],
  },
];
