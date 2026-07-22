import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { jwtVerify, SignJWT } from 'jose'

const scrypt = promisify(crypto.scrypt)
const issuer = 'story-studio-api'
const audience = 'story-studio-client'
const accessTtl = '15m'
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000
const configuredSecret = process.env.AUTH_SECRET || 'local-dev-only-change-this-story-studio-secret'
const signingKey = new TextEncoder().encode(configuredSecret)

export const usesDefaultSecret = !process.env.AUTH_SECRET

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url')
  const derivedKey = await scrypt(password, salt, 64)
  return `scrypt$${salt}$${Buffer.from(derivedKey).toString('base64url')}`
}

export async function verifyPassword(password, encodedHash) {
  const [algorithm, salt, storedKey] = String(encodedHash || '').split('$')
  if (algorithm !== 'scrypt' || !salt || !storedKey) return false
  const stored = Buffer.from(storedKey, 'base64url')
  const derived = Buffer.from(await scrypt(password, salt, stored.length))
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived)
}

export async function createAccessToken(user) {
  return new SignJWT({ name: user.name, email: user.email })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(accessTtl)
    .sign(signingKey)
}

export async function verifyAccessToken(token) {
  const result = await jwtVerify(token, signingKey, { issuer, audience, algorithms: ['HS256'] })
  return result.payload
}

export function createRefreshSession(userId, metadata = {}) {
  const token = crypto.randomBytes(48).toString('base64url')
  return {
    token,
    session: {
      id: crypto.randomUUID(),
      userId,
      tokenHash: hashRefreshToken(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + refreshTtlMs).toISOString(),
      userAgent: String(metadata.userAgent || '').slice(0, 300),
    },
  }
}

export function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

const encryptionKey = crypto.createHash('sha256').update(configuredSecret).digest()

export function encryptSecret(plaintext) {
  if (!plaintext) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `gcm$${iv.toString('base64url')}$${tag.toString('base64url')}$${encrypted.toString('base64url')}`
}

export function decryptSecret(encoded) {
  if (!encoded) return null
  const parts = String(encoded).split('$')
  if (parts.length !== 4 || parts[0] !== 'gcm') return null
  const iv = Buffer.from(parts[1], 'base64url')
  const tag = Buffer.from(parts[2], 'base64url')
  const data = Buffer.from(parts[3], 'base64url')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function maskKey(key) {
  if (!key) return null
  const str = String(key)
  if (str.length <= 8) return '****'
  return `${str.slice(0, 3)}${'*'.repeat(Math.min(str.length - 7, 20))}${str.slice(-4)}`
}

export function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt }
}

export const refreshCookie = {
  name: 'story_refresh',
  maxAge: refreshTtlMs,
}
