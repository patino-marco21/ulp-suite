/**
 * Country-tier classification for ULP credentials.
 *
 * Tier 1 = US / UK / CA / AU / NZ  (Five Eyes + high-value anglophone)
 * Tier 2 = Western Europe / JP / KR / SG / IL / AE
 * Tier 3 = RU / CN / BR / EE / LATAM / SE Asia / Africa / Middle East
 *
 * Detection strategy — dual signal, email-first:
 *   1. Email domain ccTLD suffix  (.co.uk, .ca, .com.au …)
 *   2. Known country ISP / carrier email providers
 *   3. URL TLD fallback  (the host's last label, derived from url the way urlTldOf does)
 *
 * buildCountryTierExpression() emits the ClickHouse MATERIALIZED column expression.
 * tierWhereClause() emits the WHERE fragment for search / export filtering.
 */

export type Tier = 'T1' | 'T2' | 'T3' | ''

export const TIER_LABELS: Record<string, string> = {
  T1: 'Tier 1  (US / UK / CA / AU / NZ)',
  T2: 'Tier 2  (W. Europe / JP / KR / SG)',
  T3: 'Tier 3  (RU / CN / BR / LATAM / SEA)',
  '': 'All tiers',
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — US / UK / Canada / Australia / New Zealand
// ─────────────────────────────────────────────────────────────────────────────

const T1_EMAIL_SUFFIXES = [
  // UK
  '.co.uk', '.me.uk', '.org.uk', '.net.uk',
  // Canada
  '.ca',
  // Australia
  '.com.au', '.net.au', '.org.au', '.edu.au',
  // New Zealand
  '.co.nz', '.net.nz', '.org.nz',
  // US (rarely used but exists)
  '.us',
]

const T1_EMAIL_PROVIDERS = [
  // ── US ISP / carrier ──────────────────────────────────────────────────────
  'comcast.net', 'xfinity.com', 'verizon.net', 'att.net', 'att.com',
  'cox.net', 'charter.net', 'earthlink.net', 'bellsouth.net',
  'sbcglobal.net', 'aol.com', 'juno.com', 'netzero.net', 'mindspring.com',
  'adelphia.net', 'optonline.net', 'roadrunner.com', 'twc.com', 'rr.com',
  'windstream.net', 'centurytel.net', 'suddenlink.net', 'mediacom.net',
  'netscape.net', 'wmconnect.com', 'frontiernet.net', 'zoominternet.net',
  // ── UK ISP ────────────────────────────────────────────────────────────────
  'btinternet.com', 'btopenworld.com', 'sky.com', 'talktalk.net',
  'virginmedia.com', 'ntlworld.com', 'plusnet.com', 'blueyonder.co.uk',
  'tiscali.co.uk', 'freeserve.co.uk', 'pipex.com', 'madasafish.com',
  'f2s.com', 'demon.co.uk', 'clara.net', 'globalnet.co.uk',
  // UK branded / regional
  'hotmail.co.uk', 'yahoo.co.uk', 'live.co.uk', 'msn.co.uk',
  // ── Canada ISP ────────────────────────────────────────────────────────────
  'rogers.com', 'bell.net', 'telus.net', 'shaw.ca', 'sympatico.ca',
  'videotron.ca', 'cogeco.ca', 'eastlink.ca', 'mts.net', 'sasktel.net',
  'telus.com', 'bellnet.ca', 'persona.ca', 'primus.ca', 'look.ca',
  // Canada branded
  'yahoo.ca', 'live.ca', 'hotmail.ca', 'outlook.ca',
  // ── Australia ISP ─────────────────────────────────────────────────────────
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au',
  'aapt.com.au', 'dodo.com.au', 'internode.on.net', 'westnet.com.au',
  'tpg.com.au', 'primus.com.au', 'eftel.com', 'iprimus.com.au',
  'ozemail.com.au', 'chariot.net.au', 'activ8.net.au', 'pacific.net.au',
  // Australia branded
  'yahoo.com.au', 'hotmail.com.au', 'live.com.au',
  // ── New Zealand ISP ───────────────────────────────────────────────────────
  'xtra.co.nz', 'clear.net.nz', 'paradise.net.nz', 'orcon.net.nz',
  'slingshot.co.nz', 'snap.net.nz', 'vodafone.co.nz', 'ihug.co.nz',
  'callplus.net.nz', 'woosh.co.nz', 'maxnet.co.nz',
  // NZ branded
  'yahoo.co.nz',
]

const T1_URL_TLDS = ['uk', 'ca', 'au', 'nz', 'us']

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — Western Europe / Japan / South Korea / Singapore / Israel / UAE
// ─────────────────────────────────────────────────────────────────────────────

const T2_EMAIL_SUFFIXES = [
  '.de', '.fr', '.it', '.es', '.nl', '.se', '.no', '.dk', '.fi',
  '.ch', '.at', '.be', '.ie', '.pt', '.jp', '.kr', '.sg', '.il',
  '.ae', '.lu', '.gr', '.is', '.mt',
]

const T2_EMAIL_PROVIDERS = [
  // ── Germany ───────────────────────────────────────────────────────────────
  'web.de', 'gmx.de', 'gmx.net', 'gmx.com', 't-online.de', 'freenet.de',
  'posteo.de', 'arcor.de', 'vodafone.de', '1und1.de', 'online.de',
  // ── France ────────────────────────────────────────────────────────────────
  'orange.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'bbox.fr',
  'numericable.fr', 'neuf.fr', 'club-internet.fr', 'alice.fr', 'wanadoo.fr',
  'hotmail.fr', 'yahoo.fr', 'outlook.fr', 'live.fr',
  // ── Italy ─────────────────────────────────────────────────────────────────
  'libero.it', 'tiscali.it', 'alice.it', 'tim.it', 'virgilio.it',
  'inwind.it', 'tin.it', 'fastwebnet.it', 'wind.it', 'aruba.it',
  'hotmail.it', 'yahoo.it', 'live.it', 'outlook.it',
  // ── Spain ─────────────────────────────────────────────────────────────────
  'terra.es', 'ya.com', 'jazztel.es', 'ono.com', 'telefonica.net',
  'hotmail.es', 'yahoo.es', 'outlook.es', 'live.es',
  // ── Netherlands ───────────────────────────────────────────────────────────
  'ziggo.nl', 'kpnmail.nl', 'hetnet.nl', 'home.nl', 'xs4all.nl', 'chello.nl',
  // ── Belgium ───────────────────────────────────────────────────────────────
  'telenet.be', 'skynet.be', 'proximus.be', 'brutele.be', 'voo.be',
  // ── Switzerland ───────────────────────────────────────────────────────────
  'bluewin.ch', 'hispeed.ch', 'sunrise.ch', 'gmx.ch',
  // ── Austria ───────────────────────────────────────────────────────────────
  'aon.at', 'chello.at', 'utanet.at', 'gmx.at',
  // ── Ireland ───────────────────────────────────────────────────────────────
  'eircom.net', 'eir.ie', 'iolfree.ie', 'iol.ie',
  // ── Sweden ────────────────────────────────────────────────────────────────
  'tele2.se', 'spray.se', 'comhem.se', 'telia.com', 'bredband.net',
  // ── Norway ────────────────────────────────────────────────────────────────
  'online.no', 'start.no', 'c2i.net', 'broadpark.no',
  // ── Denmark ───────────────────────────────────────────────────────────────
  'post.dk', 'mail.dk', 'jubii.dk', 'ofir.dk', 'stofanet.dk',
  // ── Finland ───────────────────────────────────────────────────────────────
  'welho.com', 'dnainternet.fi', 'kolumbus.fi', 'luukku.com',
  // ── Portugal ──────────────────────────────────────────────────────────────
  'mail.pt', 'sapo.pt', 'iol.pt', 'clix.pt',
  // ── Japan ─────────────────────────────────────────────────────────────────
  'docomo.ne.jp', 'softbank.ne.jp', 'ezweb.ne.jp', 'au.com',
  'yahoo.co.jp', 'nifty.com', 'excite.co.jp', 'ocn.ne.jp',
  // ── Korea ─────────────────────────────────────────────────────────────────
  'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
  // ── Singapore ─────────────────────────────────────────────────────────────
  'singnet.com.sg', 'pacific.net.sg', 'starhub.net.sg',
  // ── Israel ────────────────────────────────────────────────────────────────
  'walla.com', 'netvision.net.il', 'bezeqint.net', 'zahav.net.il',
  // ── UAE / Gulf ────────────────────────────────────────────────────────────
  'etisalat.ae', 'du.ae',
]

const T2_URL_TLDS = [
  'de', 'fr', 'it', 'es', 'nl', 'se', 'no', 'dk', 'fi',
  'ch', 'at', 'be', 'ie', 'pt', 'jp', 'kr', 'sg', 'il',
  'ae', 'lu', 'gr', 'is',
]

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 — Russia / China / Brazil / Eastern Europe / LATAM / SE Asia / etc.
// ─────────────────────────────────────────────────────────────────────────────

const T3_EMAIL_SUFFIXES = [
  // Eastern Europe / Former USSR
  '.ru', '.by', '.kz', '.ua', '.pl', '.cz', '.ro', '.bg',
  '.sk', '.rs', '.hr', '.si', '.lt', '.lv', '.ee', '.md',
  '.al', '.ba', '.mk', '.ge', '.am', '.az',
  // Asia
  '.cn', '.id', '.vn', '.th', '.ph', '.my', '.bd', '.pk',
  '.in', '.lk', '.np', '.mm', '.kh',
  // Latin America
  '.br', '.ar', '.mx', '.cl', '.co', '.pe', '.ve', '.ec',
  '.uy', '.bo', '.py', '.gt', '.cu', '.do', '.cr', '.pa', '.hn', '.ni',
  // Middle East / Africa
  '.tr', '.sa', '.eg', '.za', '.ng', '.ke', '.ma', '.dz',
  '.tn', '.ir', '.iq', '.sy', '.lb', '.jo', '.ps', '.ly',
]

const T3_EMAIL_PROVIDERS = [
  // ── Russia ────────────────────────────────────────────────────────────────
  'mail.ru', 'yandex.ru', 'yandex.com', 'rambler.ru', 'bk.ru',
  'list.ru', 'inbox.ru', 'ya.ru', 'lenta.ru', 'autorambler.ru',
  // ── China ─────────────────────────────────────────────────────────────────
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  'yeah.net', 'foxmail.com', 'sina.cn', '139.com', '21cn.com', 'china.com',
  // ── Brazil ────────────────────────────────────────────────────────────────
  'yahoo.com.br', 'uol.com.br', 'bol.com.br', 'ig.com.br',
  'terra.com.br', 'r7.com', 'globomail.com', 'oi.com.br',
  // ── India ─────────────────────────────────────────────────────────────────
  'rediffmail.com', 'sify.com', 'indiatimes.com', 'in.com',
  // ── Poland ────────────────────────────────────────────────────────────────
  'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'poczta.fm', 'gazeta.pl',
  // ── Czech Republic ────────────────────────────────────────────────────────
  'seznam.cz', 'centrum.cz', 'email.cz', 'atlas.cz',
  // ── Bulgaria ──────────────────────────────────────────────────────────────
  'abv.bg', 'mail.bg', 'dir.bg',
  // ── Romania ───────────────────────────────────────────────────────────────
  'yahoo.ro', 'mail.ro',
  // ── Ukraine ───────────────────────────────────────────────────────────────
  'ukr.net', 'meta.ua', 'i.ua',
  // ── Turkey ────────────────────────────────────────────────────────────────
  'mynet.com', 'ttnet.net.tr', 'turk.net',
  // ── Vietnam ───────────────────────────────────────────────────────────────
  'yahoo.com.vn',
  // ── Indonesia ─────────────────────────────────────────────────────────────
  'yahoo.co.id',
  // ── Argentina ─────────────────────────────────────────────────────────────
  'fibertel.com.ar', 'arnet.com.ar',
  // ── Mexico ────────────────────────────────────────────────────────────────
  'prodigy.net.mx',
]

const T3_URL_TLDS = [
  // Eastern Europe
  'ru', 'by', 'kz', 'ua', 'pl', 'cz', 'ro', 'bg', 'sk', 'rs',
  'hr', 'si', 'lt', 'lv', 'ee', 'md', 'am', 'ge', 'az', 'al', 'ba', 'mk',
  // Asia
  'cn', 'id', 'vn', 'th', 'ph', 'my', 'bd', 'pk', 'in', 'lk', 'np', 'mm',
  // LATAM
  'br', 'ar', 'mx', 'cl', 'pe', 've', 'ec', 'uy', 'bo', 'py',
  'gt', 'cu', 'do', 'cr', 'pa', 'hn', 'ni',
  // Middle East / Africa
  'tr', 'sa', 'eg', 'za', 'ng', 'ke', 'ma', 'dz', 'tn', 'ir',
]

// ─────────────────────────────────────────────────────────────────────────────
// SQL expression builder
// ─────────────────────────────────────────────────────────────────────────────

function sqlList(items: string[]): string {
  return `(${items.map(s => `'${s}'`).join(',')})`
}

/**
 * Email domain (lowercased): everything after the last '@' (so multi-@ addresses work), or '' when the login
 * has no '@'. This is the stored email_domain column, read rather than re-derived: the expression used to be
 * splitByChar('@', lower(email))[-1], which is the WHOLE login when there is no '@', so a login such as
 * "someone.co" was classified by a "domain" that was never a domain and 1,781,728 rows of ulp.credentials were
 * stored as Tier 3 that the importer (emailDomainOf below, which returns '') calls untiered, T1 or T2.
 */
const ED = 'email_domain'

/**
 * Top-level label of the URL's host (lowercased; '' for a host with no dot), derived exactly like urlTldOf below:
 * drop the scheme, cut the authority at the first / ? or #, drop the userinfo (everything up to the LAST '@'),
 * drop the port (from the first ':'), then take the last dotted label.
 *
 * Not ClickHouse's topLevelDomain(url) / the stored `tld` column: for a URL that carries credentials it returns ''
 * (https://user:pw@host.co.uk:8080/x) or reads the userinfo as the host (https://a.b.c.d:pw@host.com:9/ -> 'd'), and it
 * returns '' for android:// URLs whose userinfo is a base64 fingerprint ending in '='. Measured on a 1.39M-row sample of
 * the live table: 536 rows (0.0385%) were labelled differently from the importer for those shapes.
 */
const URL_AFTER_SCHEME = `if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url)`
const URL_HOST = `lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', ${URL_AFTER_SCHEME})[1])[-1])[1])`
const UT = `if(position(${URL_HOST}, '.') > 0, splitByChar('.', ${URL_HOST})[-1], '')`

function buildEmailCondition(suffixes: string[], providers: string[]): string {
  const parts: string[] = []
  for (const suf of suffixes) {
    parts.push(`endsWith(${ED},'${suf}')`)
  }
  if (providers.length) {
    parts.push(`${ED} IN ${sqlList(providers)}`)
  }
  return parts.join(' OR ')
}

/**
 * Returns the ClickHouse MATERIALIZED column expression for country_tier.
 * References columns: email_domain (String MATERIALIZED, blank without an '@') and url
 *
 * Logic:
 *   1. Email suffix / ISP provider → T1 / T2 / T3
 *   2. URL TLD fallback (for generic providers like @gmail.com) → T1 / T2 / T3 (see UT)
 *   3. Default → '' (untiered)
 */
export function buildCountryTierExpression(): string {
  const t1e = buildEmailCondition(T1_EMAIL_SUFFIXES, T1_EMAIL_PROVIDERS)
  const t2e = buildEmailCondition(T2_EMAIL_SUFFIXES, T2_EMAIL_PROVIDERS)
  const t3e = buildEmailCondition(T3_EMAIL_SUFFIXES, T3_EMAIL_PROVIDERS)

  const t1u = `${UT} IN ${sqlList(T1_URL_TLDS)}`
  const t2u = `${UT} IN ${sqlList(T2_URL_TLDS)}`
  const t3u = `${UT} IN ${sqlList(T3_URL_TLDS)}`

  // multiIf(cond1, val1, cond2, val2, ..., else)
  return [
    'multiIf(',
    `  ${t1e}, 'T1',`,
    `  ${t2e}, 'T2',`,
    `  ${t3e}, 'T3',`,
    `  ${t1u}, 'T1',`,
    `  ${t2u}, 'T2',`,
    `  ${t3u}, 'T3',`,
    `  ''`,
    ')',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript classifier — the in-process twin of buildCountryTierExpression().
// Reuses the SAME arrays above, so ingest-time tiering can never drift from the
// ClickHouse country_tier column. Used by lib/ingest-filter.ts to drop low-tier
// rows BEFORE insert (so they never cost storage / dedup / query compute).
// The arrays are turned into Sets once: the old linear scans cost ~400 string
// comparisons per call and were half of the parse time of a pile file.
// ─────────────────────────────────────────────────────────────────────────────

/** The country of each Tier 3 mail provider (the headings of T3_EMAIL_PROVIDERS), for INGEST_FILTER_HARD_KEEP_COUNTRIES. */
const T3_PROVIDER_COUNTRY: ReadonlyMap<string, string> = new Map([
  ['mail.ru', 'RU'], ['yandex.ru', 'RU'], ['yandex.com', 'RU'], ['rambler.ru', 'RU'], ['bk.ru', 'RU'], ['list.ru', 'RU'], ['inbox.ru', 'RU'], ['ya.ru', 'RU'], ['lenta.ru', 'RU'], ['autorambler.ru', 'RU'],
  ['qq.com', 'CN'], ['163.com', 'CN'], ['126.com', 'CN'], ['sina.com', 'CN'], ['sohu.com', 'CN'], ['yeah.net', 'CN'], ['foxmail.com', 'CN'], ['sina.cn', 'CN'], ['139.com', 'CN'], ['21cn.com', 'CN'], ['china.com', 'CN'],
  ['yahoo.com.br', 'BR'], ['uol.com.br', 'BR'], ['bol.com.br', 'BR'], ['ig.com.br', 'BR'], ['terra.com.br', 'BR'], ['r7.com', 'BR'], ['globomail.com', 'BR'], ['oi.com.br', 'BR'],
  ['rediffmail.com', 'IN'], ['sify.com', 'IN'], ['indiatimes.com', 'IN'], ['in.com', 'IN'],
  ['wp.pl', 'PL'], ['o2.pl', 'PL'], ['onet.pl', 'PL'], ['interia.pl', 'PL'], ['poczta.fm', 'PL'], ['gazeta.pl', 'PL'],
  ['seznam.cz', 'CZ'], ['centrum.cz', 'CZ'], ['email.cz', 'CZ'], ['atlas.cz', 'CZ'],
  ['abv.bg', 'BG'], ['mail.bg', 'BG'], ['dir.bg', 'BG'],
  ['yahoo.ro', 'RO'], ['mail.ro', 'RO'],
  ['ukr.net', 'UA'], ['meta.ua', 'UA'], ['i.ua', 'UA'],
  ['mynet.com', 'TR'], ['ttnet.net.tr', 'TR'], ['turk.net', 'TR'],
  ['yahoo.com.vn', 'VN'], ['yahoo.co.id', 'ID'],
  ['fibertel.com.ar', 'AR'], ['arnet.com.ar', 'AR'],
  ['prodigy.net.mx', 'MX'],
])

/** Read-only view of the lists, for the tests and for the hard-keep policy. */
export const TIER_LISTS = {
  T1: { emailSuffixes: T1_EMAIL_SUFFIXES, emailProviders: T1_EMAIL_PROVIDERS, urlTlds: T1_URL_TLDS },
  T2: { emailSuffixes: T2_EMAIL_SUFFIXES, emailProviders: T2_EMAIL_PROVIDERS, urlTlds: T2_URL_TLDS },
  T3: { emailSuffixes: T3_EMAIL_SUFFIXES, emailProviders: T3_EMAIL_PROVIDERS, urlTlds: T3_URL_TLDS, providerCountry: T3_PROVIDER_COUNTRY },
} as const

const T1_SUFFIX_SET = new Set(T1_EMAIL_SUFFIXES), T1_PROVIDER_SET = new Set(T1_EMAIL_PROVIDERS), T1_TLD_SET = new Set(T1_URL_TLDS)
const T2_SUFFIX_SET = new Set(T2_EMAIL_SUFFIXES), T2_PROVIDER_SET = new Set(T2_EMAIL_PROVIDERS), T2_TLD_SET = new Set(T2_URL_TLDS)
const T3_SUFFIX_SET = new Set(T3_EMAIL_SUFFIXES), T3_PROVIDER_SET = new Set(T3_EMAIL_PROVIDERS), T3_TLD_SET = new Set(T3_URL_TLDS)

/** Email domain (lowercased): everything after the last '@'. Mirrors the SQL ED. */
export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

/** Host of a URL: scheme/userinfo/port/path stripped, lowercased. Scans by index instead of splitting. */
function hostOf(url: string): string {
  let start = 0
  const scheme = url.indexOf('://')
  if (scheme !== -1) start = scheme + 3
  let end = url.length
  for (let i = start; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c === 47 || c === 63 || c === 35) { end = i; break }       // / ? #
  }
  const at = url.lastIndexOf('@', end - 1)
  if (at >= start) start = at + 1                                   // drop userinfo
  for (let i = start; i < end; i++) {
    if (url.charCodeAt(i) === 58) { end = i; break }                // drop the port
  }
  return url.slice(start, end).toLowerCase()
}

/** URL top-level domain (last dotted label of the host). Mirrors lower(topLevelDomain(url)). */
export function urlTldOf(url: string): string {
  const h = hostOf(url)
  const dot = h.lastIndexOf('.')
  return dot === -1 ? '' : h.slice(dot + 1)
}

/**
 * Every suffix of the lists starts with '.', so `ed.endsWith(suffix)` holds exactly when the suffix equals one of the dot-suffixes of `ed`
 * (".example.co.uk", ".co.uk", ".uk"): a handful of Set lookups instead of a scan of the whole list.
 */
function matchesEmail(ed: string, suffixes: ReadonlySet<string>, providers: ReadonlySet<string>): boolean {
  if (providers.has(ed)) return true
  for (let i = ed.indexOf('.'); i !== -1; i = ed.indexOf('.', i + 1)) {
    if (suffixes.has(ed.slice(i))) return true
  }
  return false
}

/**
 * Classify a credential's country tier from its email + URL — identical logic and
 * precedence to buildCountryTierExpression() (email signal first: T1→T2→T3, then
 * URL-TLD fallback: T1→T2→T3, else untiered '').
 */
export function classifyTier(email: string, url: string): Tier {
  const ed = emailDomainOf(email)
  if (matchesEmail(ed, T1_SUFFIX_SET, T1_PROVIDER_SET)) return 'T1'
  if (matchesEmail(ed, T2_SUFFIX_SET, T2_PROVIDER_SET)) return 'T2'
  if (matchesEmail(ed, T3_SUFFIX_SET, T3_PROVIDER_SET)) return 'T3'
  const tld = urlTldOf(url)
  if (T1_TLD_SET.has(tld)) return 'T1'
  if (T2_TLD_SET.has(tld)) return 'T2'
  if (T3_TLD_SET.has(tld)) return 'T3'
  return ''
}

/**
 * The country (upper-case two-letter code) of the FIRST Tier 3 signal classifyTier uses: the e-mail provider or e-mail suffix, else the url TLD.
 * '' when classifyTier does not say T3. Used by the hard-keep policy (lib/ingest-filter.ts).
 */
export function t3CountryOf(email: string, url: string): string {
  const ed = emailDomainOf(email)
  if (matchesEmail(ed, T1_SUFFIX_SET, T1_PROVIDER_SET) || matchesEmail(ed, T2_SUFFIX_SET, T2_PROVIDER_SET)) return ''
  const provider = T3_PROVIDER_COUNTRY.get(ed)
  if (provider) return provider
  for (let i = ed.indexOf('.'); i !== -1; i = ed.indexOf('.', i + 1)) {
    const suffix = ed.slice(i)
    if (T3_SUFFIX_SET.has(suffix)) return suffix.slice(1).toUpperCase()
  }
  const tld = urlTldOf(url)
  if (T1_TLD_SET.has(tld) || T2_TLD_SET.has(tld)) return ''
  return T3_TLD_SET.has(tld) ? tld.toUpperCase() : ''
}

/** All valid tier values (including empty = untiered) */
export const VALID_TIERS: ReadonlyArray<string> = ['T1', 'T2', 'T3', '']

/**
 * Legacy single-tier WHERE clause (kept for backward compat).
 * Prefer tierWhereMulti() for new code.
 */
export function tierWhereClause(tier: string): string {
  if (!tier || !VALID_TIERS.includes(tier)) return ''
  return ` AND country_tier = '${tier}'`
}

/**
 * Multi-tier WHERE clause supporting include OR exclude mode.
 *
 * Include mode  — tier_include=['T1','T2'] → country_tier IN ('T1','T2')
 * Exclude mode  — tier_exclude=['T3']      → country_tier NOT IN ('T3')
 *
 * Values are validated against VALID_TIERS; unknown values are silently dropped.
 * If both arrays are non-empty, include takes precedence.
 */
export function tierWhereMulti(include: string[], exclude: string[]): string {
  const safeInclude = include.filter(t => VALID_TIERS.includes(t))
  const safeExclude = exclude.filter(t => VALID_TIERS.includes(t))

  if (safeInclude.length > 0) {
    return ` AND country_tier IN (${safeInclude.map(t => `'${t}'`).join(',')})`
  }
  if (safeExclude.length > 0) {
    return ` AND country_tier NOT IN (${safeExclude.map(t => `'${t}'`).join(',')})`
  }
  return ''
}

/**
 * Parse comma-separated tier param strings into arrays.
 * e.g. parseTierParams('T1,T2', '') → { include: ['T1','T2'], exclude: [] }
 */
export function parseTierParams(include: string, exclude: string) {
  // Guard: empty string input → empty array.
  // Without this, ''.split(',') returns [''] and the empty-string tier (untiered)
  // inadvertently ends up in the include list, causing tierWhereMulti to emit
  // `AND country_tier IN ('')` when the user only supplied a tier_exclude param.
  const parse = (s: string) =>
    s ? s.split(',').map(t => t.trim()).filter(t => VALID_TIERS.includes(t) && t !== '') : []
  return { include: parse(include), exclude: parse(exclude) }
}
