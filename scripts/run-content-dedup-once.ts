/**
 * One-time supervised invocation of content-dedup's guarded, bucketed
 * rewrite+swap -- the same runContentDedupTick() the daily cron
 * (lib/dedup-cron.ts) calls on a schedule, just triggered once by hand.
 * Use this for the first-ever apply run so a human is watching, before
 * arming CONTENT_DEDUP_APPLY for the unattended cron. See
 * docs/superpowers/specs/2026-09-28-dedup-reconciliation-design.md.
 *
 * ClickHouse's port is deliberately NOT exposed to the host (see
 * docker-compose.yml's clickhouse service comment), and this script isn't
 * copied into the production app image (Next.js standalone output only) --
 * so this can't run as a bare `npx tsx` from the host or via `docker exec`
 * into ulpsuite_app the way scripts/benchmark-import.ts can. Run it from a
 * throwaway container attached to the same Docker network instead, with
 * the real project directory mounted in and CLICKHOUSE_HOST overridden to
 * the internal URL (matches docker-compose.yml's app service exactly --
 * .env's own CLICKHOUSE_HOST is just the bare hostname, no scheme/port):
 *
 *   docker run --rm --network ulpsuite_network -v "$(pwd)":/app -w /app \
 *     --env-file .env -e CLICKHOUSE_HOST="http://clickhouse:8123" \
 *     node:24-bookworm-slim npx tsx scripts/run-content-dedup-once.ts
 *
 *   # add -e CONTENT_DEDUP_APPLY=true to the same command to apply for real
 */
import { pathToFileURL } from 'node:url'
import { getClient } from '@/lib/clickhouse'
import { runContentDedupTick } from '@/lib/content-dedup'

async function main(): Promise<void> {
  const result = await runContentDedupTick({ trigger: 'manual' })
  console.log('[run-content-dedup-once] result:', result)
  await getClient().close()
  if (!result.applied && process.env.CONTENT_DEDUP_APPLY) {
    console.error(
      '[run-content-dedup-once] CONTENT_DEDUP_APPLY was set but applied=false -- ' +
      'check the [content-dedup] log lines above for why (excess below DEDUP_MIN_EXCESS, or verification failed).',
    )
    process.exit(1)
  }
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1) })
}
