/**
 * 扫描器 —— 把「一个插件目录」读成规则引擎能吃的证据。
 *
 * 只读、不执行、不装依赖：判据全部来自 package.json 与源码文本。
 * 有一条硬限制：**永不 follow 到插件目录外面**。用户可能把 .node 放到别处再软链进来，
 * 那属于「打算绕过检查」，我们只如实报出来，不替它猜内容。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

/** 完全不进的目录：装了别人的代码或纯垃圾。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'tmp', '.venv', '__pycache__'])

/**
 * 产物目录：**必须进去看文件名**（.node 二进制通常就躺在 build/Release 里），
 * 但里面的内容不当源码读 —— 那是打包出来的 bundle，读了没意义还慢。
 */
const ARTIFACT_DIRS = new Set(['build', 'dist', 'out', 'coverage', '.next', 'vendor', '.github'])

/** 当源码看待的扩展名。 */
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'])

/** 找二进制产物时看这些扩展名。 */
const BINARY_EXT = /\.(node|so|dylib|dll|a|wasm)$/i

/** 单个文件最多读这么多字节（插件里偶尔有巨大的 bundle，读全文没意义）。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** 最多扫这么多文件（防止误指向一个巨型仓库时卡死）。 */
const MAX_FILES = 2000

/** 忽略文件的名字。 */
export const IGNORE_FILE = '.portabilityignore'

/**
 * 解析忽略模式。只有三种形态，够用且不会让人猜：
 *   - `tests/`        以 / 结尾 = 目录前缀
 *   - `lib/rules.js`  普通路径 = 精确匹配这个文件
 *   - `*.min.js`      含 * = 按通配符匹配路径尾段
 * 空行与 # 开头的行忽略。
 * @param {string} text
 */
export function parseIgnorePatterns(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * 判断一个相对路径是否被忽略。
 * @param {string} path
 * @param {string[]} patterns
 */
export function isIgnored(path, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1)
      return path === dir || path.startsWith(`${dir}/`)
    }
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
      return regex.test(path) || regex.test(path.split('/').pop() ?? '')
    }
    return path === pattern
  })
}

/** 转义正则里的特殊字符。 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 读忽略清单：`.portabilityignore` + package.json 里的 dsh.androidPortability.ignore。
 * @param {string} root
 * @param {Record<string, any>} [pkg]
 */
export function readIgnorePatterns(root, pkg) {
  const patterns = []
  const ignorePath = join(root, IGNORE_FILE)
  if (existsSync(ignorePath)) {
    try {
      patterns.push(...parseIgnorePatterns(readFileSync(ignorePath, 'utf8')))
    } catch {
      // 读不了就当没有
    }
  }
  const fromManifest = pkg?.dsh?.androidPortability?.ignore
  if (Array.isArray(fromManifest)) patterns.push(...fromManifest.map((item) => String(item).trim()).filter(Boolean))
  return patterns
}

/**
 * 把目录展开成文件列表（相对路径 + 大小），不 follow 出根目录。
 * @param {string} root
 * @param {{ maxFiles?: number }} [options]
 */
