/**
 * A guard for the rehearsal scripts that recreate the app through compose (e2e-novelty-ingest, e2e-disk-gate, e2e-batch-lookup). Compose takes the app's image from
 * REHEARSAL_APP_IMAGE and falls back to `ulp-suite-app:latest` when it is not exported for THAT script, so a stack brought up on a candidate came back on the previous
 * image and the scenarios ran on the wrong code (2026-11-06, three false failures). The scripts call assertRehearsalImage() first and stop with exit code 2.
 */
import { execFileSync } from 'node:child_process'

export const DEFAULT_REHEARSAL_IMAGE = 'ulp-suite-app:latest'

/** Why a script that recreates the app must not start, or null. `running` is the image the rehearsal app runs on, `wanted` the REHEARSAL_APP_IMAGE of this script. */
export function rehearsalImageProblem(running: string, wanted: string | undefined): string | null {
  const next = wanted?.trim() || DEFAULT_REHEARSAL_IMAGE
  if (running === next) return null
  return `the rehearsal app runs on ${running}, but this script recreates it on ${next} (REHEARSAL_APP_IMAGE ${wanted?.trim() ? `is ${wanted.trim()}` : 'is not exported for this script'}). `
    + `Export REHEARSAL_APP_IMAGE=${running} for it, or bring the stack up again on the image you mean to test.`
}

/** The image the container runs on (what compose was told), or null when there is no such container. */
function runningImage(container: string): string | null {
  try {
    return execFileSync('docker', ['inspect', '-f', '{{.Config.Image}}', container], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** Prints the image under test and returns the problem text, or null. A missing container is the script's own readiness check to report. */
export function assertRehearsalImage(container: string, wanted: string | undefined = process.env.REHEARSAL_APP_IMAGE): string | null {
  const running = runningImage(container)
  if (running === null) return null
  console.log(`Rehearsal image: ${running}`)
  return rehearsalImageProblem(running, wanted)
}
