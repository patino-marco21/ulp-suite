# ULP Suite

Self-hosted credential-intelligence app: a Next.js app, ClickHouse for the credentials (over a billion rows) and SQLite for users, monitors and import jobs. `README.md` lists the features, the architecture and every setting.

## Where things are

- Designs with measurements: `docs/superpowers/specs/` (the status is in the first lines). Runbooks: `docs/pile-import-runbook.md`, `docs/clickhouse-backup-runbook.md`.
- Proof of ClickHouse and import behaviour: `scripts/e2e-*.ts`, run against the isolated stack in `docker-compose.rehearsal.yml` (each script's header says how).
- CI (`.github/workflows/ci.yml`) is the gate: typecheck of the app, `scripts/` and `__tests__/`, then test, lint and build.

## Conventions no config file states

- The repo is public. Committed text carries numbers and reasons; search terms, log excerpts, names of the data files and credential values stay on the owner's machine.
- ClickHouse changes are proven on a real ClickHouse. A test that mocks the SQL once passed with two real bugs in it, so a change to a query, the DDL or the import path ends with the matching rehearsal.
- The production build strips `console.log`. Use `console.warn` or `console.error` for anything `docker logs` has to show.
- The app sees only the variables `docker-compose.yml` forwards by name. A new setting goes there, in `.env.example` and in the README.
- Deploys: tag the running image first (`docker tag ulp-suite-app:latest ulp-suite-app:rollback-<UTC time>`), build a candidate under its own tag and rehearse it with `REHEARSAL_APP_IMAGE`, and run `docker compose` from the primary checkout only (from a worktree it blanks `.env` and serves an empty database).
- Worktrees live in `.claude/worktrees/`; a fresh one needs `npm install`.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/` on this machine (git ignores it; the repo is public). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), written as the `Status:` line of a ticket. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created when the first term or decision is settled. See `docs/agents/domain.md`.