export function listFiles(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const ignore = Array.isArray(options.ignore) ? options.ignore : []
  const files = []
  const skipped = []

  /** 被 .portabilityignore 排除的路径 —— 单独记，报告里能解释「为什么没看这个文件」。 */
  const isSkipped = (rel, isDir) => isIgnored(isDir ? `${rel}/` : rel, ignore)

  const walk = (dir, inArtifact) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: relative(root, dir).split('\\').join('/') || '.', reason: error?.code || 'unreadable' })
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute).split('\\').join('/')
      if (entry.isSymbolicLink()) {
        // 不跟软链：软链到容器外是「绕过检查」的常见手法，如实标注即可
        let target = null
        try {
          target = statSync(absolute).isFile() ? 'file' : 'dir'
        } catch {
          target = null
        }
        skipped.push({ path: rel, reason: target ? `symlink→${target}` : 'symlink→missing' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) {
          skipped.push({ path: rel, reason: 'skipped-dir' })
          continue
        }
        if (isSkipped(rel, true)) {
          skipped.push({ path: rel, reason: 'ignored' })
          continue
        }
        walk(absolute, inArtifact || ARTIFACT_DIRS.has(entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (isSkipped(rel, false)) {
        skipped.push({ path: rel, reason: 'ignored' })
        continue
      }
      let size = 0
      try {
        size = statSync(absolute).size
      } catch {
        size = 0
      }
      files.push({ path: rel, absolute, size, ext: extname(entry.name).toLowerCase(), artifact: inArtifact })
    }
  }

  walk(root, false)
  return { files, skipped, truncated: files.length >= maxFiles }
}

/**
 * 读 package.json；读不到就返回 null（调用方按「不是插件包」处理）。
 * @param {string} root
 */
export function readManifest(root) {
  const path = join(root, 'package.json')
  if (!existsSync(path)) return { path, pkg: null, error: 'MISSING' }
  try {
    return { path, pkg: JSON.parse(readFileSync(path, 'utf8')), error: null }
  } catch (error) {
    return { path, pkg: null, error: `INVALID_JSON: ${error.message}` }
  }
}

/**
 * 收集规则引擎需要的「事实」：binding.gyp、二进制文件、源码文本。
 * @param {string} root
 * @param {{ files: Array<{path:string,absolute:string,size:number,ext:string}> }} listing
 */
export function collectFacts(root, listing) {
  const facts = {
    hasBindingGyp: false,
    binaryFiles: [],
    sources: [],
    skippedLarge: [],
  }

  for (const file of listing.files) {
    if (file.path === 'binding.gyp' || file.path.endsWith('/binding.gyp')) facts.hasBindingGyp = true
    if (BINARY_EXT.test(file.path)) facts.binaryFiles.push(file.path)
    if (!SOURCE_EXT.has(file.ext)) continue
    // 产物目录里的 JS 是打包出来的 bundle：读它只会得到一堆 200KB 的噪音
    if (file.artifact) continue
    if (file.size > MAX_FILE_BYTES) {
      facts.skippedLarge.push({ path: file.path, size: file.size })
      continue
    }
    try {
      facts.sources.push({ path: file.path, text: readFileSync(file.absolute, 'utf8') })
    } catch (error) {
      facts.skippedLarge.push({ path: file.path, size: file.size, reason: error?.code })
    }
  }

  return facts
}

/**
 * 扫一个插件目录。
 * @param {string} input 目录或 package.json 的路径
 * @param {{ maxFiles?: number }} [options]
 */
export function scanDirectory(input, options = {}) {
  const absolute = resolve(input)
  let root = absolute
  if (existsSync(absolute) && statSync(absolute).isFile()) root = dirname(absolute)

  if (!existsSync(root)) {
    return { root, ok: false, error: `NOT_FOUND: ${root}` }
  }
  if (!statSync(root).isDirectory()) {
    return { root, ok: false, error: `NOT_DIRECTORY: ${root}` }
  }

  const manifest = readManifest(root)
  if (!manifest.pkg) {
    return { root, ok: false, error: `NOT_A_PLUGIN: ${manifest.error}`, manifestPath: manifest.path }
  }

  const ignore = readIgnorePatterns(root, manifest.pkg)
  const listing = listFiles(root, { ...options, ignore })
  const facts = collectFacts(root, listing)
  return { root, ok: true, pkg: manifest.pkg, manifestPath: manifest.path, ignore, listing, facts }
}

/** 判断两个路径的关系（给报告里「相对路径怎么写」用）。 */
export function displayPath(root, path) {
  if (!path) return ''
  const rel = isAbsolute(path) ? relative(root, path) : path
  return rel.split('\\').join('/')
}
