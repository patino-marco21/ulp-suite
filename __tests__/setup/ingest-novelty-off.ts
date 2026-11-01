// Novelty-aware ingest (lib/ingest-novelty.ts) stages every file in ClickHouse tables, which the many suites that run the import
// loop against a mocked client cannot answer. They test the direct path. The feature has its own suites (they pass `env`
// explicitly or stub it) and scripts/e2e-novelty-ingest.ts exercises it for real on the rehearsal stack.
process.env.INGEST_NOVELTY_CHECK = 'off'

// The normalised key asks the catalogue which key to use (lib/norm-key-ready.ts), which the same mocked clients cannot answer. The suites that
// exercise it pass `env` explicitly or mock the module; scripts/e2e-novelty-ingest.ts exercises it for real.
process.env.INGEST_NORM_KEY = 'off'
