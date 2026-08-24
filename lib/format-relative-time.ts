// SQLite's datetime('now') returns UTC with no timezone marker
// ("YYYY-MM-DD HH:MM:SS"). Without an explicit "Z", `new Date(...)` parses
// the space-separated form as local time, silently corrupting the offset
// on any host not running in UTC — so the "T" + "Z" rewrite below is load
// bearing, not cosmetic.
export function formatRelativeTime(dateStr: string): string {
  const then = new Date(dateStr.replace(' ', 'T') + 'Z').getTime()
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60000))

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
