/** classifyChange names the reason a line's result differs between the baseline parser and parser v6; "unexplained" must stay empty on real data. */
import { describe, expect, test } from 'vitest'
import { classifyChange, classifyOldOnlyRow, type Outcome } from '@/lib/parser-diff'

const none = (reason: string): Outcome => ({ credential: null, reason })
const row = (url: string, email: string, password: string): Outcome => ({ credential: { url, email, password }, reason: null })
const asRead = (s: string) => Buffer.from(s, 'utf8').toString('latin1')

describe('classifyChange', () => {
  test('identical results and two rejections are not changes', () => {
    expect(classifyChange('a', row('u', 'e', 'p'), row('u', 'e', 'p'), none('x'))).toBe('same')
    expect(classifyChange('a', none('no_fields'), none('garbage'), none('x'))).toBe('same')
  })
  test.each([
    ['shop.example.test : alice@mail.test : Secret1', 'padded-colons'],
    ['AbCdEfGhIjKlMnOpQrSt==@com.example.app/:alice@mail.test:Secret1', 'android-no-scheme'],
    ['//shop.example.test/login:alice:Secret1', 'protocol-relative'],
    ['https://shop.example.test:alice:Pass/word1', 'slash-in-password'],
    ['https://shop.example.test:48213:Secret1', 'numeric-login'],
  ])('a rejected line now stored: %s is %s', (line, cls) => {
    expect(classifyChange(line, none('garbage'), row('u', 'e', 'p'), none('garbage'))).toBe(cls)
  })
  test('a login equal to the password, not an e-mail', () => {
    expect(classifyChange('https://shop.example.test/login:admin:admin', none('no_password'), row('https://shop.example.test/login', 'admin', 'admin'), none('no_password'))).toBe('login-equals-password')
  })
  test('a T3 line the keep-list lets through', () => {
    expect(classifyChange('https://shop.example.pl/login:pawel:Secret1', none('tier_dropped'), row('u', 'pawel', 'Secret1'), none('tier_dropped'))).toBe('t3-kept')
  })
  test('UTF-8: a rejected line stored once decoded, and a stored value that changes', () => {
    const line = asRead('https://shop.example.test/login:Иван:Secret1')
    expect(classifyChange(line, none('garbage'), row('u', 'Иван', 'Secret1'), row('u', 'Иван', 'Secret1'))).toBe('utf8-recovered')
    const pw = asRead('https://shop.example.test/login:alice:café123')
    expect(classifyChange(pw, row('u', 'alice', 'cafÃ©123'), row('u', 'alice', 'café123'), row('u', 'alice', 'café123'))).toBe('utf8-value')
  })
  test('everything else is unexplained: a lost row, a changed value without a high byte, a stored line nothing explains', () => {
    expect(classifyChange('a:b:c', row('u', 'e', 'p'), none('garbage'), none('garbage'))).toBe('unexplained')
    expect(classifyChange('a:b:c', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'))).toBe('unexplained')
    expect(classifyChange('plain:line:here', none('no_fields'), row('u', 'e', 'p'), none('no_fields'))).toBe('unexplained')
  })
})

describe('Android lines whose old result was a mangled row', () => {
  const hash = 'AbCdEfGhIjKlMnOpQrSt'
  test('a changed result on an app id without its scheme belongs to rule B, whatever the old result was', () => {
    const line = `${hash}==@ar.gob.ar/:20123:do456`
    expect(classifyChange(line, row('', `${hash}==@ar.gob.ar/`, '20123:do456'), row('android://x', '20123', 'do456'), none('x'))).toBe('android-no-scheme')
    expect(classifyChange(line, row('', `${hash}==@ar.gob.ar/`, '20123:do456'), none('garbage'), none('x'))).toBe('android-no-scheme')
  })
})

describe('utf8-lost: stored by the old parser, rejected once the line is decoded', () => {
  test('the old parser rejects the repaired line too, so the repair explains it', () => {
    const line = asRead('https://shop.example.test/login:alice:何')
    expect(classifyChange(line, row('u', 'alice', '何'.length ? 'Ã¤Â½Â\u0095' : ''), none('no_password'), none('no_password'))).toBe('utf8-lost')
  })
})

describe('classifyOldOnlyRow', () => {
  test.each([
    [{ url: 'https://x.test/', email: 'alice', password: 'cafÃ©123' }, 'double-encoded'],
    [{ url: '', email: 'AbCdEfGhIjKlMnOpQrSt==@ar.gob.ar/', password: '20123:do456' }, 'android-mangled'],
    [{ url: 'https://x.test/', email: 'alice', password: 'caf\u00e9123' }, 'utf8-text'],
    [{ url: 'https://x.test/', email: 'alice', password: 'Secret1' }, 'unexplained'],
  ])('%j is %s', (r, cls) => expect(classifyOldOnlyRow(r)).toBe(cls))
})
