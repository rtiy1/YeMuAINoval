// 下载 Bun 运行时作为 Tauri sidecar（bundle.externalBin）
// ---------------------------------------------------------------
// 用途：把官方 Bun 二进制按 Tauri sidecar 的命名规范放到 src-tauri/binaries/，
//       供 `tauri build` 打进桌面安装包。
//
// 用法：
//   bun scripts/fetch-bun-runtime.mjs                 # 下载全部目标平台
//   bun scripts/fetch-bun-runtime.mjs x86_64-pc-windows-msvc
//   BUN_VERSION=1.3.14 bun scripts/fetch-bun-runtime.mjs aarch64-apple-darwin
//
// 依赖：网络 + bun（或 node）。ZIP 解压内置实现，无需 unzip/7z。
// ---------------------------------------------------------------
import zlib from 'node:zlib'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, 'src-tauri', 'binaries')
const version = process.env.BUN_VERSION || '1.3.14'

// Tauri sidecar 目标名（tauri 会在文件名后追加目标三元组与平台扩展名）
const TARGETS = {
  'x86_64-pc-windows-msvc': { asset: 'bun-windows-x64', exe: 'bun.exe' },
  'x86_64-apple-darwin': { asset: 'bun-darwin-x64', exe: 'bun' },
  'aarch64-apple-darwin': { asset: 'bun-darwin-aarch64', exe: 'bun' },
  'x86_64-unknown-linux-gnu': { asset: 'bun-linux-x64', exe: 'bun' },
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65_557)
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('ZIP: EOCD not found')
}

function listEntries(buf) {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const entries = []
  let off = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP: bad central directory header')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    entries.push({ name, method, compSize, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function extractEntry(buf, entry) {
  const off = entry.localOffset
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('ZIP: bad local file header')
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const dataStart = off + 30 + nameLen + extraLen
  const data = buf.subarray(dataStart, dataStart + entry.compSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) return zlib.inflateRawSync(data)
  throw new Error(`ZIP: unsupported compression method ${entry.method}`)
}

async function fetchTarget(target) {
  const { asset, exe } = TARGETS[target]
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}.zip`
  console.log(`[bun] ${target}: downloading ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${target}: HTTP ${response.status} downloading ${url}`)
  const buf = Buffer.from(await response.arrayBuffer())
  const entries = listEntries(buf)
  const entry = entries.find((item) => path.basename(item.name) === exe)
  if (!entry) throw new Error(`${target}: ${exe} not found in archive`)
  const bytes = extractEntry(buf, entry)

  await fs.mkdir(outDir, { recursive: true })
  const fileName = `bun-${target}${target.endsWith('-windows-msvc') ? '.exe' : ''}`
  const outPath = path.join(outDir, fileName)
  await fs.writeFile(outPath, bytes, { mode: 0o755 })
  console.log(`[bun] ${target} -> ${outPath} (${bytes.length} bytes)`)
}

const requested = new Set(process.argv.slice(2))
const targets = requested.size
  ? Object.keys(TARGETS).filter((target) => requested.has(target))
  : Object.keys(TARGETS)

if (!targets.length) {
  console.error('未知目标。可用:', Object.keys(TARGETS).join(', '))
  process.exit(1)
}

for (const target of targets) await fetchTarget(target)
console.log('[bun] done. 可在 Windows/macOS 上执行 `bun run desktop:tauri:build` 打包。')
