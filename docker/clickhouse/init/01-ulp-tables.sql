-- ULP Suite — ClickHouse Schema
-- Optimised for 100 B+ row credential tables.
-- Requires ClickHouse 26.2+ (text() inverted index GA).
--
-- Key scale decisions vs the baseline schema:
--   CODEC(ZSTD(3))  → 3-5× compression on string columns; halves I/O at query time
--   CODEC(Delta, ZSTD(1)) → ordered integers/timestamps compress extremely well
--   index_granularity = 65536  → 8× default; primary index is 8× smaller
--   index_granularity_bytes = 67108864 (64 MB) → size-based fallback
--   bloom_filter(0.05) → 5× smaller bloom files vs 0.01, ~3% more false positives
--   ORDER BY (domain, email, imported_at) → primary key covers both domain AND email point lookups
--   PARTITION BY toYYYYMM(imported_at) → monthly partitions enable DROP PARTITION cleanup
--   parts_to_delay_insert = 500 / throw = 1000 → prevent write stalls during bulk ingestion
--
-- Existing deployments: all new columns applied via lib/clickhouse-migrations.ts on startup.
--
-- Replication: tables are ReplicatedMergeTree so inserts participate in ClickHouse's
-- dedup log and a 2nd replica can be added later with no migration. Requires the embedded
-- Keeper + {shard}/{replica} macros from docker/clickhouse/config/ulp-keeper.xml (mounted
-- on every deploy). Paths use {shard}, NOT {uuid} — the {uuid} macro is only resolvable by
-- convert_to_replicated / Atomic internals, not a plain CREATE TABLE (Code 36).

CREATE DATABASE IF NOT EXISTS ulp;

