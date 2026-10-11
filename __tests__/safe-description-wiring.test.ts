import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const page = readFileSync(new URL('../app/breaches/[name]/page.tsx', import.meta.url), 'utf8')
const component = readFileSync(new URL('../components/safe-description.tsx', import.meta.url), 'utf8')

describe('breach page', () => {
  test('shows the description through SafeDescription, never as raw HTML', () => {
    expect(page).toContain('<SafeDescription html={breach.description}')
    expect(page).toContain('import { SafeDescription } from "@/components/safe-description"')
    expect(page).not.toContain('dangerouslySetInnerHTML')
  })

  test('the component builds React elements from the parsed tree and never assigns a string of HTML', () => {
    expect(component).toContain('parseSafeHtml')
    expect(component).not.toContain('dangerouslySetInnerHTML')
    expect(component).toContain('rel="noopener noreferrer"')
  })
})
