/** classifyChange names the reason a line's result differs between the baseline parser and parser v6; "unexplained" must stay empty on real data. */
import { describe, expect, test } from 'vitest'
import { classifyChange, classifyOldOnlyRow, inertSemicolons, type Outcome } from '@/lib/parser-diff'
import { pipeJoinAll } from '@/lib/ulp-recover'

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
    [{ url: '', email: 'AbCdEfGhIjKlMnOpQrSt==@net.example.me/:25123:abc', password: 'ry123' }, 'android-mangled'],
    [{ url: 'https://shop.example.test:alice@mail.test', email: 'bob::carol@mail.test:Secret1', password: 'https://other.example.test:62 BC:As' }, 'positional-merge'],
    [{ url: 'https://x.test/', email: 'alice', password: 'caf\u00e9123' }, 'utf8-text'],
    [{ url: 'https://x.test/', email: 'alice', password: 'Secret1' }, 'unexplained'],
  ])('%j is %s', (r, cls) => expect(classifyOldOnlyRow(r)).toBe(cls))
})

describe('a line with a pipe tail', () => {
  test('the helpers are tried on the part in front of the first pipe, as parseLine does', () => {
    const line = 'https://shop.example.test:alice:Pass/word1|tail/with/three/slashes/x'
    expect(classifyChange(line, none('no_fields'), row('https://shop.example.test', 'alice', 'Pass/word1'), none('no_fields'))).toBe('slash-in-password')
  })
})