CREATE TABLE IF NOT EXISTS ulp.credentials
(
    -- ── Core fields — ZSTD(3) chosen for best balance of ratio vs. decompression speed ──
    url          String    CODEC(ZSTD(3)),
    email        String    CODEC(ZSTD(3)),
    password     String    CODEC(ZSTD(3)),
    domain       String    CODEC(ZSTD(3)),
    source_file  String    CODEC(ZSTD(3)),
    breach_name  String    DEFAULT '' CODEC(ZSTD(1)),
    imported_at  DateTime  DEFAULT now() CODEC(Delta, ZSTD(1)),

    -- ── MATERIALIZED columns — computed once at insert, stored compressed ─────────────
    -- All derived from the core fields above; never written by the application.

    tld String MATERIALIZED topLevelDomain(url) CODEC(ZSTD(1)),

    -- country_tier is GENERATED from lib/country-tiers.ts (buildCountryTierExpression): do not edit it by hand.
    -- __tests__/country-tier-expression.test.ts fails when this block drifts from the generator, and DDL v26
    -- (lib/clickhouse-migrations.ts) swaps a running table to the same expression. It reads email_domain, which
    -- is blank for a login with no "@" (the old form re-derived the domain and got the whole login).
    country_tier LowCardinality(String) MATERIALIZED multiIf(
      endsWith(email_domain,'.co.uk')
            OR endsWith(email_domain,'.me.uk')
            OR endsWith(email_domain,'.org.uk')
            OR endsWith(email_domain,'.net.uk')
            OR endsWith(email_domain,'.ca')
            OR endsWith(email_domain,'.com.au')
            OR endsWith(email_domain,'.net.au')
            OR endsWith(email_domain,'.org.au')
            OR endsWith(email_domain,'.edu.au')
            OR endsWith(email_domain,'.co.nz')
            OR endsWith(email_domain,'.net.nz')
            OR endsWith(email_domain,'.org.nz')
            OR endsWith(email_domain,'.us')
            OR email_domain IN (
                'comcast.net','xfinity.com','verizon.net','att.net','att.com','cox.net','charter.net','earthlink.net',
                'bellsouth.net','sbcglobal.net','aol.com','juno.com','netzero.net','mindspring.com','adelphia.net','optonline.net',
                'roadrunner.com','twc.com','rr.com','windstream.net','centurytel.net','suddenlink.net','mediacom.net','netscape.net',
                'wmconnect.com','frontiernet.net','zoominternet.net','btinternet.com','btopenworld.com','sky.com','talktalk.net','virginmedia.com',
                'ntlworld.com','plusnet.com','blueyonder.co.uk','tiscali.co.uk','freeserve.co.uk','pipex.com','madasafish.com','f2s.com',
                'demon.co.uk','clara.net','globalnet.co.uk','hotmail.co.uk','yahoo.co.uk','live.co.uk','msn.co.uk','rogers.com',
                'bell.net','telus.net','shaw.ca','sympatico.ca','videotron.ca','cogeco.ca','eastlink.ca','mts.net',
                'sasktel.net','telus.com','bellnet.ca','persona.ca','primus.ca','look.ca','yahoo.ca','live.ca',
                'hotmail.ca','outlook.ca','bigpond.com','bigpond.net.au','optusnet.com.au','iinet.net.au','aapt.com.au','dodo.com.au',
                'internode.on.net','westnet.com.au','tpg.com.au','primus.com.au','eftel.com','iprimus.com.au','ozemail.com.au','chariot.net.au',
                'activ8.net.au','pacific.net.au','yahoo.com.au','hotmail.com.au','live.com.au','xtra.co.nz','clear.net.nz','paradise.net.nz',
                'orcon.net.nz','slingshot.co.nz','snap.net.nz','vodafone.co.nz','ihug.co.nz','callplus.net.nz','woosh.co.nz','maxnet.co.nz',
                'yahoo.co.nz'
            ), 'T1',
      endsWith(email_domain,'.de')
            OR endsWith(email_domain,'.fr')
            OR endsWith(email_domain,'.it')
            OR endsWith(email_domain,'.es')
            OR endsWith(email_domain,'.nl')
            OR endsWith(email_domain,'.se')
            OR endsWith(email_domain,'.no')
            OR endsWith(email_domain,'.dk')
            OR endsWith(email_domain,'.fi')
            OR endsWith(email_domain,'.ch')
            OR endsWith(email_domain,'.at')
            OR endsWith(email_domain,'.be')
            OR endsWith(email_domain,'.ie')
            OR endsWith(email_domain,'.pt')
            OR endsWith(email_domain,'.jp')
            OR endsWith(email_domain,'.kr')
            OR endsWith(email_domain,'.sg')
            OR endsWith(email_domain,'.il')
            OR endsWith(email_domain,'.ae')
            OR endsWith(email_domain,'.lu')
            OR endsWith(email_domain,'.gr')
            OR endsWith(email_domain,'.is')
            OR endsWith(email_domain,'.mt')
            OR email_domain IN (
                'web.de','gmx.de','gmx.net','gmx.com','t-online.de','freenet.de','posteo.de','arcor.de',
                'vodafone.de','1und1.de','online.de','orange.fr','free.fr','sfr.fr','laposte.net','bbox.fr',
                'numericable.fr','neuf.fr','club-internet.fr','alice.fr','wanadoo.fr','hotmail.fr','yahoo.fr','outlook.fr',
                'live.fr','libero.it','tiscali.it','alice.it','tim.it','virgilio.it','inwind.it','tin.it',
                'fastwebnet.it','wind.it','aruba.it','hotmail.it','yahoo.it','live.it','outlook.it','terra.es',
                'ya.com','jazztel.es','ono.com','telefonica.net','hotmail.es','yahoo.es','outlook.es','live.es',
                'ziggo.nl','kpnmail.nl','hetnet.nl','home.nl','xs4all.nl','chello.nl','telenet.be','skynet.be',
                'proximus.be','brutele.be','voo.be','bluewin.ch','hispeed.ch','sunrise.ch','gmx.ch','aon.at',
                'chello.at','utanet.at','gmx.at','eircom.net','eir.ie','iolfree.ie','iol.ie','tele2.se',
                'spray.se','comhem.se','telia.com','bredband.net','online.no','start.no','c2i.net','broadpark.no',
                'post.dk','mail.dk','jubii.dk','ofir.dk','stofanet.dk','welho.com','dnainternet.fi','kolumbus.fi',
                'luukku.com','mail.pt','sapo.pt','iol.pt','clix.pt','docomo.ne.jp','softbank.ne.jp','ezweb.ne.jp',
                'au.com','yahoo.co.jp','nifty.com','excite.co.jp','ocn.ne.jp','naver.com','daum.net','hanmail.net',
                'kakao.com','nate.com','singnet.com.sg','pacific.net.sg','starhub.net.sg','walla.com','netvision.net.il','bezeqint.net',
                'zahav.net.il','etisalat.ae','du.ae'
            ), 'T2',
      endsWith(email_domain,'.ru')
            OR endsWith(email_domain,'.by')
            OR endsWith(email_domain,'.kz')
            OR endsWith(email_domain,'.ua')
            OR endsWith(email_domain,'.pl')
            OR endsWith(email_domain,'.cz')
            OR endsWith(email_domain,'.ro')
            OR endsWith(email_domain,'.bg')
            OR endsWith(email_domain,'.sk')
            OR endsWith(email_domain,'.rs')
            OR endsWith(email_domain,'.hr')
            OR endsWith(email_domain,'.si')
            OR endsWith(email_domain,'.lt')
            OR endsWith(email_domain,'.lv')
            OR endsWith(email_domain,'.ee')
            OR endsWith(email_domain,'.md')
            OR endsWith(email_domain,'.al')
            OR endsWith(email_domain,'.ba')
            OR endsWith(email_domain,'.mk')
            OR endsWith(email_domain,'.ge')
            OR endsWith(email_domain,'.am')
            OR endsWith(email_domain,'.az')
            OR endsWith(email_domain,'.cn')
            OR endsWith(email_domain,'.id')
            OR endsWith(email_domain,'.vn')
            OR endsWith(email_domain,'.th')
            OR endsWith(email_domain,'.ph')
            OR endsWith(email_domain,'.my')
            OR endsWith(email_domain,'.bd')
            OR endsWith(email_domain,'.pk')
            OR endsWith(email_domain,'.in')
            OR endsWith(email_domain,'.lk')
            OR endsWith(email_domain,'.np')
            OR endsWith(email_domain,'.mm')
            OR endsWith(email_domain,'.kh')
            OR endsWith(email_domain,'.br')
            OR endsWith(email_domain,'.ar')
            OR endsWith(email_domain,'.mx')
            OR endsWith(email_domain,'.cl')
            OR endsWith(email_domain,'.co')
            OR endsWith(email_domain,'.pe')
            OR endsWith(email_domain,'.ve')
            OR endsWith(email_domain,'.ec')
            OR endsWith(email_domain,'.uy')
            OR endsWith(email_domain,'.bo')
            OR endsWith(email_domain,'.py')
            OR endsWith(email_domain,'.gt')
            OR endsWith(email_domain,'.cu')
            OR endsWith(email_domain,'.do')
            OR endsWith(email_domain,'.cr')
            OR endsWith(email_domain,'.pa')
            OR endsWith(email_domain,'.hn')
            OR endsWith(email_domain,'.ni')
            OR endsWith(email_domain,'.tr')
            OR endsWith(email_domain,'.sa')
            OR endsWith(email_domain,'.eg')
            OR endsWith(email_domain,'.za')
            OR endsWith(email_domain,'.ng')
            OR endsWith(email_domain,'.ke')
            OR endsWith(email_domain,'.ma')
            OR endsWith(email_domain,'.dz')
            OR endsWith(email_domain,'.tn')
            OR endsWith(email_domain,'.ir')
            OR endsWith(email_domain,'.iq')
            OR endsWith(email_domain,'.sy')
            OR endsWith(email_domain,'.lb')
            OR endsWith(email_domain,'.jo')
            OR endsWith(email_domain,'.ps')
            OR endsWith(email_domain,'.ly')
            OR email_domain IN (
                'mail.ru','yandex.ru','yandex.com','rambler.ru','bk.ru','list.ru','inbox.ru','ya.ru',
                'lenta.ru','autorambler.ru','qq.com','163.com','126.com','sina.com','sohu.com','yeah.net',
                'foxmail.com','sina.cn','139.com','21cn.com','china.com','yahoo.com.br','uol.com.br','bol.com.br',
                'ig.com.br','terra.com.br','r7.com','globomail.com','oi.com.br','rediffmail.com','sify.com','indiatimes.com',
                'in.com','wp.pl','o2.pl','onet.pl','interia.pl','poczta.fm','gazeta.pl','seznam.cz',
                'centrum.cz','email.cz','atlas.cz','abv.bg','mail.bg','dir.bg','yahoo.ro','mail.ro',
                'ukr.net','meta.ua','i.ua','mynet.com','ttnet.net.tr','turk.net','yahoo.com.vn','yahoo.co.id',
                'fibertel.com.ar','arnet.com.ar','prodigy.net.mx'
            ), 'T3',
      if(position(lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url))[1])[-1])[1]), '.') > 0, splitByChar('.', lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url))[1])[-1])[1]))[-1], '') IN (
                'uk','ca','au','nz','us'
            ), 'T1',
      if(position(lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url))[1])[-1])[1]), '.') > 0, splitByChar('.', lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url))[1])[-1])[1]))[-1], '') IN (
                'de','fr','it','es','nl','se','no','dk',
                'fi','ch','at','be','ie','pt','jp','kr',
                'sg','il','ae','lu','gr','is'
            ), 'T2',
      if(position(lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url))[1])[-1])[1]), '.') > 0, splitByChar('.', lower(splitByChar(':', splitByChar('@', splitByRegexp('[/?#]', if(position(url, '://') > 0, substring(url, position(url, '://') + 3), url))[1])[-1])[1]))[-1], '') IN (
                'ru','by','kz','ua','pl','cz','ro','bg',
                'sk','rs','hr','si','lt','lv','ee','md',
                'am','ge','az','al','ba','mk','cn','id',
                'vn','th','ph','my','bd','pk','in','lk',
                'np','mm','br','ar','mx','cl','pe','ve',
                'ec','uy','bo','py','gt','cu','do','cr',
                'pa','hn','ni','tr','sa','eg','za','ng',
                'ke','ma','dz','tn','ir'
            ), 'T3',
      ''
    ),

    login_type LowCardinality(String) MATERIALIZED multiIf(
        position(email, '@') > 1
        AND position(email, '.', position(email, '@') + 1) > 0
        AND position(email, ' ') = 0,
        'email',
        match(email, '(?-s)^[+]?[0-9][0-9(). -]{5,16}[0-9]$'),
        'phone',
        length(trimBoth(email)) > 0,
        'username',
        ''
    ),

    password_length    UInt8 MATERIALIZED length(password),

    password_mask LowCardinality(String) MATERIALIZED multiIf(
        length(password) = 0,              'empty',
        match(password, '^[0-9]+$'),       'numeric',
        match(password, '^[a-zA-Z]+$'),    'alpha',
        match(password, '^[a-zA-Z0-9]+$'), 'alphanumeric',
        'mixed'
    ),

    email_domain String MATERIALIZED lower(if(position(email,'@')>0, splitByChar('@',email)[-1], ''))
        CODEC(ZSTD(3)),

    url_scheme LowCardinality(String) MATERIALIZED multiIf(
        startsWith(lower(url),'https://'), 'https',
        startsWith(lower(url),'http://'),  'http',
        ''
    ),

    url_host String MATERIALIZED lower(if(url='', domain, replaceRegexpOne(url,'^https?://([^/?#:]+).*$','\\1')))
        CODEC(ZSTD(3)),

    password_entropy_band LowCardinality(String) MATERIALIZED multiIf(
        length(password) = 0,                                          'very_weak',
        length(password) <= 4,                                         'very_weak',
        length(password) <= 8,                                         'weak',
        length(password) <= 12 AND match(password,'^[a-zA-Z0-9]+$'),  'moderate',
        length(password) <= 12 AND match(password,'[^a-zA-Z0-9]'),    'strong',
        length(password) <= 20 AND match(password,'^[a-zA-Z0-9]+$'),  'moderate',
        length(password) <= 20 AND match(password,'[^a-zA-Z0-9]'),    'strong',
        length(password) >  20,                                        'long',
        'moderate'
    ),

    is_corporate_email UInt8 MATERIALIZED toUInt8(
        position(email,'@') > 1
        AND position(email,' ') = 0
        AND length(splitByChar('@',lower(email))[-1]) > 3
        AND splitByChar('@',lower(email))[-1] NOT IN (
            'gmail.com','googlemail.com',
            'yahoo.com','yahoo.co.uk','yahoo.fr','yahoo.de','yahoo.it','yahoo.es',
            'yahoo.com.br','yahoo.com.au','yahoo.co.jp','yahoo.co.in','yahoo.com.ar',
            'yahoo.com.mx','yahoo.com.ph','yahoo.com.vn','yahoo.co.id',
            'hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.de','hotmail.it',
            'hotmail.es','hotmail.com.br','hotmail.com.ar','hotmail.com.au',
            'outlook.com','outlook.fr','outlook.de','outlook.es','outlook.it','outlook.com.au',
            'live.com','live.co.uk','live.fr','live.de','live.it','live.es','live.ca','live.com.au',
            'msn.com','passport.com',
            'icloud.com','me.com','mac.com',
            'aol.com','aim.com',
            'protonmail.com','protonmail.ch','pm.me','tutanota.com','tuta.io',
            'mail.com','email.com','zoho.com','guerrillamail.com','mailinator.com',
            'tempmail.com','throwam.com',
            'yandex.com','yandex.ru','yandex.ua','yandex.kz','yandex.by',
            'mail.ru','bk.ru','list.ru','inbox.ru','ya.ru','rambler.ru',
            'qq.com','163.com','126.com','sina.com','sohu.com','foxmail.com','21cn.com','yeah.net',
            'web.de','gmx.de','gmx.net','gmx.com','gmx.at','gmx.ch','freenet.de','t-online.de',
            'libero.it','virgilio.it','tiscali.it','alice.it','tin.it',
            'orange.fr','free.fr','sfr.fr','laposte.net','wanadoo.fr',
            'naver.com','daum.net','hanmail.net','kakao.com','nate.com',
            'docomo.ne.jp','softbank.ne.jp','nifty.com',
            'uol.com.br','bol.com.br','ig.com.br','terra.com.br','r7.com',
            'wp.pl','o2.pl','onet.pl','interia.pl','poczta.fm',
            'seznam.cz','centrum.cz',
            'abv.bg','mail.bg',
            'ukr.net','meta.ua','i.ua',
            'rediffmail.com','indiatimes.com',
            'comcast.net','xfinity.com','verizon.net','att.net','att.com',
            'cox.net','charter.net','earthlink.net','bellsouth.net','sbcglobal.net',
            'roadrunner.com','rr.com','twc.com','optonline.net','windstream.net',
            'btinternet.com','btopenworld.com','sky.com','talktalk.net','virginmedia.com',
            'ntlworld.com','plusnet.com','blueyonder.co.uk',
            'rogers.com','bell.net','telus.net','shaw.ca','cogeco.ca','videotron.ca',
            'bigpond.com','bigpond.net.au','optusnet.com.au','iinet.net.au','tpg.com.au',
            'xtra.co.nz','clear.net.nz','paradise.net.nz'
        )
    ),

    -- is_noise: precomputed flag for the browser's default-on "Declutter" filter
    -- (mirrors lib/ulp-noise.ts NOISE_EXPR). Computed ONCE here instead of as a
    -- per-row WHERE predicate, so /credentials filters on a cheap `is_noise = 0`
    -- PREWHERE compare rather than running match()/port()/isIPv4String() over the
    -- wide url column for every scanned row. References url_host (materialized
    -- above), the same way country_tier references tld. Also flags blank/
    -- punctuation-prefixed/space-or-@-containing domains — parser-corruption
    -- artifacts that sort essentially at random ahead of real domains in an
    -- alphabetical domain browse (real hostnames never start with punctuation or
    -- contain whitespace/'@'; android:// domains are the app package name, since
    -- extractDomain strips the cert-fingerprint prefix).
    is_noise UInt8 MATERIALIZED toUInt8(
        isIPv4String(url_host)
        OR isIPv6String(url_host)
        OR match(url_host, '^[0-9]{1,3}(\\.[0-9]{1,3}){3}')
        OR url_host = 'localhost'
        OR endsWith(url_host, '.local')
        OR (url != '' AND url_host != '' AND position(url_host, '.') = 0)
        OR port(url) != 0
        OR match(lower(url), '\\.php($|[?#])')
        OR match(lower(url), '^(chrome|chrome-extension|moz-extension|edge|opera|brave|vivaldi|about|file|ftp|view-source|data|javascript|mailto):')
        OR (domain = '' AND url != '')
        OR match(domain, '^[^\\p{L}\\p{N}]')
        OR match(domain, '[ @]')
    ),

    -- content_key_hash: precomputed dedupe/count identity for the browser's
    -- default-on "Unique" filter (see lib/ulp-dedupe.ts DEDUPE_BY). Computed
    -- ONCE here instead of live per query -- the "Unique" count previously ran
    -- an unbounded uniq() over a live double-regex URL expression across the
    -- whole table (58-63s at 1.48B rows). Mirrors is_noise's MATERIALIZED
    -- pattern above. See DDL v18 in lib/clickhouse-migrations.ts and
    -- docs/superpowers/specs/2026-08-15-credentials-dedupe-materialized-key-design.md.
    content_key_hash UInt64 MATERIALIZED cityHash64(
        replaceRegexpOne(replaceRegexpOne(url, '^(?i:https?://)', ''), '/$', ''),
        email, password
    ),

    -- ── Skip indexes ──────────────────────────────────────────────────────────
    -- text() inverted indexes on url/email/password are added by DDL v6 in
    -- lib/clickhouse-migrations.ts (requires ClickHouse 26.2+; not defined here
    -- because the init SQL may run before migrations bump ch_ddl_version).

    -- bloom_filter: exact-match point lookups (FPR 0.05 = 5× smaller than 0.01)
    INDEX idx_bf_email        email        TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_bf_domain       domain       TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_bf_password     password     TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_bf_url_host     url_host     TYPE bloom_filter(0.05) GRANULARITY 1,
    INDEX idx_bf_email_domain email_domain TYPE bloom_filter(0.05) GRANULARITY 1,

    -- set: low-cardinality columns (stores all distinct values per granule)
    INDEX idx_set_country_tier     country_tier          TYPE set(0) GRANULARITY 1,
    INDEX idx_set_login_type       login_type            TYPE set(0) GRANULARITY 1,
    INDEX idx_set_password_mask    password_mask         TYPE set(0) GRANULARITY 1,
    INDEX idx_set_url_scheme       url_scheme            TYPE set(0) GRANULARITY 1,
    INDEX idx_set_password_entropy password_entropy_band TYPE set(0) GRANULARITY 1,

    -- minmax: date range on imported_at
    INDEX idx_mm_imported_at imported_at TYPE minmax GRANULARITY 1,

    -- proj_imported_desc: lets the Credentials Browser's default view (ORDER BY
    -- imported_at DESC, domain ASC, email ASC, url ASC, password ASC) read in order
    -- instead of a full read + sort (this table's own ORDER BY has imported_at LAST).
    -- Mirrors DDL v14 in lib/clickhouse-migrations.ts — that file is the source of
    -- truth; keep both in sync. negate(toUnixTimestamp(imported_at)) stands in for
    -- "imported_at DESC" since a projection's ORDER BY can't use DESC directly.
    PROJECTION proj_imported_desc (
        SELECT url, email, password, source_file, breach_name, country_tier, login_type,
               password_length, password_mask, url_scheme, is_corporate_email, email_domain,
               url_host, password_entropy_band, imported_at, domain
        ORDER BY negate(toUnixTimestamp(imported_at)), domain, email, url, password
    ),

    -- proj_email_domain_rev: partial projection (projection index) for the domain monitor's
    -- email_domain scan. Ordering by the REVERSED value turns `endsWith(email_domain, '.x')`
    -- into a prefix range ClickHouse can prune on. Mirrors DDL v23 in
    -- lib/clickhouse-migrations.ts — that file is the source of truth; keep both in sync.
    PROJECTION proj_email_domain_rev (
        SELECT _part_offset
        ORDER BY reverse(email_domain)
    ),

    -- proj_domain_rev: the same partial projection for the monitor's `domain` scan
    -- (`domain = 'x' OR endsWith(domain, '.x')`). Mirrors DDL v24 in
    -- lib/clickhouse-migrations.ts — that file is the source of truth; keep both in sync.
    PROJECTION proj_domain_rev (
        SELECT _part_offset
        ORDER BY reverse(domain)
    )
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/credentials', '{replica}')
ORDER BY (domain, email, imported_at)
PARTITION BY toYYYYMM(imported_at)
SETTINGS
    -- 8× larger granules = 8× smaller primary index + 8× faster skip index lookups
    index_granularity = 65536,
    index_granularity_bytes = 67108864,         -- 64 MB size-based fallback

    -- Part format: compact (single-file) for tiny parts, wide (columnar) for large ones
    min_bytes_for_wide_part = 10485760,          -- 10 MB
    min_rows_for_wide_part  = 1000000,           -- 1 M rows

    -- Raise thresholds before ClickHouse starts stalling / rejecting inserts
    -- (critical for sustained bulk ingestion without write pressure pauses)
    parts_to_delay_insert   = 500,
    parts_to_throw_insert   = 1000,
    max_parts_in_total      = 100000,

    -- Allow async deduplication cleanup without blocking inserts
    merge_with_ttl_timeout = 86400,

    -- Durability for merges (inserts are already fsynced by fsync_after_insert in
    -- ulp-performance.xml): fsync a merged part's files before the source parts are dropped.
    -- Mirrors DDL v25 in lib/clickhouse-migrations.ts (the source of truth) -- keep in sync.
    min_rows_to_fsync_after_merge = 1000000,
    min_compressed_bytes_to_fsync_after_merge = 134217728;   -- 128 MiB

-- ── Import source / upload history ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ulp.sources
(
    filename    String   CODEC(ZSTD(1)),
    line_count  UInt64,
    imported_at DateTime DEFAULT now() CODEC(Delta, ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/ulp/sources', '{replica}')
ORDER BY imported_at;

-- ── Domain summary (SummingMergeTree auto-sums on background merge) ───────────
CREATE TABLE IF NOT EXISTS ulp.domains
(
    domain     String   CODEC(ZSTD(3)),
    count      UInt64,
    first_seen DateTime CODEC(Delta, ZSTD(1)),
    last_seen  DateTime CODEC(Delta, ZSTD(1))
)
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/ulp/domains', '{replica}')
ORDER BY domain;
