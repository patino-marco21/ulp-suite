import { readFileSync } from 'fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test, expect } from 'vitest'
import { JobViewLink } from '@/components/job-view-link'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const job = { filename: 'batch one.txt', status: 'done', imported: 594_542, duration_ms: 33_481, created_at: '2026-10-18 16:55:17' }
const html = (j: typeof job) => renderToStaticMarkup(createElement(JobViewLink, { job: j }))

describe('JobViewLink — "View what this added"', () => {
  test('a finished job that added rows links to the Credentials page on its window and file', () => {
    const out = html(job)
    expect(out).toContain('href="/credentials?imported_after=2026-10-18T16%3A54%3A42Z&amp;imported_before=2026-10-18T16%3A55%3A18Z&amp;source_file=batch+one.txt"')
    expect(out).toContain('title="View what this added"')
    expect(out).toContain('aria-label="View what batch one.txt added"')
  })

  test('a ZIP can only be linked by its window, and the tooltip says what that can include', () => {
    const out = html({ ...job, filename: 'pack.zip' })
    expect(out).not.toContain('source_file')
    expect(out).toContain('title="View the rows added while this job ran (rows of files imported at the same time can be included)"')
    expect(out).toContain('aria-label="View what pack.zip added"')
  })

  test('a job that added nothing, failed or was held shows no link', () => {
    expect(html({ ...job, imported: 0 })).toBe('')
    expect(html({ ...job, status: 'failed' })).toBe('')
    expect(html({ ...job, status: 'held' })).toBe('')
  })

  test('both job lists use it, inside the branch for a finished job', () => {
    const inbox = read('app/inbox/page.tsx')
    const upload = read('app/upload/page.tsx')
    for (const [name, src] of [['inbox', inbox], ['upload', upload]] as const) {
      expect(src, name).toContain('import { JobViewLink } from "@/components/job-view-link"')
      expect(src, name).toContain('<JobViewLink job={job} />')
    }
    const doneBranch = inbox.slice(inbox.indexOf("job.status === 'done' ? ("), inbox.indexOf('gate: warn') + 400)
    expect(doneBranch).toContain('<JobViewLink job={job} />')
  })
})
