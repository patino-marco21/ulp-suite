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
