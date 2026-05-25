/**
 * Comprehensive list of free / consumer webmail and ISP email providers.
 * Used to classify credentials as corporate vs. consumer.
 * is_corporate_email = 1 when the email domain is NOT in this list.
 *
 * Last expanded: 2025-05 — added privacy mail, disposable/temp domains,
 * regional ISPs, and providers prominent in 2024-25 breach data.
 */

export const FREE_WEBMAIL_PROVIDERS: readonly string[] = [
  // ── Google ────────────────────────────────────────────────────────────────
  'gmail.com', 'googlemail.com',

  // ── Yahoo ─────────────────────────────────────────────────────────────────
  'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.it', 'yahoo.es',
  'yahoo.com.br', 'yahoo.com.au', 'yahoo.co.jp', 'yahoo.co.in', 'yahoo.com.ar',
  'yahoo.com.mx', 'yahoo.com.ph', 'yahoo.com.vn', 'yahoo.co.id', 'yahoo.com.sg',
  'yahoo.com.hk', 'yahoo.co.nz', 'yahoo.ro', 'yahoo.gr', 'yahoo.com.tr',
  'ymail.com', 'rocketmail.com',

  // ── Microsoft / Hotmail / Outlook / Live / MSN ────────────────────────────
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.it',
  'hotmail.es', 'hotmail.com.br', 'hotmail.com.ar', 'hotmail.com.au',
  'hotmail.com.tr', 'hotmail.be', 'hotmail.nl', 'hotmail.pt', 'hotmail.ro',
  'hotmail.co.jp', 'hotmail.co.nz', 'hotmail.gr', 'hotmail.com.mx', 'hotmail.se',
  'hotmail.no', 'hotmail.dk', 'hotmail.fi',
  'outlook.com', 'outlook.fr', 'outlook.de', 'outlook.es', 'outlook.it',
  'outlook.com.au', 'outlook.co.uk', 'outlook.be', 'outlook.nl', 'outlook.pt',
  'outlook.com.br', 'outlook.in', 'outlook.jp', 'outlook.com.tr',
  'outlook.sa', 'outlook.at', 'outlook.dk', 'outlook.se', 'outlook.no',
  'live.com', 'live.co.uk', 'live.fr', 'live.de', 'live.it', 'live.es',
  'live.ca', 'live.com.au', 'live.com.br', 'live.in', 'live.nl', 'live.be',
  'live.at', 'live.no', 'live.se', 'live.dk', 'live.com.ar', 'live.com.mx',
  'live.com.pt', 'live.jp',
  'msn.com', 'passport.com', 'windowslive.com',

  // ── Apple iCloud ──────────────────────────────────────────────────────────
  'icloud.com', 'me.com', 'mac.com',

  // ── AOL / AIM / Verizon Media ─────────────────────────────────────────────
  'aol.com', 'aim.com', 'aol.co.uk', 'aol.de', 'aol.fr', 'aol.it',

  // ── Privacy / encrypted mail ──────────────────────────────────────────────
  'protonmail.com', 'protonmail.ch', 'pm.me', 'proton.me',
  'tutanota.com', 'tuta.io', 'tutanota.de', 'keemail.me',
  'fastmail.com', 'fastmail.net', 'fastmail.org', 'fastmail.fm', 'fastmail.to',
  'fastmail.cn', 'fastmail.es', 'fastmail.de', 'fastmail.jp', 'fastmail.us',
  'fastmail.se', 'fastmail.in', 'fastmail.co.uk',
  'hey.com',
  'duck.com',                   // DuckDuckGo email relay
  'skiff.com',                  // defunct but present in datasets
  'mailfence.com',
  'runbox.com', 'runbox.no',
  'startmail.com',
  'disroot.org',
  'riseup.net',
  'posteo.de', 'posteo.net',
  'ctemplar.com',               // defunct, still in datasets

  // ── Generic free providers ────────────────────────────────────────────────
  'mail.com', 'email.com', 'usa.com', 'myself.com', 'cheerful.com',
  'zoho.com', 'zohomail.com',
  'gmx.com', 'gmx.us',
  'inbox.com',
  'hushmail.com', 'hush.com', 'hush.ai',

  // ── Disposable / temporary mail ───────────────────────────────────────────
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamail.de', 'guerrillamail.biz', 'guerrillamail.info',
  'sharklasers.com', 'guerrillamailblock.com', 'grr.la', 'spam4.me',
  'trashmail.com', 'trashmail.at', 'trashmail.io', 'trashmail.me',
  'trashmail.net', 'trashmail.org',
  'tempmail.com', 'throwam.com', 'temp-mail.org', 'throwam.com',
  'mailnull.com', 'dispostable.com', 'fakeinbox.com', 'spamgourmet.com',
  'yopmail.com', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf', 'nospam.ze.tc',
  'nomail.xl.cx', 'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf',
  'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf',
  'mailnesia.com', 'filzmail.com', 'spamdrop.net', 'mailnew.com',
  'maildrop.cc', 'boun.cr', 'wegwerfemail.de', 'shitware.nl',
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '33mail.com',
  'spamex.com', 'deadaddress.com', 'spamevader.com', 'hatespam.org',
  'nospamfor.us', 'mailexpire.com', 'tempr.email', 'throwam.com',

  // ── Russian ───────────────────────────────────────────────────────────────
  'yandex.com', 'yandex.ru', 'yandex.ua', 'yandex.kz', 'yandex.by',
  'ya.ru', 'mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'rambler.ru',
  'lenta.ru', 'myrambler.ru', 'autorambler.ru', 'ro.ru',

  // ── Chinese ───────────────────────────────────────────────────────────────
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  'foxmail.com', '21cn.com', 'yeah.net', 'sina.cn', '188.com',
  'vip.163.com', 'vip.126.com', 'vip.sina.com',

  // ── German ────────────────────────────────────────────────────────────────
  'web.de', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch',
  'freenet.de', 't-online.de', 'arcor.de', 'online.de',
  '1und1.de', 'lycos.de', 'lycos.com', 'ewetel.net',

  // ── Italian ───────────────────────────────────────────────────────────────
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it', 'tin.it',
  'email.it', 'inwind.it', 'iol.it', 'blu.it', 'supereva.it',

  // ── French ───────────────────────────────────────────────────────────────
  'orange.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'wanadoo.fr',
  'neuf.fr', 'bbox.fr', 'bouyguestelecom.fr', 'numericable.fr',
  'club-internet.fr', 'magic.fr', 'cegetel.net', 'aliceadsl.fr',

  // ── Spanish ───────────────────────────────────────────────────────────────
  'terra.es', 'movistar.es', 'vodafone.es', 'jazztel.es', 'ono.es',
  'euskaltel.com', 'ya.com', 'arnet.com.ar',

  // ── Korean / Japanese ─────────────────────────────────────────────────────
  'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
  'paran.com', 'korea.com', 'netian.com',
  'docomo.ne.jp', 'softbank.ne.jp', 'nifty.com', 'ezweb.ne.jp',
  'au.com', 'i.softbank.jp', 'yahoo.co.jp', 'biglobe.ne.jp',
  'dion.ne.jp', 'excite.co.jp', 'plala.or.jp', 'ocn.ne.jp',

  // ── Brazilian ────────────────────────────────────────────────────────────
  'uol.com.br', 'bol.com.br', 'ig.com.br', 'terra.com.br', 'r7.com',
  'globo.com', 'click21.com.br', 'pop.com.br', 'oi.com.br',

  // ── Eastern European ──────────────────────────────────────────────────────
  'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'poczta.fm', 'gazeta.pl',
  'op.pl', 'tlen.pl',
  'seznam.cz', 'centrum.cz', 'volny.cz', 'post.cz', 'email.cz',
  'abv.bg', 'mail.bg', 'dir.bg',
  'ukr.net', 'meta.ua', 'i.ua', 'ukrpost.ua',
  'freemail.hu', 'citromail.hu', 'freemail.c3.hu',
  'yahoo.ro', 'yahoo.pl', 'yahoo.cz', 'yahoo.hu',
  'yahoo.gr', 'yahoo.co.za',

  // ── Turkish ───────────────────────────────────────────────────────────────
  'mynet.com', 'turk.net', 'turkcell.com.tr', 'superonline.com',
  'ttmail.com', 'e-kolay.net', 'mailtemp.net',

  // ── Indian ───────────────────────────────────────────────────────────────
  'rediffmail.com', 'indiatimes.com', 'sify.com',

  // ── Middle East / North Africa ────────────────────────────────────────────
  'maktoob.com', 'arabdict.com',

  // ── Consumer ISPs — US ───────────────────────────────────────────────────
  'comcast.net', 'xfinity.com', 'verizon.net', 'att.net', 'att.com',
  'cox.net', 'charter.net', 'earthlink.net', 'bellsouth.net', 'sbcglobal.net',
  'roadrunner.com', 'rr.com', 'twc.com', 'optonline.net', 'windstream.net',
  'centurylink.net', 'q.com', 'embarqmail.com', 'netzero.net', 'juno.com',
  'peoplepc.com', 'netscape.net',

  // ── Consumer ISPs — UK ───────────────────────────────────────────────────
  'btinternet.com', 'btopenworld.com', 'bt.com', 'sky.com', 'skynet.be',
  'talktalk.net', 'virginmedia.com', 'ntlworld.com', 'plusnet.com',
  'blueyonder.co.uk', 'tiscali.co.uk', 'pipex.com', 'fsnet.co.uk',
  'o2.co.uk', 'orange.co.uk', 'homecall.co.uk',

  // ── Consumer ISPs — Canada ───────────────────────────────────────────────
  'rogers.com', 'bell.net', 'telus.net', 'shaw.ca', 'cogeco.ca',
  'videotron.ca', 'eastlink.ca', 'mts.net', 'sasktel.net', 'sympatico.ca',

  // ── Consumer ISPs — Australia / NZ ───────────────────────────────────────
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'iinet.net.au',
  'tpg.com.au', 'westnet.com.au', 'dodo.com.au', 'aapt.com.au',
  'internode.on.net', 'adam.com.au',
  'xtra.co.nz', 'clear.net.nz', 'paradise.net.nz', 'slingshot.co.nz',

  // ── Consumer ISPs — Netherlands / Belgium ────────────────────────────────
  'ziggo.nl', 'kpnmail.nl', 'hetnet.nl', 'xs4all.nl', 'planet.nl',
  'chello.nl', 'home.nl', 'upcmail.nl',
  'telenet.be', 'skynet.be', 'proximus.be', 'scarlet.be', 'swing.be',

  // ── Consumer ISPs — Switzerland ───────────────────────────────────────────
  'bluewin.ch', 'sunrise.ch', 'swisscom.com', 'hispeed.ch',

  // ── Consumer ISPs — Ireland ───────────────────────────────────────────────
  'eircom.net', 'eir.ie', 'indigo.ie', 'ireland.com',

  // ── Consumer ISPs — Nordic ───────────────────────────────────────────────
  'tele2.se', 'comhem.se', 'spray.se', 'bredband.net',
  'telenor.no', 'online.no', 'c2i.net',
  'tdc.dk', 'jubii.dk', 'stofanet.dk',
  'saunalahti.fi', 'welho.com', 'kolumbus.fi',

  // ── Consumer ISPs — Israel ────────────────────────────────────────────────
  'walla.com', 'walla.co.il', 'netvision.net.il', 'bezeqint.net',
  'zahav.net.il', '012.net.il',

  // ── Consumer ISPs — Singapore ────────────────────────────────────────────
  'singnet.com.sg', 'pacific.net.sg', 'starhub.com',
]

/** SQL-formatted IN() clause for use in MATERIALIZED column expressions */
export function buildFreeWebmailInClause(): string {
  return FREE_WEBMAIL_PROVIDERS.map(p => `'${p}'`).join(',')
}
