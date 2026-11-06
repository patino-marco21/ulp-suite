/**
 * The quality gate says HOW MANY lines could not be split; to say what they look like, parseULPStream reports the masked shape of each (every run of letters and digits becomes
 * "w", the punctuation stays: the same mask the gate already uses for the rows that break a rule), so a held file shows "one layout, 82% of the unsplit lines" at a glance and
 * nobody has to pipe slices through the parser by hand. A shape holds no value. All fixtures are synthetic.
 */
import { describe, expect, test } from 'vitest'
import { parseULPStream, type StreamBatch } from '@/lib/ulp-parser'

async function batches(lines: string[]): Promise<StreamBatch[]> {
  const body = new Response(lines.join('\n') + '\n').body as ReadableStream<Uint8Array>
  const out: StreamBatch[] = []
  for await (const b of parseULPStream(body, 'unsplit-shapes.txt', 100_000, undefined, { dedupInFile: false })) out.push(b)
  return out
}
const shapesOf = async (lines: string[]): Promise<Map<string, number>> => {
  const m = new Map<string, number>()
  for (const b of await batches(lines)) for (const [s, n] of b.unsplitShapes ?? []) m.set(s, (m.get(s) ?? 0) + n)
  return m
}

describe('unsplit shapes in a stream batch', () => {
  test('a line that could hold a credential and could not be split is reported by its masked shape, counted per shape', async () => {
    const m = await shapesOf(['alice Secret1 extra words', 'bob Secret2 more text', 'one two'])
    expect(m.get('w w w w')).toBe(2)
    expect(m.get('w w')).toBe(1)
    expect(m.size).toBe(2)
  })

  test('the punctuation stays, the words do not', async () => {
    const m = await shapesOf(['alice:Secret1 https://shop.example.test extra'])
    expect([...m.keys()]).toEqual(['w:w w://w w'])
  })

  test('no value is in a shape: no letter or digit of the line survives', async () => {
    const m = await shapesOf(['alice Secret1 extra words', 'alice:Secret1 https://shop.example.test extra'])
    for (const shape of m.keys()) expect(shape).not.toMatch(/alice|secret|shop|example|extra|words|[0-9]/i)
  })

  test('lines that cannot hold a credential at all (a url with empty fields) are left out, as the gate leaves them out of its unsplit share', async () => {
    const m = await shapesOf(['host.test/login::', '=== ===', 'one two'])
    expect([...m.entries()]).toEqual([['w w', 1]])
  })

  test('stored lines and lines rejected for another reason add nothing', async () => {
    const m = await shapesOf(['alice:Secret1', 'https://shop.example.test/login:alice:ab', 'UNKNOWN:Secret1'])
    expect(m.size).toBe(0)
  })

  test('a batch with none carries no field', async () => {
    const [b] = await batches(['alice:Secret1'])
    expect('unsplitShapes' in b).toBe(false)
  })

  test('at most 200 distinct shapes per batch: the rest are counted together as "(other shapes)"', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `a ${'.'.repeat(i % 250)}`) // 250 distinct punctuation patterns... made unsplit by the words only
    const distinct = Array.from({ length: 400 }, (_, i) => `x${'!'.repeat(i + 1)} y ${'?'.repeat((i % 7) + 1)}`)
    const [b] = await batches([...lines, ...distinct])
    const shapes = b.unsplitShapes ?? []
    expect(shapes.length).toBeLessThanOrEqual(201)
    const total = shapes.reduce((n, [, c]) => n + c, 0)
    expect(total).toBe(b.breakdown.no_fields - (b.noCredential ?? 0))
  })
})
