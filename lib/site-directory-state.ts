/**
 * What the Site Directory refresh is doing, for the status line and the list's "reload" hint (module state: the app runs as one process). The tick
 * (lib/site-directory-cron.ts) writes it; the answers in lib/site-directory.ts and lib/site-directory-cron.ts read it.
 */
export const refreshState: { running: boolean; lastRefreshedAt: string | null } = { running: false, lastRefreshedAt: null }
