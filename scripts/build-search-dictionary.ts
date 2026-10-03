/**
 * The supervised build of the search dictionary (lib/search-dictionary.ts): the same function the cron calls, run once by hand, so a person is
 * watching the first one (about 2.5 minutes, reads about 66 GiB, peaks under 4 GiB, writes about 2.2 GiB) and the dictionary exists and is
 * verified before anything depends on it. Run it BEFORE deploying the version whose cron would otherwise do the first build unattended.
 *
 * ClickHouse is not published to the host, but the compose network is routable from it, so no throwaway container is needed:
 *
 *   IP=$(docker inspect ulpsuite_clickhouse --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 *   CLICKHOUSE_HOST=http://$IP:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD= CLICKHOUSE_DATABASE=ulp \
 *     npx tsx scripts/build-search-dictionary.ts
 *
 *   --status                prints the dictionary's state and exits (changes nothing)
 *   --force                 builds even when the dictionary is already fresh
 *   --skip-headroom-check   skips the free-space check (only after you have looked at `df`)
 *
 * Exit code 0: the dictionary is fresh. 1: an error (the serving tables are untouched). 3: it was built, but the data changed meanwhile, so it is
 * already stale (an import ran; the cron will rebuild it, or run this again).
 */
import { pathToFileURL } from 'node:url'
import { getClient } from '@/lib/clickhouse'
import { buildSearchDictionary, getSearchDictionaryStatus, resetSearchDictionaryCache } from '@/lib/search-dictionary'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const show = async (label: string) => {
    resetSearchDictionaryCache()
    const s = await getSearchDictionaryStatus()
    console.log(`${label}: ${s.state}${s.builtAt ? `, built ${s.builtAt}` : ''}${s.pairRows !== null ? `, ${s.pairRows} host pairs` : ''}${s.emailRows !== null ? `, ${s.emailRows} email domains` : ''}${s.bytes !== null ? `, ${(s.bytes / 2 ** 30).toFixed(2)} GiB` : ''}`)
    return s
  }

  const status = await show('status')
  if (args.includes('--status')) return status.state === 'fresh' ? 0 : 1
  if (status.state === 'building') {
    console.error('a build of the dictionary is already running; not starting a second one')
    return 1
  }
  if (status.state === 'disabled') {
    console.error('SEARCH_DICTIONARY switches the feature off in this environment; building anyway would be harmless but pointless')
    return 1
  }
  if (status.state === 'fresh' && !args.includes('--force')) {
    console.log('the dictionary is already fresh; nothing to do (use --force to rebuild)')
    return 0
  }

  const result = await buildSearchDictionary({ skipHeadroomCheck: args.includes('--skip-headroom-check'), log: m => console.log(m) })
  console.log(`result: ${JSON.stringify(result)}`)
  const after = await show('status after the build')
  if (after.state === 'fresh') return 0
  console.error(`the dictionary is ${after.state} right after the build: the data changed while it ran (exit code 3)`)
  return 3
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main()
    .then(async code => { await getClient().close(); process.exit(code) })
    .catch(async err => { console.error(err); await getClient().close().catch(() => {}); process.exit(1) })
}
