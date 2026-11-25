import { describe, expect, it } from 'vitest'
import { passwordProblems as problems } from '@/lib/validation'

const LENGTH = 'Password must be at least 12 characters'
const UPPER = 'Password must contain at least one uppercase letter'
const LOWER = 'Password must contain at least one lowercase letter'
const DIGIT = 'Password must contain at least one number'
const SPECIAL = 'Password must contain at least one special character'

describe('the new-password policy', () => {
  it('accepts 12 characters with an upper case letter, a lower case letter, a digit and a special character', () => {
    expect(problems('Abcdefghij1!')).toEqual([])
  })

  it('counts length at 12, not 11', () => {
    expect(problems('Abcdefghi1!')).toEqual([LENGTH])
  })

  it('names every rule that fails, in the order length, upper, lower, digit, special', () => {
    expect(problems('')).toEqual([LENGTH, UPPER, LOWER, DIGIT, SPECIAL])
    expect(problems('abcdefghijkl')).toEqual([UPPER, DIGIT, SPECIAL])
    expect(problems('ABCDEFGHIJKL')).toEqual([LOWER, DIGIT, SPECIAL])
    expect(problems('Abcdefghijkl')).toEqual([DIGIT, SPECIAL])
    expect(problems('Abcdefghijk1')).toEqual([SPECIAL])
    expect(problems('Abcdefghijk!')).toEqual([DIGIT])
  })

  it('counts anything outside A-Z, a-z and 0-9 as special: a space, an accented letter, an emoji', () => {
    expect(problems('Abcdefghij 1')).toEqual([])
    expect(problems('Abcdefghijk1ä')).toEqual([])
    expect(problems('Abcdefghi1😀')).toEqual([])
  })

  it('measures length in UTF-16 code units, so an emoji counts as two', () => {
    expect(problems('Abcdefgh1😀')).toEqual([LENGTH])
  })

  it('rejects a value that is not a string with one message and no rule messages', () => {
    expect(problems(undefined)).toEqual(['Required'])
    expect(problems(null)).toEqual(['Expected string, received null'])
    expect(problems(123456789012)).toEqual(['Expected string, received number'])
  })
})
