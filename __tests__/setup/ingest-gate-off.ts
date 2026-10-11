// The ingest disk gate (lib/ingest-disk-gate.ts) reads ClickHouse's disk and fails CLOSED. Many suites run the import loop
// against a mocked client whose answers have the wrong shape for it, which would pause every one of them forever. The gate has
// its own suite (it passes `env` explicitly) and scripts/e2e-disk-gate.ts exercises it for real on the rehearsal stack.
process.env.INGEST_DISK_GATE = 'off'
