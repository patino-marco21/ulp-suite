import { dbGet, dbRun, dbQuery } from '@/lib/sqlite'

export interface AppSetting {
  id: number
  key_name: string
  value: string
  description?: string
  created_at: string
  updated_at: string
}

export const SETTING_KEYS = {
  UPLOAD_MAX_FILE_SIZE: 'upload_max_file_size',
  UPLOAD_API_CONCURRENCY: 'upload_api_concurrency',
  UPLOAD_TEMP_CLEANUP_HOURS: 'upload_temp_cleanup_hours',
} as const

export type SettingKey = typeof SETTING_KEYS[keyof typeof SETTING_KEYS]

// Bytes, matching how upload_max_file_size is actually stored (see
// lib/sqlite.ts's seed, '10737418240') and how the settings page reads/
// writes it (Math.round(bytes / 1024**3), formData.maxFileSizeGB * 1024**3)
// — NOT megabytes, despite this file's previous default/comment claiming so.
const DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES = 10 * 1024 ** 3
const MIN_UPLOAD_MAX_FILE_SIZE_BYTES = 1024 * 1024
// Matches the settings page's own form validation ceiling (0.1-100 GB) —
// the generic /api/settings POST endpoint has no server-side bound of its
// own, so a value outside this range must not translate into a broken
// (near-zero or unbounded) upload cap.
const MAX_UPLOAD_MAX_FILE_SIZE_BYTES = 100 * 1024 ** 3

class SettingsManager {
  private cache = new Map<string, AppSetting>()
  private cacheExpiry = new Map<string, number>()
  private readonly CACHE_TTL = 60_000

  async getSetting<T>(keyName: string, defaultValue?: T): Promise<T> {
    const setting = this.getSettingRecord(keyName)
    if (!setting) {
      if (defaultValue !== undefined) return defaultValue
      throw new Error(`Setting '${keyName}' not found`)
    }
    const v = setting.value.trim()
    if (!isNaN(Number(v)) && v !== '') return Number(v) as T
    if (v === 'true' || v === '1') return true as T
    if (v === 'false' || v === '0') return false as T
    if (v.startsWith('{') || v.startsWith('[')) {
      try { return JSON.parse(v) as T } catch { /**/ }
    }
    return v as T
  }

  async getSettingNumber(keyName: string, defaultValue?: number): Promise<number> {
    const v = await this.getSetting<number>(keyName, defaultValue)
    const n = Number(v)
    if (isNaN(n)) return defaultValue ?? 0
    return n
  }

  async updateSetting(keyName: string, value: string | number | boolean | object): Promise<void> {
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
    dbRun(
      `INSERT INTO app_settings (key_name, value) VALUES (?, ?)
       ON CONFLICT(key_name) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [keyName, str]
    )
    this.cache.delete(keyName)
    this.cacheExpiry.delete(keyName)
  }

  async getAllSettings(): Promise<AppSetting[]> {
    return dbQuery('SELECT * FROM app_settings ORDER BY key_name') as AppSetting[]
  }

  /** Get all settings whose key_name starts with prefix */
  async getSettingsByPrefix(prefix: string): Promise<AppSetting[]> {
    return dbQuery(
      `SELECT * FROM app_settings WHERE key_name LIKE ? ORDER BY key_name`,
      [`${prefix}%`]
    ) as AppSetting[]
  }

  /**
   * Admin-configurable upload size ceiling, in bytes, clamped to
   * [MIN_UPLOAD_MAX_FILE_SIZE_BYTES, MAX_UPLOAD_MAX_FILE_SIZE_BYTES]
   * regardless of what's actually stored (see MAX_UPLOAD_MAX_FILE_SIZE_BYTES
   * above for why this can't just trust the raw value).
   */
  async getMaxUploadFileSizeBytes(): Promise<number> {
    const n = Number(await this.getSetting<number>(SETTING_KEYS.UPLOAD_MAX_FILE_SIZE, DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES))
    if (!Number.isFinite(n) || n < MIN_UPLOAD_MAX_FILE_SIZE_BYTES) return DEFAULT_UPLOAD_MAX_FILE_SIZE_BYTES
    return Math.min(n, MAX_UPLOAD_MAX_FILE_SIZE_BYTES)
  }

  /** Convenience: upload-related settings (max_file_size, concurrency, cleanup) */
  async getUploadSettings(): Promise<{
    max_file_size: number
    api_concurrency: number
    temp_cleanup_hours: number
  }> {
    return {
      max_file_size:      await this.getMaxUploadFileSizeBytes(),
      api_concurrency:    await this.getSetting<number>(SETTING_KEYS.UPLOAD_API_CONCURRENCY,      4),
      temp_cleanup_hours: await this.getSetting<number>(SETTING_KEYS.UPLOAD_TEMP_CLEANUP_HOURS,  24),
    }
  }

  /** Convenience: batch-processing settings (alias for upload settings) */
  async getBatchSettings(): Promise<{
    max_file_size: number
    api_concurrency: number
    temp_cleanup_hours: number
  }> {
    return this.getUploadSettings()
  }

  async settingExists(keyName: string): Promise<boolean> {
    return this.getSettingRecord(keyName) !== null
  }

  async deleteSetting(keyName: string): Promise<void> {
    dbRun('DELETE FROM app_settings WHERE key_name = ?', [keyName])
    this.cache.delete(keyName)
    this.cacheExpiry.delete(keyName)
  }

  clearCache(): void {
    this.cache.clear()
    this.cacheExpiry.clear()
  }

  private getSettingRecord(keyName: string): AppSetting | null {
    const cached = this.cache.get(keyName)
    const expiry = this.cacheExpiry.get(keyName)
    if (cached && expiry && Date.now() < expiry) return cached

    const row = dbGet('SELECT * FROM app_settings WHERE key_name = ?', [keyName]) as AppSetting | undefined
    if (!row) return null

    this.cache.set(keyName, row)
    this.cacheExpiry.set(keyName, Date.now() + this.CACHE_TTL)
    return row
  }
}

export const settingsManager = new SettingsManager()
