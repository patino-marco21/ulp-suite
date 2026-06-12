/**
 * Smoke test for ULP Vault local dev environment.
 * Run: node test-data/smoke-test.mjs
 */
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const BASE = 'http://localhost:3000'
const __dir = dirname(fileURLToPath(import.meta.url))

async function req(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } }
  if (body) {
    if (typeof body === 'string') {
      opts.body = body
      opts.headers['Content-Type'] = 'application/json'
    } else {
      opts.body = body
    }
  }
  const r = await fetch(`${BASE}${path}`, opts)
  const ct = r.headers.get('content-type') || ''
  const data = ct.includes('json') ? await r.json() : await r.text()
  return { status: r.status, data }
}

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  ULP Vault Smoke Test')
  console.log('═══════════════════════════════════════════\n')
  let pass = 0, fail = 0

  function check(label, condition, detail = '') {
    if (condition) {
      console.log(`  ✅ ${label}`)
      pass++
    } else {
      console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`)
      fail++
    }
  }

  // ─── 1. Health check ────────────────────────────────────────────────────────
  console.log('1. App health')
  const health = await req('GET', '/api/auth/check-users')
  check('App responds', health.status === 200)
  check('Admin user seeded', health.data?.userCount >= 1)

  // ─── 2. Login ───────────────────────────────────────────────────────────────
  console.log('\n2. Authentication')
  const login = await req('POST', '/api/auth/login', JSON.stringify({ email: 'admin@ulp.local', password: 'Admin@1234!' }))
  check('Login 200', login.status === 200)
  check('Login success', login.data?.success === true)
  check('Admin role', login.data?.user?.role === 'admin')

  // Extract JWT from cookie header — the login response sets Set-Cookie: auth=<jwt>
  // We use a workaround: re-login via raw fetch to get headers
  const loginRaw = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@ulp.local', password: 'Admin@1234!' }),
  })
  const setCookie = loginRaw.headers.get('set-cookie') || ''
  const jwtMatch = setCookie.match(/auth=([^;]+)/)
  const jwt = jwtMatch ? jwtMatch[1] : null
  check('JWT extracted from cookie', !!jwt)

  if (!jwt) {
    console.log('\n⚠️  Cannot continue without JWT — stopping.\n')
    process.exit(1)
  }
  const auth = { Authorization: `Bearer ${jwt}` }

  // ─── 3. Upload test file ─────────────────────────────────────────────────────
  console.log('\n3. Upload credentials (.txt)')
  const sampleFile = join(__dir, 'sample-credentials.txt')
  if (!existsSync(sampleFile)) {
    console.log('  ⚠️  sample-credentials.txt not found — skipping upload')
  } else {
    const fileBytes = readFileSync(sampleFile)
    const formData = new FormData()
    formData.append('file', new Blob([fileBytes], { type: 'text/plain' }), 'sample-credentials.txt')
    const uploadResp = await fetch(`${BASE}/api/upload`, { method: 'POST', body: formData, headers: auth })
    const uploadData = await uploadResp.json()
    check('Upload 200', uploadResp.status === 200)
    check('Upload success', uploadData?.success === true)
    if (uploadData?.success) {
      console.log(`     Imported: ${uploadData.imported} credentials, skipped: ${uploadData.skipped}`)
      console.log(`     Breach tag: "${uploadData.breach_name || '(none)'}"`)
    } else {
      console.log(`     Error: ${uploadData?.error || JSON.stringify(uploadData)}`)
    }
  }

  // ─── 3b. Upload .csv (semicolon-separated) ───────────────────────────────────
  console.log('\n3b. Upload credentials (.csv, semicolon-separated)')
  const csvFile = join(__dir, 'sample-credentials.csv')
  if (!existsSync(csvFile)) {
    console.log('  ⚠️  sample-credentials.csv not found — skipping upload')
  } else {
    const fileBytes = readFileSync(csvFile)
    const formData = new FormData()
    formData.append('file', new Blob([fileBytes], { type: 'text/csv' }), 'sample-credentials.csv')
    const uploadResp = await fetch(`${BASE}/api/upload`, { method: 'POST', body: formData, headers: auth })
    const uploadData = await uploadResp.json()
    check('CSV upload 200', uploadResp.status === 200)
    check('CSV upload success', uploadData?.success === true)
    check('CSV rows imported', (uploadData?.imported ?? 0) > 0, `imported=${uploadData?.imported}`)
    if (uploadData?.success) {
      console.log(`     Imported: ${uploadData.imported} credentials, skipped: ${uploadData.skipped}`)
    }
  }

  // ─── 3c. Upload extra-format coverage (.txt with pipe/tab/android:// + rejects) ─
  console.log('\n3c. Upload credentials (.txt, extra format coverage)')
  const formatsFile = join(__dir, 'sample-credentials-formats.txt')
  if (!existsSync(formatsFile)) {
    console.log('  ⚠️  sample-credentials-formats.txt not found — skipping upload')
  } else {
    const fileBytes = readFileSync(formatsFile)
    const formData = new FormData()
    formData.append('file', new Blob([fileBytes], { type: 'text/plain' }), 'sample-credentials-formats.txt')
    const uploadResp = await fetch(`${BASE}/api/upload`, { method: 'POST', body: formData, headers: auth })
    const uploadData = await uploadResp.json()
    check('Formats upload 200', uploadResp.status === 200)
    check('Formats upload success', uploadData?.success === true)
    check('Formats: pipe/tab/android:// rows imported', (uploadData?.imported ?? 0) >= 3, `imported=${uploadData?.imported}`)
    check('Formats: rejection breakdown has dedup/no_fields/no_password/blank',
      ['blank', 'no_fields', 'no_password', 'dedup'].every(k => k in (uploadData?.rejection_breakdown ?? {})))
    if (uploadData?.success) {
      console.log(`     Imported: ${uploadData.imported}, skipped: ${uploadData.skipped}`)
      console.log(`     Rejection breakdown: ${JSON.stringify(uploadData.rejection_breakdown)}`)
    }
  }

  // ─── 3d. Upload .zip (multi-entry archive) ───────────────────────────────────
  console.log('\n3d. Upload credentials (.zip, multi-entry)')
  const zipFile = join(__dir, 'sample-credentials.zip')
  if (!existsSync(zipFile)) {
    console.log('  ⚠️  sample-credentials.zip not found — skipping upload')
  } else {
    const fileBytes = readFileSync(zipFile)
    const formData = new FormData()
    formData.append('file', new Blob([fileBytes], { type: 'application/zip' }), 'sample-credentials.zip')
    const uploadResp = await fetch(`${BASE}/api/upload`, { method: 'POST', body: formData, headers: auth })
    const uploadData = await uploadResp.json()
    check('Zip upload 200', uploadResp.status === 200)
    check('Zip upload success', uploadData?.success === true)
    // Archive contains 2 credential files (.txt + .csv), 1 all-rejected readme.txt,
    // and 1 .png that's skipped entirely (not counted as a "file" or an error).
    check('Zip: credential entries imported', (uploadData?.imported ?? 0) > 0, `imported=${uploadData?.imported}`)
    check('Zip: no entry-level errors', (uploadData?.errors ?? -1) === 0, `errors=${uploadData?.errors}`)
    if (uploadData?.success) {
      console.log(`     Imported: ${uploadData.imported}, skipped: ${uploadData.skipped}, errors: ${uploadData.errors}`)
      console.log(`     Files processed: ${(uploadData.files ?? []).map(f => f.filename).join(', ')}`)
    }
  }

  // Small wait for ClickHouse to flush
  await new Promise(r => setTimeout(r, 1500))

  // ─── 4. Search ──────────────────────────────────────────────────────────────
  console.log('\n4. Search')
  const search = await req('GET', '/api/search?q=gmail.com&limit=10', null, auth)
  check('Search 200', search.status === 200)
  check('Search success', search.data?.success === true)
  check('Results returned', (search.data?.results?.length ?? 0) > 0)
  if (search.data?.results?.length > 0) {
    const first = search.data.results[0]
    console.log(`     First result: ${first.email} / ${first.domain}`)
    check('Credential has domain', !!first.domain)
    check('Credential has email', !!first.email)
    check('Credential has breach_name field', 'breach_name' in first)
  }

  // ─── 5. Breaches catalog ─────────────────────────────────────────────────────
  console.log('\n5. Breaches catalog')
  const breaches = await req('GET', '/api/breaches?limit=10', null, auth)
  check('Breaches 200', breaches.status === 200)
  check('Breaches success', breaches.data?.success === true)
  console.log(`     Breach records: ${breaches.data?.total ?? 0}`)

  // ─── 6. Sources ──────────────────────────────────────────────────────────────
  console.log('\n6. Sources')
  const sources = await req('GET', '/api/sources?limit=5', null, auth)
  check('Sources 200', sources.status === 200)

  // ─── 7. Export (small) ──────────────────────────────────────────────────────
  console.log('\n7. Export')
  const exportResp = await fetch(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ format: 'userpass', query: 'gmail' }),
  })
  check('Export 200', exportResp.status === 200)
  const exportText = await exportResp.text()
  check('Export has content', exportText.length > 0 && exportText.includes(':'))
  console.log(`     Export lines: ${exportText.split('\n').filter(Boolean).length}`)

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════')
  console.log(`  Results: ${pass} passed, ${fail} failed`)
  console.log('═══════════════════════════════════════════')
  if (fail === 0) console.log('\n🚀 All checks passed — ready to use!\n')
  else console.log(`\n⚠️  ${fail} check(s) failed — see above.\n`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('Test script error:', e); process.exit(1) })
