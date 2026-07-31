import crypto from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRoot = process.env.STORY_DATA_FILE
  ? path.join(path.dirname(path.resolve(process.env.STORY_DATA_FILE)), 'skill-market')
  : path.join(serverDir, 'data', 'skill-market')
const storageRoot = process.env.STORY_SKILL_MARKET_DIR
  ? path.resolve(process.env.STORY_SKILL_MARKET_DIR)
  : defaultRoot

const MAX_SKILL_PACKAGE_BYTES = 2 * 1024 * 1024
const allowedExtensions = new Map([
  ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'],
  ['.zip', 'application/zip'],
])

function safeExtension(fileName) {
  const extension = path.extname(String(fileName || '')).toLowerCase()
  if (!allowedExtensions.has(extension)) {
    throw Object.assign(new Error('仅支持上传 .md、.markdown 或 .zip Skill 包'), { status: 400 })
  }
  return extension
}

function decodeBase64(value) {
  const source = String(value || '').replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '')
  if (!source || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) {
    throw Object.assign(new Error('Skill 文件内容无效'), { status: 400 })
  }
  const buffer = Buffer.from(source, 'base64')
  if (!buffer.length || buffer.length > MAX_SKILL_PACKAGE_BYTES) {
    throw Object.assign(new Error(`Skill 文件大小必须在 1 B 到 ${MAX_SKILL_PACKAGE_BYTES / 1024 / 1024} MB 之间`), { status: 400 })
  }
  return buffer
}

export function validateSkillPackage({ fileName, contentBase64 }) {
  const extension = safeExtension(fileName)
  const buffer = decodeBase64(contentBase64)
  if (extension === '.zip' && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw Object.assign(new Error('ZIP Skill 包格式无效'), { status: 400 })
  }
  if (extension !== '.zip') {
    const content = buffer.toString('utf8')
    if (content.includes('\u0000') || !/(?:^|\n)(?:---|#\s|name\s*:)/i.test(content)) {
      throw Object.assign(new Error('Markdown Skill 需要包含标题或 frontmatter'), { status: 400 })
    }
  }
  return {
    buffer,
    extension,
    contentType: allowedExtensions.get(extension),
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
}

export async function writeSkillPackage(id, extension, buffer) {
  await mkdir(storageRoot, { recursive: true })
  const storageName = `${id}${extension}`
  await writeFile(path.join(storageRoot, storageName), buffer, { flag: 'wx' })
  return storageName
}

export async function readSkillPackage(storageName) {
  const fileName = path.basename(String(storageName || ''))
  if (!fileName || fileName !== storageName) throw Object.assign(new Error('Skill 文件路径无效'), { status: 400 })
  try {
    return await readFile(path.join(storageRoot, fileName))
  } catch (error) {
    if (error?.code === 'ENOENT') throw Object.assign(new Error('Skill 文件已不存在'), { status: 404 })
    throw error
  }
}

export async function removeSkillPackage(storageName) {
  const fileName = path.basename(String(storageName || ''))
  if (!fileName || fileName !== storageName) return
  await unlink(path.join(storageRoot, fileName)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}

export { MAX_SKILL_PACKAGE_BYTES }
