/**
 * Tests for block-format stealer log parsing (Raccoon/Stealc/Meta/Vidar style).
 * These stealers produce labeled multiline blocks instead of inline ULP lines.
 */

import { describe, test, expect } from 'vitest'
import {
  classifyBlockLabel,
  isBlockSeparator,
  makeBlockState,
  flushBlockState,
  parseBlockLine,
  parseBlockContent,
  parseULPContent,
  type BlockState,
} from '@/lib/ulp-parser'

const src = 'block-test.txt'

// ─────────────────────────────────────────────────────────────────────────────
// §A  classifyBlockLabel
// ─────────────────────────────────────────────────────────────────────────────

describe('§A classifyBlockLabel', () => {

  describe('url aliases', () => {
    test('Host: https://site.com → {field:url, value:https://site.com}', () => {
      expect(classifyBlockLabel('Host: https://site.com')).toEqual({ field: 'url', value: 'https://site.com' })
    })
    test('URL: https://site.com → url', () => {
      expect(classifyBlockLabel('URL: https://site.com')).toEqual({ field: 'url', value: 'https://site.com' })
    })
    test('Hostname: site.com → url', () => {
      expect(classifyBlockLabel('Hostname: site.com')).toEqual({ field: 'url', value: 'site.com' })
    })
    test('host: (lowercase) → url', () => {
      expect(classifyBlockLabel('host: http://example.com')).toEqual({ field: 'url', value: 'http://example.com' })
    })
    test('HOST: (uppercase) → url', () => {
      expect(classifyBlockLabel('HOST: https://example.com')).toEqual({ field: 'url', value: 'https://example.com' })
    })
    test('Host: (empty value) → {field:url, value:""}', () => {
      expect(classifyBlockLabel('Host:')).toEqual({ field: 'url', value: '' })
    })
  })

  describe('login aliases', () => {
    test('Login: user@example.com → login', () => {
      expect(classifyBlockLabel('Login: user@example.com')).toEqual({ field: 'login', value: 'user@example.com' })
    })
    test('Username: player99 → login', () => {
      expect(classifyBlockLabel('Username: player99')).toEqual({ field: 'login', value: 'player99' })
    })
    test('User: alice → login', () => {
      expect(classifyBlockLabel('User: alice')).toEqual({ field: 'login', value: 'alice' })
    })
    test('USER: BOB (uppercase) → login', () => {
      expect(classifyBlockLabel('USER: BOB')).toEqual({ field: 'login', value: 'BOB' })
    })
    test('user: (lowercase key) → login', () => {
      expect(classifyBlockLabel('user: alice')).toEqual({ field: 'login', value: 'alice' })
    })
  })

  describe('password aliases', () => {
    test('Password: P@ssword123 → password', () => {
      expect(classifyBlockLabel('Password: P@ssword123')).toEqual({ field: 'password', value: 'P@ssword123' })
    })
    test('Pass: abc123 → password', () => {
      expect(classifyBlockLabel('Pass: abc123')).toEqual({ field: 'password', value: 'abc123' })
    })
    test('Pwd: secret → password', () => {
      expect(classifyBlockLabel('Pwd: secret')).toEqual({ field: 'password', value: 'secret' })
    })
    test('PASSWORD: (uppercase) → password', () => {
      expect(classifyBlockLabel('PASSWORD: hunter2')).toEqual({ field: 'password', value: 'hunter2' })
    })
    test('PASS: (uppercase) → password', () => {
      expect(classifyBlockLabel('PASS: hunter2')).toEqual({ field: 'password', value: 'hunter2' })
    })
  })

  describe('soft/metadata aliases', () => {
    test('Soft: Google Chrome [Default] → soft', () => {
      expect(classifyBlockLabel('Soft: Google Chrome [Default]')).toEqual({ field: 'soft', value: 'Google Chrome [Default]' })
    })
    test('Application: Firefox → soft', () => {
      expect(classifyBlockLabel('Application: Firefox')).toEqual({ field: 'soft', value: 'Firefox' })
    })
    test('browser: Edge → soft', () => {
      expect(classifyBlockLabel('browser: Edge')).toEqual({ field: 'soft', value: 'Edge' })
    })
  })

  describe('non-labels → null', () => {
    test('random: line → null', () => {
      expect(classifyBlockLabel('random: line')).toBeNull()
    })
    test('no colon at all → null', () => {
      expect(classifyBlockLabel('just some text')).toBeNull()
    })
    test('https://site.com → null (URL is not a label)', () => {
      expect(classifyBlockLabel('https://site.com')).toBeNull()
    })
    test('======== separator → null', () => {
      expect(classifyBlockLabel('========================')).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §B  isBlockSeparator
// ─────────────────────────────────────────────────────────────────────────────

describe('§B isBlockSeparator', () => {
  test('empty string → true', () => { expect(isBlockSeparator('')).toBe(true) })
  test('=== line → true', () => { expect(isBlockSeparator('==========================')).toBe(true) })
  test('--- line → true', () => { expect(isBlockSeparator('----------------------------')).toBe(true) })
  test('>>> line → true', () => { expect(isBlockSeparator('>>>>>>>')).toBe(true) })
  test('mixed === → true', () => { expect(isBlockSeparator('===')).toBe(true) })
  test('regular text → false', () => { expect(isBlockSeparator('Host: example.com')).toBe(false) })
  test('https URL → false', () => { expect(isBlockSeparator('https://example.com')).toBe(false) })
  test('single char = → false (too short)', () => { expect(isBlockSeparator('=')).toBe(false) })
})

// ─────────────────────────────────────────────────────────────────────────────
// §C  flushBlockState
// ─────────────────────────────────────────────────────────────────────────────

describe('§C flushBlockState', () => {
  test('complete state → ULPCredential with correct fields', () => {
    const state: BlockState = { url: 'https://roblox.com/login', login: 'player@gmail.com', password: 'P@ssword123' }
    const c = flushBlockState(state, src)
    expect(c).not.toBeNull()
    expect(c!.url).toBe('https://roblox.com/login')
    expect(c!.email).toBe('player@gmail.com')
    expect(c!.password).toBe('P@ssword123')
    expect(c!.domain).toBe('roblox.com')
    expect(c!.source_file).toBe(src)
  })

  test('missing login → null', () => {
    const state: BlockState = { url: 'https://site.com', login: '', password: 'pass123' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('missing password → null', () => {
    const state: BlockState = { url: 'https://site.com', login: 'user', password: '' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('password < 3 chars → null', () => {
    const state: BlockState = { url: 'https://site.com', login: 'user', password: 'ab' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('login === password → null', () => {
    const state: BlockState = { url: 'https://site.com', login: 'same', password: 'same' }
    expect(flushBlockState(state, src)).toBeNull()
  })

  test('missing url → domain fallback to email domain', () => {
    const state: BlockState = { url: '', login: 'user@gmail.com', password: 'mypassword1' }
    const c = flushBlockState(state, src)
    expect(c).not.toBeNull()
    expect(c!.url).toBe('')
    expect(c!.domain).toBe('gmail.com')
  })

  test('missing url + non-email login → domain empty', () => {
    const state: BlockState = { url: '', login: 'localuser', password: 'mypassword1' }
    const c = flushBlockState(state, src)
    expect(c).not.toBeNull()
    expect(c!.domain).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §D  parseBlockLine — state machine transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('§D parseBlockLine', () => {
  test('Host line → returns "field", sets state.url', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Host: https://site.com', state)
    expect(result).toBe('field')
    expect(state.url).toBe('https://site.com')
  })

  test('Login line → returns "field", sets state.login', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Login: user@site.com', state)
    expect(result).toBe('field')
    expect(state.login).toBe('user@site.com')
  })

  test('Password line → returns "field", sets state.password', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Password: hunter2pass', state)
    expect(result).toBe('field')
    expect(state.password).toBe('hunter2pass')
  })

  test('Soft line → returns "field", does NOT change url/login/password', () => {
    const state = makeBlockState()
    const result = parseBlockLine('Soft: Chrome', state)
    expect(result).toBe('field')
    expect(state.url).toBe('')
    expect(state.login).toBe('')
    expect(state.password).toBe('')
  })

  test('separator line → returns "separator"', () => {
    const state = makeBlockState()
    const result = parseBlockLine('======================', state)
    expect(result).toBe('separator')
  })

  test('blank line → returns "separator"', () => {
    const state = makeBlockState()
    expect(parseBlockLine('', state)).toBe('separator')
  })

  test('unrecognised line → returns "ignored"', () => {
    const state = makeBlockState()
    expect(parseBlockLine('some random text 123', state)).toBe('ignored')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §E  parseBlockContent — full integration
// ─────────────────────────────────────────────────────────────────────────────

describe('§E parseBlockContent', () => {
  test('single complete block → 1 credential', () => {
    const content = [
      'Soft: Chrome',
      'Host: https://roblox.com/login',
      'Login: player@gmail.com',
      'Password: P@ssword123!',
      '=============================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('https://roblox.com/login')
    expect(result.credentials[0].email).toBe('player@gmail.com')
    expect(result.credentials[0].password).toBe('P@ssword123!')
    expect(result.credentials[0].domain).toBe('roblox.com')
  })

  test('two blocks separated by === → 2 credentials', () => {
    const content = [
      'Host: https://site1.com',
      'Login: alice@gmail.com',
      'Password: alicepass1',
      '================',
      'Host: https://site2.com',
      'Login: bob@gmail.com',
      'Password: bobpass123',
      '================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(2)
    expect(result.credentials[0].email).toBe('alice@gmail.com')
    expect(result.credentials[1].email).toBe('bob@gmail.com')
  })

  test('two blocks separated by blank line → 2 credentials', () => {
    const content = [
      'Host: https://site1.com',
      'Login: alice@gmail.com',
      'Password: alicepass1',
      '',
      'Host: https://site2.com',
      'Login: bob@gmail.com',
      'Password: bobpass123',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(2)
  })

  test('block missing password → 0 credentials (incomplete)', () => {
    const content = [
      'Host: https://site.com',
      'Login: user@example.com',
      '================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(0)
  })

  test('block missing url → credential with url="" and domain from email', () => {
    const content = [
      'Login: user@example.com',
      'Password: mypassword123',
      '================',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('')
    expect(result.credentials[0].domain).toBe('example.com')
  })

  test('last block without trailing separator → still emitted', () => {
    const content = [
      'Host: https://site.com',
      'Login: user@example.com',
      'Password: mypassword123',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
  })

  test('source_file set on every credential', () => {
    const content = 'Host: https://site.com\nLogin: u@e.com\nPassword: pass123\n===\n'
    const result = parseBlockContent(content, 'myfile.txt')
    expect(result.credentials[0].source_file).toBe('myfile.txt')
  })

  test('fields in any order (Password before Login before Host)', () => {
    const content = [
      'Password: hunter2pass',
      'Login: user@site.com',
      'Host: https://site.com',
      '===',
    ].join('\n')
    const result = parseBlockContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].email).toBe('user@site.com')
    expect(result.credentials[0].password).toBe('hunter2pass')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §F  Extended label aliases (from milxss parser + Lexfo research)
// ─────────────────────────────────────────────────────────────────────────────

describe('§F Extended label aliases', () => {

  describe('url aliases', () => {
    test('UR1: (leet-obfuscated URL) → url field', () => {
      expect(classifyBlockLabel('UR1: https://site.com')).toEqual({ field: 'url', value: 'https://site.com' })
    })
    test('Url: (mixed case) → url field', () => {
      expect(classifyBlockLabel('Url: https://site.com')).toEqual({ field: 'url', value: 'https://site.com' })
    })
    test('HOSTNAME: (all caps) → url field', () => {
      expect(classifyBlockLabel('HOSTNAME: site.com')).toEqual({ field: 'url', value: 'site.com' })
    })
  })

  describe('login aliases', () => {
    test('Email: user@domain.com → login field', () => {
      expect(classifyBlockLabel('Email: user@example.com')).toEqual({ field: 'login', value: 'user@example.com' })
    })
    test('E-mail: user@domain.com → login field', () => {
      expect(classifyBlockLabel('E-mail: user@example.com')).toEqual({ field: 'login', value: 'user@example.com' })
    })
    test('U53RN4M3: (leet-obfuscated USERNAME) → login field', () => {
      expect(classifyBlockLabel('U53RN4M3: hacker99')).toEqual({ field: 'login', value: 'hacker99' })
    })
    test('USER LOGIN: admin → login field (multi-word label)', () => {
      expect(classifyBlockLabel('USER LOGIN: admin')).toEqual({ field: 'login', value: 'admin' })
    })
  })

  describe('password aliases', () => {
    test('USER PASSWORD: secret → password field (multi-word label)', () => {
      expect(classifyBlockLabel('USER PASSWORD: secret123')).toEqual({ field: 'password', value: 'secret123' })
    })
  })

  describe('soft aliases', () => {
    test('Storage: Chrome Default → soft field', () => {
      expect(classifyBlockLabel('Storage: Chrome Default')).toEqual({ field: 'soft', value: 'Chrome Default' })
    })
  })

  describe('full block with new aliases', () => {
    test('SOFT/URL/USER/PASS (uppercase) block parses correctly', () => {
      const content = [
        'SOFT: Firefox ESR',
        'URL: https://example.com/login',
        'USER: john@example.com',
        'PASS: hunter2pass',
        '================',
      ].join('\n')
      const result = parseBlockContent(content, src)
      expect(result.credentials).toHaveLength(1)
      expect(result.credentials[0].url).toBe('https://example.com/login')
      expect(result.credentials[0].email).toBe('john@example.com')
      expect(result.credentials[0].password).toBe('hunter2pass')
    })

    test('Email: field as login alias in full block', () => {
      const content = [
        'Host: https://mail.google.com',
        'Email: victim@gmail.com',
        'Password: gmail_pass123',
        '===',
      ].join('\n')
      const result = parseBlockContent(content, src)
      expect(result.credentials).toHaveLength(1)
      expect(result.credentials[0].email).toBe('victim@gmail.com')
    })

    test('USER LOGIN / USER PASSWORD multi-word block', () => {
      const content = [
        'HOST: https://corporate.com/login',
        'USER LOGIN: jsmith',
        'USER PASSWORD: Corp$ecret99',
        '===',
      ].join('\n')
      const result = parseBlockContent(content, src)
      expect(result.credentials).toHaveLength(1)
      expect(result.credentials[0].email).toBe('jsmith')
      expect(result.credentials[0].password).toBe('Corp$ecret99')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §G  Positional (label-free) 3-line stealer log format via parseULPContent
//
// Some stealers (e.g. purely positional Raccoon variants) write blocks like:
//   https://site.com/login    ← URL (no prefix)
//   user@email.com            ← login
//   password123               ← password
//   (blank line separates blocks)
// ─────────────────────────────────────────────────────────────────────────────

describe('§G Positional 3-line format (parseULPContent)', () => {

  // ── §G1  Single block, blank-line separator ──────────────────────────────

  test('§G1a single block emits one credential', () => {
    const content = [
      'https://example.com/login',
      'user@example.com',
      'hunter2',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('https://example.com/login')
    expect(result.credentials[0].email).toBe('user@example.com')
    expect(result.credentials[0].password).toBe('hunter2')
  })

  test('§G1b domain extracted from positional URL', () => {
    const content = [
      'https://accounts.google.com/signin/v2',
      'victim@gmail.com',
      'Pa$$word99',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].domain).toBe('accounts.google.com')
  })

  test('§G1c source_file set correctly', () => {
    const content = [
      'https://bank.com/login',
      'john',
      'secret123',
      '',
    ].join('\n')
    const result = parseULPContent(content, 'stealer-dump.txt')
    expect(result.credentials[0].source_file).toBe('stealer-dump.txt')
  })

  // ── §G2  Multiple blocks ──────────────────────────────────────────────────

  test('§G2a two blocks separated by blank line → 2 credentials', () => {
    const content = [
      'https://site1.com/a',
      'alice@site1.com',
      'pass_alice',
      '',
      'https://site2.com/b',
      'bob@site2.com',
      'pass_bob',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(2)
    expect(result.credentials[0].email).toBe('alice@site1.com')
    expect(result.credentials[1].email).toBe('bob@site2.com')
  })

  test('§G2b three blocks in a row → 3 credentials', () => {
    const blocks: string[] = []
    for (let i = 1; i <= 3; i++) {
      blocks.push(`https://site${i}.com/login`, `user${i}@test.com`, `pass${i}xyz`, '')
    }
    const result = parseULPContent(blocks.join('\n'), src)
    expect(result.credentials).toHaveLength(3)
  })

  test('§G2c === separator between blocks → 2 credentials', () => {
    const content = [
      'https://site1.com/login',
      'alice',
      'alicepass',
      '===',
      'https://site2.com/login',
      'bob',
      'bobpass',
      '===',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(2)
  })

  test('§G2d 40-char dash separator between blocks → 2 credentials', () => {
    const sep = '-'.repeat(40)
    const content = [
      'https://a.com/login', 'user1', 'pw1234', sep,
      'https://b.com/login', 'user2', 'pw5678', sep,
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(2)
  })

  // ── §G3  Metadata lines mixed in ─────────────────────────────────────────

  test('§G3a metadata lines before URL are skipped, credential still emitted', () => {
    // Realistic stealer log metadata has NO colons — plain values, not "Key: Value".
    // Lines without colons return no_fields from parseLine and are simply skipped.
    const content = [
      'United States',
      '192.168.1.100',
      '20240115-143022',
      'https://example.com/login',
      'user@example.com',
      'mypassword',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].email).toBe('user@example.com')
  })

  test('§G3b metadata lines after password are skipped, only 1 credential from the URL+login+pass triplet', () => {
    // After emitting the positional credential, colon-free metadata lines fall
    // to parseLine which rejects them (no colon → no_fields).
    const content = [
      'https://example.com/login',
      'user@example.com',
      'mypassword',
      'Win11',
      'Chrome120',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].password).toBe('mypassword')
  })

  test('§G3c heavy metadata block (10 colon-free lines before cred) → 1 credential', () => {
    // These metadata lines have no colons so parseLine rejects all of them.
    const meta = [
      'RU', '10.0.0.1', '20230601', 'v2.4.0',
      'abc123', 'Win10', 'Firefox', 'default', 'no', 'no',
    ]
    const content = [
      ...meta,
      'https://target.com/auth',
      'victim@target.com',
      'T@rgetPass1',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('https://target.com/auth')
  })

  // ── §G4  Incomplete blocks (should NOT emit) ──────────────────────────────

  test('§G4a URL + login but no password (EOF) → 0 credentials', () => {
    const content = [
      'https://example.com/login',
      'user@example.com',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(0)
  })

  test('§G4b URL only (separator before login) → 0 credentials', () => {
    const content = [
      'https://example.com/login',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(0)
  })

  test('§G4c URL + login separated by === before password → 0 credentials', () => {
    const content = [
      'https://example.com/login',
      'user@example.com',
      '===',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(0)
  })

  // ── §G5  Interaction with inline ULP lines ───────────────────────────────

  test('§G5a inline ULP line after positional block → both emitted', () => {
    const content = [
      'https://site.com/login',
      'posuser@site.com',
      'pospassword',
      '',
      'https://inline.com/path:inlineuser:inlinepass',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(2)
    const emails = result.credentials.map(c => c.email)
    expect(emails).toContain('posuser@site.com')
    expect(emails).toContain('inlineuser')
  })

  test('§G5b inline ULP line before positional block → both emitted', () => {
    const content = [
      'https://inline.com/path:inlineuser:inlinepass',
      '',
      'https://site.com/login',
      'posuser@site.com',
      'pospassword',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(2)
  })

  // ── §G6  Labeled blocks still work alongside positional blocks ───────────

  test('§G6a labeled block followed by positional block → 2 credentials', () => {
    const content = [
      'Host: https://labeled.com/login',
      'Login: labeled_user',
      'Password: labeled_pass',
      '===',
      'https://positional.com/login',
      'pos_user@positional.com',
      'pos_pass',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(2)
    const emails = result.credentials.map(c => c.email)
    expect(emails).toContain('labeled_user')
    expect(emails).toContain('pos_user@positional.com')
  })

  test('§G6b labeled line resets positional state (no cross-contamination)', () => {
    // URL line followed immediately by a labeled field — the labeled line must
    // discard the in-progress positional URL and switch to labeled mode.
    const content = [
      'https://positional-url-discarded.com/login',
      'Host: https://correct.com/login',
      'Login: correct_user',
      'Password: correct_pass',
      '===',
    ].join('\n')
    const result = parseULPContent(content, src)
    // Only the labeled block should emit; the dangling positional URL is discarded
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('https://correct.com/login')
    expect(result.credentials[0].email).toBe('correct_user')
  })

  // ── §G7  http:// URLs (not just https://) ────────────────────────────────

  test('§G7 http:// URL triggers positional mode', () => {
    const content = [
      'http://legacy-site.com/login',
      'legacy_user',
      'legacy_pass99',
      '',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].url).toBe('http://legacy-site.com/login')
  })

  // ── §G8  BLOCK_SOFT_LABELS includes 'software' ───────────────────────────

  test('§G8 "software" label classified as soft field (not url/login/pass)', () => {
    // A "Software: Google Chrome" line must be silently consumed (not mistaken
    // for a URL/login/password labeled field).
    const content = [
      'Host: https://example.com/login',
      'Software: Google Chrome 120',
      'Login: soft_user',
      'Password: soft_pass',
      '===',
    ].join('\n')
    const result = parseULPContent(content, src)
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].email).toBe('soft_user')
    expect(result.credentials[0].password).toBe('soft_pass')
  })
})
