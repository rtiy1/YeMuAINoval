// 准备桌面版运行时目录（打包瘦身）
// ---------------------------------------------------------------
// `tauri build` 的 bundle.resources 原先直接指向仓库根，把整个 node_modules
// （含 onnxruntime / fastembed / @huggingface 等 800MB+ 的 ML 依赖、以及
// 全部 devDependencies）都打进安装包。
//
// 本脚本生成一个最小运行时目录 .server-runtime/，只包含：
//   server/  src/  skills/  public/  dist/  package.json  LICENSE
//   node_modules/ ← 只装 server 与 agent-runtime 真正 import 的包
//
// 用法：
//   bun scripts/prepare-runtime.mjs            # 生成 .server-runtime/
//   bun scripts/prepare-runtime.mjs --report   # 只打印依赖清单，不落盘
// ---------------------------------------------------------------
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(repoRoot, '.server-runtime')

// 服务端与 agent-runtime 直接 import 的包（见 server/*.mjs 与 src/agent-runtime.ts）。
const RUNTIME_PACKAGES = [
  'express',
  'express-rate-limit',
  'helmet',
]

// 工作区包：只拷这几个目录本身（它们是 workspace:*，不通过 npm 解析）。
const RUNTIME_WORKSPACES = [
  'packages/agent',
  'packages/catalog',
  'packages/ai',
  'packages/utils',
  'packages/wire',
]

// 需要整体复制的应用目录。
const COPY_DIRS = ['server', 'src', 'skills']
// 仓库里的示例数据不该进安装包：桌面版的数据在应用数据目录。
const COPY_SKIP = ['server']
const COPY_FILES = ['LICENSE', 'index.html']

async function exists(target) {
  return Boolean(await fs.stat(target).catch(() => null))
}

function log(message) {
  console.log(`[runtime] ${message}`)
}

async function copyDirectory(from, to, { skip = [] } = {}) {
  const entries = await fs.readdir(from, { withFileTypes: true })
  await fs.mkdir(to, { recursive: true })
  for (const entry of entries) {
    if (skip.includes(entry.name)) continue
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      await copyDirectory(source, target)
    } else if (entry.isFile()) {
      await fs.copyFile(source, target)
    }
  }
}

async function directorySize(dir) {
  let total = 0
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(target)
    else {
      const info = await fs.stat(target).catch(() => null)
      total += info?.size ?? 0
    }
  }
  return total
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 解析一个包及其全部运行时依赖，返回需要复制的 node_modules 子路径集合。
async function resolveDependencyClosure(roots) {
  const reached = new Set()
  const queue = [...roots]
  while (queue.length) {
    const name = queue.shift()
    if (!name || reached.has(name)) continue
    reached.add(name)
    const manifestPath = path.join(repoRoot, 'node_modules', name, 'package.json')
    const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null)
    if (!raw) continue
    let manifest
    try {
      manifest = JSON.parse(raw)
    } catch {
      continue
    }
    const deps = [
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.optionalDependencies || {}),
    ]
    for (const dep of deps) queue.push(dep)
  }
  return reached
}

async function main() {
  const reportOnly = process.argv.includes('--report')

  if (!(await exists(path.join(repoRoot, 'dist', 'index.html')))) {
    console.error('[runtime] 缺少 dist/，请先运行 `bun run build`')
    process.exitCode = 1
    return
  }

  log('解析运行时依赖闭包…')
  const closure = await resolveDependencyClosure(RUNTIME_PACKAGES)
  log(`需要 ${closure.size} 个包：${[...closure].sort().join(', ')}`)

  if (reportOnly) return

  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  for (const name of COPY_DIRS) {
    if (!(await exists(path.join(repoRoot, name)))) continue
    const skip = COPY_SKIP.includes(name) ? ['data'] : []
    log(`  跳过: ${skip.join(',') || '无'}`)
    await copyDirectory(path.join(repoRoot, name), path.join(outDir, name), { skip })
    log(`复制 ${name}/`)
  }
  for (const name of COPY_FILES) {
    if (!(await exists(path.join(repoRoot, name)))) continue
    await fs.copyFile(path.join(repoRoot, name), path.join(outDir, name))
  }
  await copyDirectory(path.join(repoRoot, 'dist'), path.join(outDir, 'dist'), {
    // og 图片只用于社交分享预览卡片，桌面应用里看不到。
    skip: ['og.png', 'og-ide.png'],
  })

  // 精简 package.json：去掉 devDependencies 与 scripts，避免 Electron/Tauri 误判。
  const rootManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const runtimeManifest = {
    name: rootManifest.name,
    version: rootManifest.version,
    private: true,
    type: rootManifest.type,
    dependencies: Object.fromEntries(
      RUNTIME_PACKAGES.map((name) => [name, rootManifest.dependencies?.[name] || 'latest']),
    ),
  }
  await fs.writeFile(path.join(outDir, 'package.json'), JSON.stringify(runtimeManifest, null, 2), 'utf8')

  // 拷贝依赖：保留原有目录层级（@scope/name 与 scoped 嵌套依赖）。
  for (const name of closure) {
    const source = path.join(repoRoot, 'node_modules', name)
    if (!(await exists(source))) continue
    const target = path.join(outDir, 'node_modules', name)
    await copyDirectory(source, target)
  }
  // 工作区包按 @yemu/<name> 布局放置。
  for (const workspace of RUNTIME_WORKSPACES) {
    const packageName = workspace.split('/').at(-1)
    const source = path.join(repoRoot, workspace)
    if (!(await exists(source))) continue
    const target = path.join(outDir, 'node_modules', '@yemu', packageName)
    await copyDirectory(source, target, { skip: ['node_modules', 'test', 'dist'] })
    log(`复制 ${workspace} → node_modules/@yemu/${packageName}`)
  }

  // 校验 tauri.conf.json 里声明的每个资源都实际存在。
  // 曾经因为 bundle.resources 还留着已删除的 public/ 导致 Windows 构建失败。
  const tauriConfigPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json')
  const tauriConfigRaw = await fs.readFile(tauriConfigPath, 'utf8').catch(() => null)
  if (tauriConfigRaw) {
    const resources = JSON.parse(tauriConfigRaw)?.bundle?.resources || []
    const missing = []
    for (const entry of resources) {
      const resolved = path.resolve(path.join(repoRoot, 'src-tauri'), entry)
      if (!(await exists(resolved))) missing.push(entry)
    }
    if (missing.length) {
      console.error('[runtime] tauri.conf.json 引用了不存在的资源：')
      for (const entry of missing) console.error(`  ${entry}`)
      process.exitCode = 1
      return
    }
    log(`tauri.conf.json 资源校验通过（${resources.length} 项）`)
  }

  const total = await directorySize(outDir)
  log(`完成：${outDir}（${formatSize(total)}）`)
}

await main()