describe('the pipe that joins a url and a credential (parser v6.1)', () => {
  test.each([
    ['https://| shop.example.test:alice:Secret1', 'pipe-scheme'],
    ['Network:| shop.example.test:alice:Secret1', 'pipe-label'],
    ['https://shop.example.test/login|alice:Secret1', 'pipe-url'],
  ])('a changed result equal to the baseline parser on the joined line: %s is %s', (line, cls) => {
    const junk = row('', line.split('|')[0].trim(), 'x')       // what the baseline stored: the scheme, the label or the url as the login
    const joined = row('u', 'alice', 'Secret1')
    expect(classifyChange(line, junk, joined, none('x'), joined)).toBe(cls)
  })
  test('a rejected line now stored, and a junk row that is no longer stored, are the same class', () => {
    const line = 'https://| shop.example.test:alice:Secret1'
    expect(classifyChange(line, none('no_fields'), row('u', 'alice', 'Secret1'), none('x'), row('u', 'alice', 'Secret1'))).toBe('pipe-scheme')
    expect(classifyChange(line, row('', 'https://', 'shop.example.test:alice:Secret1'), none('no_password'), none('x'), none('no_password'))).toBe('pipe-scheme')
  })
  test('a changed result that is NOT what the baseline gives for the joined line stays unexplained', () => {
    const line = 'https://| shop.example.test:alice:Secret1'
    expect(classifyChange(line, row('', 'https://', 'x'), row('u', 'alice', 'Secret1'), none('x'), row('u', 'someone-else', 'Secret1'))).toBe('unexplained')
  })
  test('a line without such a pipe is never attributed to it', () => {
    expect(classifyChange('a:b:c', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'), row('u', 'e', 'p2'))).toBe('unexplained')
  })
  test.each([
    [{ url: '', email: 'https://', password: 'shop.example.test:alice:Secret1' }],
    [{ url: '', email: 'Network:', password: 'shop.example.test:alice:Secret1' }],
    [{ url: '', email: 'https://shop.example.test/login', password: 'alice:Secret1' }],
    [{ url: '', email: 'https://shop.example.test/login:', password: 'alice:Secret1' }],
    [{ url: '', email: 'https://shop.example.test/login', password: ':alice:Secret1' }],
  ])('the junk row the baseline stored: %j', r => expect(classifyOldOnlyRow(r)).toBe('pipe-join'))
})

describe('a semicolon behind a complete credential (parser v6.1, rule I)', () => {
  const line = 'https://shop.example.test:alice@mail.test:Sec;ret1'
  const junk = row('', 'https://shop.example.test:alice@mail.test:Sec', 'ret1')       // what the baseline stored: the credential as the login
  const joined = row('https://shop.example.test', 'alice@mail.test', 'Sec;ret1')
  test('a changed result equal to the baseline parser on the line with the semicolon made inert', () => {
    expect(classifyChange(line, junk, joined, none('x'), undefined, joined)).toBe('semicolon-password')
  })
  test('a rejected line now stored is the same class', () => {
    expect(classifyChange(line, none('no_fields'), joined, none('x'), undefined, joined)).toBe('semicolon-password')
  })
  test('a result that is NOT what the inert-semicolon parse gives stays unexplained', () => {
    expect(classifyChange(line, junk, joined, none('x'), undefined, row('https://shop.example.test', 'someone', 'else'))).toBe('unexplained')
  })
  test('a line whose part in front of the semicolon holds no credential is never attributed to it', () => {
    expect(classifyChange('https://shop.example.test;alice;Sec', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'), undefined, row('u', 'e', 'p2'))).toBe('unexplained')
  })
  test('the junk row the baseline stored: no url, the credential as the login', () => {
    expect(classifyOldOnlyRow({ url: '', email: 'https://shop.example.test:alice@mail.test:Sec', password: 'ret1' })).toBe('semicolon-junk')
    expect(classifyOldOnlyRow({ url: '', email: 'alice@mail.test:Sec', password: 'ret1' })).toBe('semicolon-junk')
  })
})

describe('a ";name=value" path parameter in a url without a scheme (parser v6.1)', () => {
  const line = 'shop.example.test/app;jsessionid=AB12:alice:Secret1'
  const junk = row('', 'shop.example.test/app', 'jsessionid=AB12:alice:Secret1')
  const fixed = row('shop.example.test/app;jsessionid=AB12', 'alice', 'Secret1')
  test('the new result equals the baseline parser on the line with the semicolon made inert', () => {
    expect(classifyChange(line, junk, fixed, none('x'), undefined, fixed)).toBe('semicolon-parameter')
  })
  test('the junk row the baseline stored: a path as the login and the parameter and credential as the password', () => {
    expect(classifyOldOnlyRow({ url: '', email: 'shop.example.test/app', password: 'jsessionid=AB12:alice:Secret1' })).toBe('semicolon-junk')
  })
})

describe('a line with leading slashes is read as the scheme-less line behind them (rule E), so the new rules are attributed on that form', () => {
  test('a path parameter behind //: the classifier sees the host/path;param:login:password line', () => {
    const line = '//shop.example.test/app;jsessionid=AB12:alice:Secret1'
    const junk = row('', 'shop.example.test/app', 'jsessionid=AB12:alice:Secret1')
    const fixed = row('shop.example.test/app;jsessionid=AB12', 'alice', 'Secret1')
    expect(classifyChange(line, junk, fixed, none('x'), undefined, fixed)).toBe('semicolon-parameter')
  })
  test('the helpers look through the slashes', () => {
    expect(inertSemicolons('//shop.example.test/login;x=y:alice:Secret1')?.kind).toBe('semicolon-parameter')
    expect(pipeJoinAll('//shop.example.test/login:|alice:Secret1')).toEqual({ kind: 'url', line: 'shop.example.test/login:alice:Secret1' })
  })
})

describe('a semicolon line that also holds a pipe (parseLine cuts at the pipe when a semicolon is in the line)', () => {
  test('the inert reading is the text in front of the pipe, without its trailing semicolons', () => {
    expect(inertSemicolons('https://shop.example.test:alice:Secret1;|noise;x')).toEqual({ kind: 'semicolon-password', line: 'https://shop.example.test:alice:Secret1' })
    expect(inertSemicolons('shop.example.test/app;jsessionid=AB12:alice:Secret1|note')).toEqual({ kind: 'semicolon-parameter', line: 'shop.example.test/app\uE000jsessionid=AB12:alice:Secret1' })
  })
  test('a pipe in front of the first semicolon leaves no semicolon to read', () => {
    expect(inertSemicolons('alice@mail.test:Secret1|x;y')).toBeNull()
  })
})

describe('a Telegram tag behind the credential is cut before the semicolon rules look at the line', () => {
  test('the inert reading is of the line without the tag', () => {
    const r = inertSemicolons('shop.example.test/app;jsessionid=AB12:alice:Secret1          @SomeChannel - fresh ulp | https://t.me/+AbC123')
    expect(r?.kind).toBe('semicolon-parameter')
    expect(r?.line).not.toContain('SomeChannel')
    expect(r?.line.startsWith('shop.example.test/app')).toBe(true)
  })
})

describe('a semicolon line with tabs in front of the pipe cut, and one that starts with a pipe', () => {
  test('the tabs go with the cut text (parseLine trims it)', () => {
    expect(inertSemicolons('https://shop.example.test/:alice@mail.test:Sec;ret1\t\t|||   advert')).toEqual({ kind: 'semicolon-password', line: 'https://shop.example.test/:alice@mail.test:Sec\uE000ret1' })
  })
  test('a leading pipe is not a cut: the line is read whole', () => {
    expect(inertSemicolons('| https://shop.example.test/:alice:Sec;ret1')?.kind).toBe('semicolon-password')
  })
})

describe('classifyOldOnlyRow: a url that holds a whole credential (the 3-part split of url:login:pass;x;y)', () => {
  test.each([
    [{ url: 'https://shop.example.test/login:alice:Sec', email: 'k', password: 'kf;ai' }],
    [{ url: 'https://shop.example.test/en/reg/:alice@mail.test:', email: '-[sh', password: '*P"hk8&' }],
  ])('%j is split-junk', r => expect(classifyOldOnlyRow(r)).toBe('split-junk'))
  test('a url with user info and a port is a real url, not that junk', () => {
    expect(classifyOldOnlyRow({ url: 'http://user:pass@shop.example.test:8080/x', email: 'alice', password: 'Secret1' })).toBe('unexplained')
  })
})

describe('classifyOldOnlyRow: more shapes of the old semicolon split', () => {
  test.each([
    [{ url: 'www.shop.example.test/app/sign-in', email: 'token=43ab', password: 'utm_source=x;utm_campaign=y:alice:Secret1' }],
    [{ url: 'https://HP:La:rcd@tu.example.test', email: 'Al', password: 'Rcd;so;ey' }],
  ])('%j is junk of the semicolon split', r => expect(['semicolon-junk', 'split-junk']).toContain(classifyOldOnlyRow(r)))
  test('a url with plain user info and a port is a real url', () => {
    expect(classifyOldOnlyRow({ url: 'http://user:pass@shop.example.test:8080/x', email: 'alice', password: 'Secret1' })).toBe('unexplained')
  })
})

describe('classifyOldOnlyRow: a host and a path as the login', () => {
  test('no url, the url as the login (a path parameter whose value holds white space)', () => {
    expect(classifyOldOnlyRow({ url: '', email: 'shop.example.test/en/login', password: 'q=[a b]:80:Secret1' })).toBe('semicolon-junk')
  })
})

describe('the four layouts of parser v6.2', () => {
  const lead = ':https://shop.example.test/login:alice:Secret1'
  const leadFixed = row('https://shop.example.test/login', 'alice', 'Secret1')

  test('a colon in front of the scheme (rule J): the new result is what the baseline gives for the line without it', () => {
    expect(classifyChange(lead, row(':https://shop.example.test/login', 'alice', 'Secret1'), leadFixed, none('x'), undefined, undefined, leadFixed)).toBe('leading-colon')
    expect(classifyChange(lead, none('no_fields'), leadFixed, none('x'), undefined, undefined, leadFixed)).toBe('leading-colon')
  })
  test('... and a result that is NOT what the baseline gives for that line stays unexplained', () => {
    expect(classifyChange(lead, row(':https://shop.example.test/login', 'alice', 'Secret1'), row('u', 'someone', 'else'), none('x'), undefined, undefined, leadFixed)).toBe('unexplained')
  })
  test('a line without a colon in front of its scheme is never attributed to rule J', () => {
    expect(classifyChange('a:b:c', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'))).toBe('unexplained')
  })

  test.each([
    ['semicolon-url-last', 'bob;Secret2:https://two.example.test/login', row('', 'bob', 'Secret2:https://two.example.test/login'), row('https://two.example.test/login', 'bob', 'Secret2')],
    ['semicolon-url-last', 'bob;Secret2;https://two.example.test/login', row('bob', 'Secret2', 'https://two.example.test/login'), row('https://two.example.test/login', 'bob', 'Secret2')],
    ['labelled-pair', 'three.example.test/|Username:carol:Password:Secret3', row('', 'three.example.test/', 'Username:carol:Password:Secret3'), row('three.example.test/', 'carol', 'Secret3')],
    ['labelled-pair', 'https://three.example.test/|Username:carol:Password:Secret3', row('https://three.example.test/', 'Username', 'carol:Password:Secret3'), row('https://three.example.test/', 'carol', 'Secret3')],
    ['nested-url', 'https://sso.example.test/x?next=https://four.example.test/y:dave:Secret4', row('https://sso.example.test/x?next=https', '//four.example.test/y', 'dave:Secret4'), row('https://sso.example.test/x?next=https://four.example.test/y', 'dave', 'Secret4')],
  ])('%s: the wrong split the baseline stored, now the clean row (%#)', (cls, line, junk, clean) => {
    expect(classifyChange(line, junk, clean, none('x'))).toBe(cls)
  })
  test('a line the baseline rejected and parser v6.2 stores is attributed the same way', () => {
    expect(classifyChange('three.example.test/|Username:carol:Password:Secret3', none('no_fields'), row('three.example.test/', 'carol', 'Secret3'), none('x'))).toBe('labelled-pair')
  })
  test('a url inside a url that is no longer stored (one token behind it) is rule M too', () => {
    const line = 'https://sso.example.test/x?next=https://four.example.test/y:Token1234567890'
    expect(classifyChange(line, row('https://sso.example.test/x?next=https', '//four.example.test/y', 'Token1234567890'), none('no_fields'), none('x'))).toBe('nested-url')
  })
  test('a changed line none of the four rules reads stays unexplained', () => {
    expect(classifyChange('plain:line:here', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'))).toBe('unexplained')
    expect(classifyChange('plain:line:here', none('no_fields'), row('u', 'e', 'p'), none('x'))).toBe('unexplained')
  })
  test('a rule the line does not match is not named: a semicolon line whose url is not last, a pipe without labels, one url', () => {
    expect(classifyChange('https://shop.example.test;alice;Secret1', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'))).toBe('unexplained')
    expect(classifyChange('shop.example.test/|alice|Secret1', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'))).toBe('unexplained')
    expect(classifyChange('https://shop.example.test/login:alice:Secret1', row('u', 'e', 'p1'), row('u', 'e', 'p2'), row('u', 'e', 'p1'))).toBe('unexplained')
  })
})

describe('classifyOldOnlyRow: the rows the baseline stored for the layouts of parser v6.2', () => {
  test.each([
    ['leading-colon', { url: ':https://shop.example.test/login', email: 'alice', password: 'Secret1' }],
    ['leading-colon', { url: '::https://shop.example.test:8443/login', email: 'alice@mail.test', password: 'Secret1' }],
    ['leading-colon', { url: '', email: ':https://shop.example.test/', password: 'Alpha:Beta:Gamma:Secret1' }],
    ['leading-colon', { url: '', email: ':https://smtp.example.test', password: '587:alice@mail.test:Secret1' }],
    ['semicolon-url-last', { url: '', email: 'bob', password: 'Secret2:https://two.example.test/login' }],
    ['semicolon-url-last', { url: '', email: 'bob@mail.test', password: 'Secret2:https://two.example.test:8443/login' }],
    ['semicolon-url-last', { url: '', email: 'bob', password: 'Sec/ret2:https://two.example.test/login' }],
    ['semicolon-url-last', { url: '', email: 'bob', password: 'Sec:ret2:https://two.example.test/login' }],
    ['semicolon-url-last', { url: 'bob', email: 'Secret2', password: 'Ab3:https://two.example.test/login' }],
    ['semicolon-url-last', { url: '', email: 'bob', password: 'Secret2:https://two.example.test/My Folder/index.php' }],
    ['semicolon-url-last', { url: 'bob', email: 'Secret2', password: 'Ab3;https://two.example.test:8443/' }],
    ['semicolon-url-last', { url: 'bob', email: 'Secret2', password: 'https://two.example.test/login' }],
    ['labelled-pair', { url: '', email: 'three.example.test/', password: 'Username:carol:Password:Secret3' }],
    ['labelled-pair', { url: 'https://three.example.test/', email: 'Username', password: 'carol:Password:Secret3' }],
    ['nested-url', { url: 'https://sso.example.test/x?next=https', email: '//four.example.test/y', password: 'dave:Secret4' }],
    ['nested-url', { url: 'https://sso.example.test/x?next=https', email: '//four.example.test', password: '8443/y:dave:Secret4' }],
  ])('%s: %j', (cls, r) => expect(classifyOldOnlyRow(r)).toBe(cls))

  test.each([
    [{ url: 'https://shop.example.test/login', email: 'alice', password: 'Secret1' }],
    [{ url: 'https://shop.example.test/login', email: 'alice', password: 'see https://x.test' }],
    [{ url: 'https://shop.example.test/login', email: 'alice@mail.test', password: 'Pass:word1' }],
    [{ url: '', email: 'Username', password: 'Secret1' }],
  ])('a row nothing in v6.2 explains stays unexplained: %j', r => expect(classifyOldOnlyRow(r)).toBe('unexplained'))
})
