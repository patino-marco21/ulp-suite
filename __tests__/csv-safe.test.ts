import { describe, expect, test } from 'vitest'
import { csvCell } from '@/lib/csv-safe'

describe('csvCell', () => {
  test('quotes a plain value', () => {
    expect(csvCell('abc')).toBe('"abc"')
  })

  test.each([
    ['=1+1', `"'=1+1"`],
    ['+1', `"'+1"`],
    ['-1', `"'-1"`],
    ['@SUM(A1)', `"'@SUM(A1)"`],
    ['\tx', `"'\tx"`],
    ['\rx', `"'\rx"`],
  ])('prefixes %j with a single quote', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  test('a numeric-looking negative value is guarded too', () => {
    expect(csvCell('-12345')).toBe(`"'-12345"`)
  })

  test('only the FIRST character decides: a leading space, or a trigger later in the value, is left alone', () => {
    expect(csvCell(' =1')).toBe('" =1"')
    expect(csvCell('a=1')).toBe('"a=1"')
    expect(csvCell('user@example.test')).toBe('"user@example.test"')
  })

  test('doubles embedded quotes, before or after the guard', () => {
    expect(csvCell('a"b')).toBe('"a""b"')
    expect(csvCell('=a"b')).toBe(`"'=a""b"`)
  })

  test('keeps newlines and Unicode inside the quoted cell', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('é✓')).toBe('"é✓"')
  })

  test('empty, null and undefined are an empty cell', () => {
    expect(csvCell('')).toBe('""')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })

  test('numbers are stringified', () => {
    expect(csvCell(12)).toBe('"12"')
  })

  test('guard=false gives the old bytes', () => {
    expect(csvCell('=1+1', false)).toBe('"=1+1"')
    expect(csvCell('-12345', false)).toBe('"-12345"')
  })
})
