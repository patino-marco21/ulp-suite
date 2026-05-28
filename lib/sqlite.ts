import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import bcrypt from 'bcryptjs'

const DB_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'ulp.db')

const globalForDb = global as unknown as { _sqliteDb: Database.Database | undefined }

function getDb(): Database.Database {
  if (globalForDb._sqliteDb) return globalForDb._sqliteDb

  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  globalForDb._sqliteDb = db
  return db
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','analyst')),
      is_active INTEGER NOT NULL DEFAULT 1,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      backup_codes TEXT,
      preferences TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'analyst' CHECK(role IN ('admin','analyst')),
      rate_limit INTEGER NOT NULL DEFAULT 100,
      rate_limit_window INTEGER NOT NULL DEFAULT 60,
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_email TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_name TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS domain_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      domains TEXT NOT NULL DEFAULT '[]',
      match_mode TEXT NOT NULL DEFAULT 'both' CHECK(match_mode IN ('credential','url','both')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      last_triggered_at TEXT,
      total_alerts INTEGER NOT NULL DEFAULT 0,
      rescan_mode TEXT NOT NULL DEFAULT 'dedup' CHECK(rescan_mode IN ('dedup','digest')),
      rescan_interval_hours INTEGER NOT NULL DEFAULT 24,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monitor_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT,
      headers TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monitor_webhook_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      webhook_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (monitor_id) REFERENCES domain_monitors(id) ON DELETE CASCADE,
      FOREIGN KEY (webhook_id) REFERENCES monitor_webhooks(id) ON DELETE CASCADE,
      UNIQUE(monitor_id, webhook_id)
    );

    CREATE TABLE IF NOT EXISTS monitor_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      webhook_id INTEGER NOT NULL,
      source_file TEXT,
      matched_domain TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'credential_email',
      credential_match_count INTEGER NOT NULL DEFAULT 0,
      url_match_count INTEGER NOT NULL DEFAULT 0,
      payload_sent TEXT,
      status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed','retrying')),
      http_status INTEGER,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (monitor_id) REFERENCES domain_monitors(id) ON DELETE CASCADE,
      FOREIGN KEY (webhook_id) REFERENCES monitor_webhooks(id) ON DELETE CASCADE
    );

    -- Tracks individual credential fingerprints that have already triggered alerts.
    -- Prevents duplicate webhook deliveries when the same credential appears in multiple uploads.
    -- fingerprint is a 16-char hex string (first 8 bytes of SHA-256).
    CREATE TABLE IF NOT EXISTS monitor_credential_seen (
      monitor_id  INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (monitor_id, fingerprint)
    );

    -- Named data breach catalog (HIBP-compatible schema).
    -- Populated via HIBP sync or manually created for non-HIBP sources.
    CREATE TABLE IF NOT EXISTS breaches (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      breach_name          TEXT UNIQUE NOT NULL,
      title                TEXT NOT NULL,
      domain               TEXT NOT NULL DEFAULT '',
      breach_date          TEXT NOT NULL DEFAULT '',
      pwn_count            INTEGER NOT NULL DEFAULT 0,
      description          TEXT NOT NULL DEFAULT '',
      logo_path            TEXT NOT NULL DEFAULT '',
      data_classes         TEXT NOT NULL DEFAULT '[]',
      is_verified          INTEGER NOT NULL DEFAULT 0,
      is_fabricated        INTEGER NOT NULL DEFAULT 0,
      is_sensitive         INTEGER NOT NULL DEFAULT 0,
      is_spam_list         INTEGER NOT NULL DEFAULT 0,
      is_malware           INTEGER NOT NULL DEFAULT 0,
      is_stealer_log       INTEGER NOT NULL DEFAULT 0,
      is_mega_dump         INTEGER NOT NULL DEFAULT 0,
      source_file_patterns TEXT NOT NULL DEFAULT '[]',
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Maps each uploaded source file to the breach it belongs to.
    -- 'manual' entries always take priority over auto-detected ones.
    CREATE TABLE IF NOT EXISTS source_breach_map (
      source_file  TEXT PRIMARY KEY,
      breach_name  TEXT NOT NULL,
      confidence   REAL NOT NULL DEFAULT 1.0,
      match_method TEXT NOT NULL DEFAULT 'manual',
      matched_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Feed intelligence: named category groups (e.g. "Exploit DBs", "Paste Sites")
    CREATE TABLE IF NOT EXISTS feed_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      slug       TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Feed intelligence: individual RSS/Atom sources scoped to a category
    CREATE TABLE IF NOT EXISTS feed_sources (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id     INTEGER NOT NULL,
      name            TEXT NOT NULL,
      rss_url         TEXT NOT NULL,
      last_fetched_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES feed_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhook_outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id       INTEGER NOT NULL,
      webhook_id       INTEGER NOT NULL,
      payload          TEXT    NOT NULL,
      source_file      TEXT    NOT NULL,
      matched_domain   TEXT    NOT NULL,
      cred_count       INTEGER NOT NULL DEFAULT 0,
      status           TEXT    NOT NULL DEFAULT 'pending',
      attempt_count    INTEGER NOT NULL DEFAULT 1,
      next_attempt_at  TEXT    NOT NULL,
      last_error       TEXT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Index for the outbox worker's hot-path query
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhook_outbox_status_next
      ON webhook_outbox (status, next_attempt_at)
  `)

  // Add rescan columns to existing databases (idempotent — catch swallows "duplicate column" errors)
  try { db.exec(`ALTER TABLE domain_monitors ADD COLUMN rescan_mode TEXT NOT NULL DEFAULT 'dedup' CHECK(rescan_mode IN ('dedup','digest'))`) } catch {}
  try { db.exec(`ALTER TABLE domain_monitors ADD COLUMN rescan_interval_hours INTEGER NOT NULL DEFAULT 24`) } catch {}

  // Migrate monitor_credential_seen.fingerprint INTEGER → TEXT (v2 fingerprint is 16-char hex).
  // SQLite doesn't support ALTER COLUMN, so we check the type and recreate if needed.
  // Data loss is acceptable — fingerprints regenerate on next monitor scan (monitors re-alert once).
  try {
    const cols = db.prepare(`PRAGMA table_info(monitor_credential_seen)`).all() as Array<{ name: string; type: string }>
    const fpCol = cols.find(c => c.name === 'fingerprint')
    if (fpCol && fpCol.type.toUpperCase() === 'INTEGER') {
      db.exec(`
        DROP TABLE monitor_credential_seen;
        CREATE TABLE IF NOT EXISTS monitor_credential_seen (
          monitor_id  INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (monitor_id, fingerprint)
        );
      `)
    }
  } catch {}

  // Default app settings
  const settingsInsert = db.prepare(
    `INSERT OR IGNORE INTO app_settings (key_name, value, description) VALUES (?, ?, ?)`
  )
  settingsInsert.run('upload_max_file_size', '10737418240', 'Max upload size in bytes (10GB default)')
  settingsInsert.run('upload_api_concurrency', '2', 'Max concurrent API upload jobs')
  settingsInsert.run('upload_temp_cleanup_hours', '24', 'Orphan temp file retention in hours')

  // Seed default admin from env if no users exist
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c
  if (count === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@ulp.local'
    const raw = process.env.ADMIN_PASSWORD || 'admin'
    const hash = bcrypt.hashSync(raw, 12)
    db.prepare(
      `INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`
    ).run(email, hash, 'Admin')
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export function dbQuery(sql: string, params: unknown[] = []): unknown[] {
  return getDb().prepare(sql).all(params)
}

export function dbGet(sql: string, params: unknown[] = []): unknown | undefined {
  return getDb().prepare(sql).get(params)
}

export function dbRun(sql: string, params: unknown[] = []): { lastId: number; changes: number } {
  const r = getDb().prepare(sql).run(params)
  return { lastId: Number(r.lastInsertRowid), changes: r.changes }
}

export function dbExec(sql: string): void {
  getDb().exec(sql)
}

// Ensure the DB is initialised (idempotent - safe to call at startup)
export function ensureDb(): void {
  getDb()
}
