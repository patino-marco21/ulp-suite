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
 *   3. URL TLD fallback  (tld column, already materialized from url)
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

/** Email domain (lowercased): everything after the last '@' — handles multi-@ addresses */
const ED = `splitByChar('@', lower(email))[-1]`

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
 * References columns: email (String), tld (String MATERIALIZED topLevelDomain(url))
 *
 * Logic:
 *   1. Email suffix / ISP provider → T1 / T2 / T3
 *   2. URL TLD fallback (for generic providers like @gmail.com) → T1 / T2 / T3
 *   3. Default → '' (untiered)
 */
export function buildCountryTierExpression(): string {
  const t1e = buildEmailCondition(T1_EMAIL_SUFFIXES, T1_EMAIL_PROVIDERS)
  const t2e = buildEmailCondition(T2_EMAIL_SUFFIXES, T2_EMAIL_PROVIDERS)
  const t3e = buildEmailCondition(T3_EMAIL_SUFFIXES, T3_EMAIL_PROVIDERS)

  const t1u = `lower(tld) IN ${sqlList(T1_URL_TLDS)}`
  const t2u = `lower(tld) IN ${sqlList(T2_URL_TLDS)}`
  const t3u = `lower(tld) IN ${sqlList(T3_URL_TLDS)}`

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
  const parse = (s: string) => s.split(',').map(t => t.trim()).filter(t => VALID_TIERS.includes(t))
  return { include: parse(include), exclude: parse(exclude) }
}
