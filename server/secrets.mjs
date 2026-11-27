// 本地密钥工具
// ---------------------------------------------------------------
// 只保留「加密保存模型 API Key」这一件事。登录、JWT、刷新令牌、密码哈希、
// 邮箱验证码全部随账号体系一起移除了。
//
// AUTH_SECRET 仍然必需：它派生 AES-256-GCM 密钥，用来加密 settings 里的
// apiKeyEnc。桌面壳/启动器会把随机生成的 secret 持久化在应用数据目录。
import crypto from 'node:crypto'

const configuredSecret = process.env.AUTH_SECRET || 'local-dev-only-change-this-story-studio-secret'

export const usesDefaultSecret = !process.env.AUTH_SECRET

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
