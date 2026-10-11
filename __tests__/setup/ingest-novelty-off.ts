// Novelty-aware ingest (lib/ingest-novelty.ts) stages every file in ClickHouse tables, which the many suites that run the import
// loop against a mocked client cannot answer. They test the direct path. The feature has its own suites (they pass `env`
// explicitly or stub it) and scripts/e2e-novelty-ingest.ts exercises it for real on the rehearsal stack.
process.env.INGEST_NOVELTY_CHECK = 'off'
