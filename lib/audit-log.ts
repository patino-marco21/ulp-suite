import { dbRun } from '@/lib/sqlite'

export type AuditAction =
  | 'upload.start' | 'upload.complete' | 'upload.fail'
  | 'upload.api.start' | 'upload.api.complete' | 'upload.api.fail'
  | 'user.create' | 'user.update' | 'user.delete'
  | 'user.login' | 'user.logout' | 'user.login.fail'
  | 'user.password.change' | 'user.totp.enable' | 'user.totp.disable'
  | 'apikey.create' | 'apikey.update' | 'apikey.delete' | 'apikey.revoke'
  | 'settings.update' | 'data.export'

export interface AuditLogEntry {
  id?: number
  user_id: number | null
  user_email: string | null
  action: AuditAction
  resource_type: string
  resource_id: string | null
  details: Record<string, unknown>
  ip_address: string | null
  user_agent: string | null
  created_at?: string
}

export function getClientInfo(request: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip')
  return {
    ip: ip || null,
    userAgent: (request.headers.get('user-agent') || '').substring(0, 500) || null,
  }
}

export async function createAuditLog(entry: Omit<AuditLogEntry, 'id' | 'created_at'>): Promise<number> {
  try {
    const { lastId } = dbRun(
      `INSERT INTO audit_logs (user_id, user_email, action, resource_type, resource_id, details, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.user_id,
        entry.user_email,
        entry.action,
        entry.resource_type,
        entry.resource_id,
        JSON.stringify(entry.details || {}),
        entry.ip_address,
        entry.user_agent,
      ]
    )
    return lastId
  } catch (err) {
    console.error('Failed to create audit log:', err)
    return -1
  }
}

export async function logUserAction(
  action: 'user.create' | 'user.update' | 'user.delete' | 'user.login' | 'user.logout'
         | 'user.login.fail' | 'user.password.change' | 'user.totp.enable' | 'user.totp.disable',
  performedBy: { id: number | null; email: string | null },
  targetUserId: number | string | null,
  details: Record<string, unknown>,
  request?: Request
): Promise<number> {
  const clientInfo = request ? getClientInfo(request) : { ip: null, userAgent: null }
  return createAuditLog({
    user_id: performedBy.id,
    user_email: performedBy.email,
    action,
    resource_type: 'user',
    resource_id: targetUserId ? String(targetUserId) : null,
    details,
    ip_address: clientInfo.ip,
    user_agent: clientInfo.userAgent,
  })
}

export async function logApiKeyAction(
  action: 'apikey.create' | 'apikey.update' | 'apikey.delete' | 'apikey.revoke',
  performedBy: { id: number | null; email: string | null },
  apiKeyId: number | string | null,
  details: Record<string, unknown>,
  request?: Request
): Promise<number> {
  const clientInfo = request ? getClientInfo(request) : { ip: null, userAgent: null }
  return createAuditLog({
    user_id: performedBy.id,
    user_email: performedBy.email,
    action,
    resource_type: 'api_key',
    resource_id: apiKeyId ? String(apiKeyId) : null,
    details,
    ip_address: clientInfo.ip,
    user_agent: clientInfo.userAgent,
  })
}

export async function logSettingsAction(
  performedBy: { id: number | null; email: string | null },
  settingKey: string,
  details: Record<string, unknown>,
  request?: Request
): Promise<number> {
  const clientInfo = request ? getClientInfo(request) : { ip: null, userAgent: null }
  return createAuditLog({
    user_id: performedBy.id,
    user_email: performedBy.email,
    action: 'settings.update',
    resource_type: 'settings',
    resource_id: settingKey,
    details,
    ip_address: clientInfo.ip,
    user_agent: clientInfo.userAgent,
  })
}

export async function logUploadAction(
  action: 'upload.start' | 'upload.complete' | 'upload.fail' | 'upload.api.start' | 'upload.api.complete' | 'upload.api.fail',
  performedBy: { id: number | null; email: string | null },
  jobId: string | null,
  details: Record<string, unknown>,
  request?: Request
): Promise<number> {
  const clientInfo = request ? getClientInfo(request) : { ip: null, userAgent: null }
  return createAuditLog({
    user_id: performedBy.id,
    user_email: performedBy.email,
    action,
    resource_type: 'upload',
    resource_id: jobId,
    details,
    ip_address: clientInfo.ip,
    user_agent: clientInfo.userAgent,
  })
}

export async function logDataExport(
  performedBy: { id: number | null; email: string | null },
  exportType: string,
  details: Record<string, unknown>,
  request?: Request
): Promise<number> {
  const clientInfo = request ? getClientInfo(request) : { ip: null, userAgent: null }
  return createAuditLog({
    user_id: performedBy.id,
    user_email: performedBy.email,
    action: 'data.export',
    resource_type: exportType,
    resource_id: null,
    details,
    ip_address: clientInfo.ip,
    user_agent: clientInfo.userAgent,
  })
}
