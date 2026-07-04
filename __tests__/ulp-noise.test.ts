import { describe, test, expect } from 'vitest'
import { isNoiseUrl, noiseWhere, NOISE_FILTER, NOISE_EXPR } from '@/lib/ulp-noise'

describe('ulp-noise', () => {
  describe('isNoiseUrl — hides low-signal rows', () => {
    test.each([
      // [url, domain, why]
      ['http://159.65.203.122:8069/web/login', '159.65.203.122', 'IP host + port'],
      ['http://192.168.31.180:5000:Eason', '192.168.31.180:5000:eason', 'private IP-prefixed corruption'],
      ['https://ledgercyber.com/wp-login.php', 'ledgercyber.com', '.php login script'],
      ['https://ledgerlock.net/wp-login.php', 'ledgerlock.net', '.php login script'],
      ['https://ledgerlock.net:2083/', 'ledgerlock.net', 'explicit :port (cPanel)'],
      ['https://x.com/wp-login.php?redirect_to=foo', 'x.com', '.php with query string'],
      ['http://10.0.0.5/admin', '10.0.0.5', 'private LAN IP'],
      ['http://localhost/login', 'localhost', 'localhost'],
      ['https://printer.local/', 'printer.local', '.local mDNS host'],
      ['chrome://settings/passwords', 'chrome', 'browser-internal scheme'],
      ['chrome-extension://aabbccddee/popup.html', 'aabbccddee', 'browser extension URL'],
      ['file:///C:/Users/x/passwords.txt', '', 'local file URL'],
      ['ftp://ftp.example.com/', 'ftp.example.com', 'non-web ftp scheme'],
      ['mailto:someone@example.com', 'example.com', 'mailto link'],
      ['http://dev/login', 'dev', 'single-label host (no TLD)'],
      ['https', 'https', 'scheme-split corruption (url is just the scheme)'],
      ['https://example.com/register', '', 'domain extraction failed despite non-blank url'],
      ['https://discord.com/login:+233-263934775:y"*1@!GbA', '!gba', 'domain starts with punctuation (multi-field-joined corruption)'],
      ["!6hr3*gu&ci1.", "!6hr3*gu&ci1.", 'domain starts with punctuation'],
      ['android://HASH==@com.discord garamgodaam@gmail.com', 'com.discord garamgodaam@gmail.com', 'domain contains concatenated junk (space + @)'],
      ['https://go-tix.id satrioviankam@gmail.com:513manaman', 'go-tix.id satrioviankam@gmail.com', 'domain contains a space (url/email concatenation corruption)'],
    ])('noise: %s (%s)', (url, domain) => {
      expect(isNoiseUrl(url, domain)).toBe(true)
    })

    test('blank domain + blank url, but password carries an embedded ":" (real fields mis-split)', () => {
      expect(isNoiseUrl('', '', '!', '/g#gt"`4d+cs:users.nexusmods.com/auth/sign_up:lastslimedo')).toBe(true)
    })

    test('blank domain + blank url, but email carries an embedded ":" (real fields mis-split)', () => {
      expect(isNoiseUrl('', '', 'http://10.10.10.2:8091/Login:p.pourshayan:', '=SLI_<<x')).toBe(true)
    })
  })

  describe('isNoiseUrl — keeps real credentials (false-positive guards)', () => {
    test.each([
      // Real domains that merely START with a digit must NOT be treated as IPs
      ['https://www.5paisa.com/customer-dashboard/ledger', '5paisa.com', 'domain starts with digit'],
      ['https://8x8.com/login', '8x8.com', 'digit-led brand domain'],
      ['https://auth.coinledger.io/register', 'auth.coinledger.io', 'normal https'],
      ['https://www.ledgerwallet.com/affiliate/sign-up', 'ledgerwallet.com', 'normal https'],
      ['https://beta.ledger.com/', 'beta.ledger.com', 'normal https'],
      ['http://wiki.ledgersmb.org', 'wiki.ledgersmb.org', 'http but real host'],
      ['https://x.com/info.phpx', 'x.com', '.php must be the ending, not a prefix'],
      ['https://x.com/checkout?next=http://y:8080', 'x.com', 'port only inside query, not the host'],
      ['android://Mo94hjn8SQ==@zw.co.ledger.ecocash/', 'zw.co.ledger.ecocash', 'android app credential — kept (can be high value)'],
      ['', '', 'salvaged email:pass row with no URL'],
      ['https://münchen.de/login', 'münchen.de', 'IDN domain — leading Unicode letter is not punctuation'],
      ['https://5paisa.com/x', '5paisa.com', 'domain starting with a digit is not punctuation'],
    ])('keep: %s (%s)', (url, domain) => {
      expect(isNoiseUrl(url, domain)).toBe(false)
    })

    test('genuinely bare "username:password, no site" credential — neither field has a colon', () => {
      expect(isNoiseUrl('', '', 'abdallahamr', '20205050')).toBe(false)
    })

    test('email/password default to "" for callers that omit them (never over-flags)', () => {
      expect(isNoiseUrl('', '')).toBe(false)
    })
  })

  describe('noiseWhere', () => {
    test('returns an appendable `AND is_noise = 0` fragment when excluding', () => {
      const w = noiseWhere(true)
      expect(w).toBe(' AND is_noise = 0')
      expect(w).toContain(NOISE_FILTER)
    })

    test('returns empty string when not excluding (keep everything)', () => {
      expect(noiseWhere(false)).toBe('')
    })
  })

  describe('NOISE_EXPR — materialized-column SQL references every signal', () => {
    test('covers IP, port, .php, and localhost signals (over url_host/url)', () => {
      expect(NOISE_EXPR).toContain('isIPv4String(url_host)')
      expect(NOISE_EXPR).toContain('port(url) != 0')
      expect(NOISE_EXPR).toContain('.php')
      expect(NOISE_EXPR).toContain("'localhost'")
    })

    test('regex backslashes are doubled for ClickHouse string-literal parsing', () => {
      // SQL text must contain "\\." so ClickHouse delivers RE2 "\." (literal dot).
      expect(NOISE_EXPR).toContain('\\\\.[0-9]')
      expect(NOISE_EXPR).toContain('\\\\.php')
    })

    test('covers the v13 additions: non-web schemes + single-label hosts', () => {
      expect(NOISE_EXPR).toContain('chrome-extension')
      expect(NOISE_EXPR).toContain('mailto')
      expect(NOISE_EXPR).toContain("position(url_host, '.') = 0")
    })

    test('covers the v15 additions: blank/punctuation-prefixed/junk domains', () => {
      expect(NOISE_EXPR).toContain("domain = ''")
      expect(NOISE_EXPR).toContain('\\\\p{L}')
      expect(NOISE_EXPR).toContain('\\\\p{N}')
      expect(NOISE_EXPR).toContain("match(domain, '[ @]')")
      expect(NOISE_EXPR).toContain("position(email, ':') > 0")
      expect(NOISE_EXPR).toContain("position(password, ':') > 0")
    })
  })
})
