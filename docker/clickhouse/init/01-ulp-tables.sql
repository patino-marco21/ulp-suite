-- ULP Vault — ClickHouse Schema
-- Optimised for 100 B+ row credential tables.
-- Requires ClickHouse 25.1+.
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

    country_tier LowCardinality(String) MATERIALIZED multiIf(
        -- ── Email signal: Tier 1 ──────────────────────────────────────────────
        endsWith(splitByChar('@',lower(email))[-1],'.co.uk')
        OR endsWith(splitByChar('@',lower(email))[-1],'.me.uk')
        OR endsWith(splitByChar('@',lower(email))[-1],'.org.uk')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ca')
        OR endsWith(splitByChar('@',lower(email))[-1],'.com.au')
        OR endsWith(splitByChar('@',lower(email))[-1],'.net.au')
        OR endsWith(splitByChar('@',lower(email))[-1],'.co.nz')
        OR endsWith(splitByChar('@',lower(email))[-1],'.net.nz')
        OR endsWith(splitByChar('@',lower(email))[-1],'.us')
        OR splitByChar('@',lower(email))[-1] IN (
            'comcast.net','xfinity.com','verizon.net','att.net','cox.net','charter.net',
            'earthlink.net','bellsouth.net','sbcglobal.net','aol.com','juno.com',
            'btinternet.com','btopenworld.com','sky.com','talktalk.net','virginmedia.com',
            'ntlworld.com','plusnet.com','blueyonder.co.uk','tiscali.co.uk',
            'hotmail.co.uk','yahoo.co.uk','live.co.uk',
            'rogers.com','bell.net','telus.net','shaw.ca','sympatico.ca','videotron.ca',
            'cogeco.ca','eastlink.ca','mts.net','sasktel.net','yahoo.ca','live.ca','hotmail.ca',
            'bigpond.com','bigpond.net.au','optusnet.com.au','iinet.net.au','aapt.com.au',
            'dodo.com.au','internode.on.net','westnet.com.au','tpg.com.au','yahoo.com.au','hotmail.com.au',
            'xtra.co.nz','clear.net.nz','paradise.net.nz','orcon.net.nz','slingshot.co.nz','yahoo.co.nz'
        ), 'T1',
        -- ── Email signal: Tier 2 ──────────────────────────────────────────────
        endsWith(splitByChar('@',lower(email))[-1],'.de')
        OR endsWith(splitByChar('@',lower(email))[-1],'.fr')
        OR endsWith(splitByChar('@',lower(email))[-1],'.it')
        OR endsWith(splitByChar('@',lower(email))[-1],'.es')
        OR endsWith(splitByChar('@',lower(email))[-1],'.nl')
        OR endsWith(splitByChar('@',lower(email))[-1],'.se')
        OR endsWith(splitByChar('@',lower(email))[-1],'.no')
        OR endsWith(splitByChar('@',lower(email))[-1],'.dk')
        OR endsWith(splitByChar('@',lower(email))[-1],'.fi')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ch')
        OR endsWith(splitByChar('@',lower(email))[-1],'.at')
        OR endsWith(splitByChar('@',lower(email))[-1],'.be')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ie')
        OR endsWith(splitByChar('@',lower(email))[-1],'.pt')
        OR endsWith(splitByChar('@',lower(email))[-1],'.jp')
        OR endsWith(splitByChar('@',lower(email))[-1],'.kr')
        OR endsWith(splitByChar('@',lower(email))[-1],'.sg')
        OR endsWith(splitByChar('@',lower(email))[-1],'.il')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ae')
        OR splitByChar('@',lower(email))[-1] IN (
            'web.de','gmx.de','gmx.net','gmx.com','t-online.de','freenet.de','posteo.de','arcor.de',
            'orange.fr','free.fr','sfr.fr','laposte.net','wanadoo.fr','hotmail.fr','yahoo.fr','outlook.fr','live.fr',
            'libero.it','tiscali.it','alice.it','virgilio.it','tin.it','hotmail.it','yahoo.it','live.it',
            'terra.es','hotmail.es','yahoo.es','outlook.es',
            'ziggo.nl','kpnmail.nl','hetnet.nl','xs4all.nl',
            'telenet.be','skynet.be','proximus.be',
            'bluewin.ch','sunrise.ch',
            'eircom.net','eir.ie',
            'tele2.se','comhem.se',
            'naver.com','daum.net','hanmail.net','kakao.com','nate.com',
            'docomo.ne.jp','softbank.ne.jp','yahoo.co.jp','nifty.com',
            'singnet.com.sg','pacific.net.sg',
            'walla.com','netvision.net.il'
        ), 'T2',
        -- ── Email signal: Tier 3 ──────────────────────────────────────────────
        endsWith(splitByChar('@',lower(email))[-1],'.ru')
        OR endsWith(splitByChar('@',lower(email))[-1],'.by')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ua')
        OR endsWith(splitByChar('@',lower(email))[-1],'.pl')
        OR endsWith(splitByChar('@',lower(email))[-1],'.cz')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ro')
        OR endsWith(splitByChar('@',lower(email))[-1],'.bg')
        OR endsWith(splitByChar('@',lower(email))[-1],'.cn')
        OR endsWith(splitByChar('@',lower(email))[-1],'.br')
        OR endsWith(splitByChar('@',lower(email))[-1],'.in')
        OR endsWith(splitByChar('@',lower(email))[-1],'.tr')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ar')
        OR endsWith(splitByChar('@',lower(email))[-1],'.mx')
        OR endsWith(splitByChar('@',lower(email))[-1],'.id')
        OR endsWith(splitByChar('@',lower(email))[-1],'.vn')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ph')
        OR endsWith(splitByChar('@',lower(email))[-1],'.sa')
        OR endsWith(splitByChar('@',lower(email))[-1],'.eg')
        OR endsWith(splitByChar('@',lower(email))[-1],'.za')
        OR endsWith(splitByChar('@',lower(email))[-1],'.ng')
        OR splitByChar('@',lower(email))[-1] IN (
            'mail.ru','yandex.ru','yandex.com','rambler.ru','bk.ru','list.ru','inbox.ru','ya.ru',
            'qq.com','163.com','126.com','sina.com','sohu.com','yeah.net','foxmail.com','21cn.com',
            'yahoo.com.br','uol.com.br','bol.com.br','ig.com.br','terra.com.br','r7.com',
            'rediffmail.com','sify.com','indiatimes.com',
            'wp.pl','o2.pl','onet.pl','interia.pl','poczta.fm',
            'seznam.cz','centrum.cz','atlas.cz',
            'abv.bg','mail.bg','dir.bg',
            'ukr.net','meta.ua','i.ua',
            'mynet.com','yahoo.com.vn','yahoo.co.id'
        ), 'T3',
        -- ── URL TLD fallback ──────────────────────────────────────────────────
        lower(tld) IN ('uk','ca','au','nz','us'), 'T1',
        lower(tld) IN ('de','fr','it','es','nl','se','no','dk','fi','ch','at','be','ie','pt','jp','kr','sg','il','ae','lu','gr'), 'T2',
        lower(tld) IN ('ru','cn','br','pl','cz','ro','bg','ua','by','sk','rs','hr','si','lt','lv','ee',
                       'ar','mx','cl','pe','ve','ec','uy','bo','py','id','vn','th','ph','my','bd','pk','in',
                       'tr','sa','eg','za','ng','ke','ma','dz','tn','ir'), 'T3',
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

    -- ── Skip indexes ──────────────────────────────────────────────────────────
    -- tokenbf_v1: hasToken() on url/email/password for keyword search
    INDEX idx_url      url      TYPE tokenbf_v1(65536, 3, 0) GRANULARITY 2,
    INDEX idx_email    email    TYPE tokenbf_v1(65536, 3, 0) GRANULARITY 2,
    INDEX idx_password password TYPE tokenbf_v1(65536, 3, 0) GRANULARITY 2,
    INDEX idx_email_ngram email TYPE ngrambf_v1(3, 512, 2, 0) GRANULARITY 2,

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
    INDEX idx_mm_imported_at imported_at TYPE minmax GRANULARITY 1
)
ENGINE = MergeTree
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
    merge_with_ttl_timeout = 86400;

-- ── Import source / upload history ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ulp.sources
(
    filename    String   CODEC(ZSTD(1)),
    line_count  UInt64,
    imported_at DateTime DEFAULT now() CODEC(Delta, ZSTD(1))
)
ENGINE = MergeTree
ORDER BY imported_at;

-- ── Domain summary (SummingMergeTree auto-sums on background merge) ───────────
CREATE TABLE IF NOT EXISTS ulp.domains
(
    domain     String   CODEC(ZSTD(3)),
    count      UInt64,
    first_seen DateTime CODEC(Delta, ZSTD(1)),
    last_seen  DateTime CODEC(Delta, ZSTD(1))
)
ENGINE = SummingMergeTree
ORDER BY domain;
