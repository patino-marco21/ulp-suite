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
 *
 * The rewrite+swap builds the deduped table WITHOUT ulp.credentials'
 * projections and restores proj_email_domain_rev, proj_domain_rev and
 * proj_imported_desc afterwards (see lib/credentials-projections.ts). If that last step failed --
 * or the run was interrupted after the swap -- re-run just the restore, same
 * docker command with `--restore-projections` appended to the `npx tsx` line
 * (no CONTENT_DEDUP_APPLY needed; it never touches row data). Use
 * `--restore-email-domain-projection` / `--restore-domain-projection` to
 * restore only one of the small reversed-key ones (idempotent: materializes
 * only partitions still missing it) without re-materializing the large
 * proj_imported_desc.
 */
import { pathToFileURL } from 'node:url'
import { getClient } from '@/lib/clickhouse'
import { createDiskGuard } from '@/lib/clickhouse-disk-guard'
import { runContentDedupTick } from '@/lib/content-dedup'
import {
  restoreDomainRevProjection,
  restoreEmailDomainRevProjection,
  restoreImportedDescProjection,
} from '@/lib/credentials-projections'

async function main(): Promise<void> {
  const restoreAll = process.argv.includes('--restore-projections')
  const restoreEmailOnly = process.argv.includes('--restore-email-domain-projection')
  const restoreDomainOnly = process.argv.includes('--restore-domain-projection')
  if (restoreAll || restoreEmailOnly || restoreDomainOnly) {
    if (restoreAll || restoreEmailOnly) {
      const email = await restoreEmailDomainRevProjection(getClient(), createDiskGuard('ulp.credentials'))
      console.log(`[run-content-dedup-once] proj_email_domain_rev materialized for partitions: ${email.partitions.join(', ') || '(none missing)'}`)
    }
    if (restoreAll || restoreDomainOnly) {
      const domain = await restoreDomainRevProjection(getClient(), createDiskGuard('ulp.credentials'))
      console.log(`[run-content-dedup-once] proj_domain_rev materialized for partitions: ${domain.partitions.join(', ') || '(none missing)'}`)
    }
    if (restoreAll) {
      const imported = await restoreImportedDescProjection(getClient(), createDiskGuard('ulp.credentials'))
      console.log(`[run-content-dedup-once] proj_imported_desc restored for partitions: ${imported.partitions.join(', ') || '(none in the recency window)'}`)
    }
    await getClient().close()
    return
  }

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
  if (result.applied && result.projectionsRestored === false) {
    console.error(
      '[run-content-dedup-once] the swap succeeded but restoring a projection failed -- ' +
      'ulp.credentials is live and correct; re-run with --restore-projections once the cause above is addressed.',
    )
    process.exit(2)
  }
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().catch(err => { console.error(err); process.exit(1) })
}
