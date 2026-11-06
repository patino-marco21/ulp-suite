import { describe, expect, test } from 'vitest'
import { rehearsalImageProblem } from '../scripts/rehearsal-image'

/**
 * The end-to-end scripts that recreate the rehearsal app through compose take the image from REHEARSAL_APP_IMAGE. When the stack was brought up on a candidate
 * and the variable is not exported for the next script, the app comes back on the previous `:latest` and the scenarios run on the wrong code (2026-11-06: three
 * checks of a new scenario failed for that reason, not because of the code). The guard compares the image the rehearsal app runs on with the one a recreate would use.
 */
describe('rehearsalImageProblem', () => {
  test('the stack runs on the candidate and the variable names it: fine', () => {
    expect(rehearsalImageProblem('ulp-suite-app:v64-candidate', 'ulp-suite-app:v64-candidate')).toBeNull()
  })

  test('the stack runs on :latest and the variable is unset or blank: fine', () => {
    expect(rehearsalImageProblem('ulp-suite-app:latest', undefined)).toBeNull()
    expect(rehearsalImageProblem('ulp-suite-app:latest', '')).toBeNull()
    expect(rehearsalImageProblem('ulp-suite-app:latest', '   ')).toBeNull()
  })

  test('the stack runs on a candidate and the variable is not exported: the recreate would fall back to :latest', () => {
    const msg = rehearsalImageProblem('ulp-suite-app:v64-candidate', undefined)
    expect(msg).toContain('ulp-suite-app:v64-candidate')
    expect(msg).toContain('ulp-suite-app:latest')
    expect(msg).toContain('REHEARSAL_APP_IMAGE')
  })

  test('the variable names another image than the one the stack runs on', () => {
    const msg = rehearsalImageProblem('ulp-suite-app:latest', 'ulp-suite-app:v65-candidate')
    expect(msg).toContain('ulp-suite-app:v65-candidate')
    expect(msg).toContain('ulp-suite-app:latest')
  })

  test('surrounding white space in the variable is ignored', () => {
    expect(rehearsalImageProblem('ulp-suite-app:v64-candidate', ' ulp-suite-app:v64-candidate ')).toBeNull()
  })
})
