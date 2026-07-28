const SAME_SITE_VALUES = new Set(['lax', 'strict', 'none'])
const SECURE_VALUES = new Set(['auto', 'true', 'false'])

function normalizedSetting(value, allowed, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return allowed.has(normalized) ? normalized : fallback
}

export function requestUsesHttps(req) {
  return req?.secure === true || String(req?.protocol || '').toLowerCase() === 'https'
}

export function refreshCookieOptions(req, {
  env = process.env,
  maxAge,
} = {}) {
  const secureMode = normalizedSetting(env.REFRESH_COOKIE_SECURE, SECURE_VALUES, 'auto')
  const secure = secureMode === 'true' || (secureMode === 'auto' && requestUsesHttps(req))
  let sameSite = normalizedSetting(env.REFRESH_COOKIE_SAME_SITE, SAME_SITE_VALUES, 'lax')
  // Browsers reject SameSite=None cookies without Secure. Keep direct HTTP
  // deployments usable while HTTPS deployments can opt into cross-site auth.
  if (sameSite === 'none' && !secure) sameSite = 'lax'
  return {
    httpOnly: true,
    sameSite,
    secure,
    path: '/api/auth',
    ...(Number.isFinite(maxAge) && maxAge > 0 ? { maxAge } : {}),
  }
}
