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
    ])('noise: %s (%s)', (url, domain) => {
      expect(isNoiseUrl(url, domain)).toBe(true)
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
      ['', '', 'salvaged email:pass row with no URL'],
    ])('keep: %s (%s)', (url, domain) => {
      expect(isNoiseUrl(url, domain)).toBe(false)
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
  })
})
