/**
 * 插件入口：把「扫一个插件目录」变成 agent 能直接用的工具。
 *
 * 两个工具就够：
 *   - dsh_check_android_portability：读插件目录，判断能不能在 DSHA 安卓端跑；
 *   - dsh_scan_profile_android：一次扫完整个 profile，按严重程度排队。
 *
 * 故意不提供「自动改代码」——静态体检给的是证据，下判断的是人。
 * @module dsh-android-portability
 */

import { evaluateManifest, evaluateSource, sortFindings, verdictOf, BLOCK } from './rules.js'
import { scanDirectory } from './scan.js'
import { formatCompact } from './report.js'

export const name = 'dsh-android-portability'

/** 只依赖工具面。 */
export const inject = ['tools']

export const Config = {
  maxFiles: { type: 'number', default: 2000, description: '单次扫描最多读多少个文件' },
  includeDev: { type: 'boolean', default: false, description: '扫描 profile 时是否也看 devDependencies' },
}

/** 扫描结果 → 给模型的返回值（也是 output.schema 的形状）。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: ['string', 'null'] },
    version: { type: ['string', 'null'] },
    root: { type: 'string' },
    verdict: { type: 'string', enum: ['unusable', 'risky', 'ok'] },
    counts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        block: { type: 'number' },
        warn: { type: 'number' },
        info: { type: 'number' },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ruleId: { type: 'string' },
          severity: { type: 'string', enum: ['block', 'warn', 'info'] },
          file: { type: ['string', 'null'] },
          line: { type: ['number', 'null'] },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['ruleId', 'severity', 'problem', 'fix'],
      },
    },
    error: { type: ['string', 'null'] },
  },
  required: ['verdict', 'findings'],
}

/** 渲染：结论一行 + 前几条证据（模型不需要看 200 条）。 */
function render(value) {
  if (value.error) return [{ type: 'text', text: `✗ ${value.error}` }]
  return [{ type: 'text', text: formatCompact(value) }]
}

/** 跑一次扫描，把各个来源的 findings 合起来。 */
function scanOne(target, options) {
  const scanned = scanDirectory(target, { maxFiles: options.maxFiles })
  if (!scanned.ok) {
    return {
      name: null,
      version: null,
      root: scanned.root,
      verdict: 'unusable',
      counts: { block: 0, warn: 0, info: 0 },
      findings: [],
      error: `不是可扫描的插件包：${scanned.error}`,
    }
  }

  const findings = [
    ...evaluateManifest(scanned.pkg, scanned.facts),
    ...scanned.facts.sources.flatMap((source) => evaluateSource(source.path, source.text)),
  ]

  const sorted = sortFindings(findings)
  return {
    name: scanned.pkg.name ?? null,
    version: scanned.pkg.version ?? null,
    root: scanned.root,
    verdict: verdictOf(sorted),
    counts: {
      block: sorted.filter((item) => item.severity === BLOCK).length,
      warn: sorted.filter((item) => item.severity === 'warn').length,
      info: sorted.filter((item) => item.severity === 'info').length,
    },
    findings: sorted,
    error: null,
    stats: {
      files: scanned.listing.files.length,
      sources: scanned.facts.sources.length,
      skipped: scanned.listing.skipped.length,
      truncated: scanned.listing.truncated,
    },
  }
}

/**
 * 包住 execute：任何异常都变成结构化结果，别把 stack 丢给模型。
 * @param {Function} executor
 */
function guard(executor) {
  return async (args, exec) => {
    try {
      return await executor(args, exec)
    } catch (error) {
      return {
        name: null,
        version: null,
        root: String(args?.path ?? ''),
        verdict: 'unusable',
        counts: { block: 0, warn: 0, info: 0 },
        findings: [],
        error: `${error?.code || 'SCAN_FAILED'}: ${error?.message || error}`,
      }
    }
  }
}

/** 构建工具表。 */
export function buildTools(options = {}) {
  const maxFiles = options.maxFiles ?? 2000
  return [
    {
      name: 'dsh_check_android_portability',
      description:
        '静态检查一个 DSH 插件能不能在 DSHA 安卓端（Linux arm64 + glibc，proot 容器）里跑起来。' +
        '只读不改：读 package.json 与源码文本，找出 Windows 绝对路径、Windows 形态的环境变量、只认 x64 的下载逻辑、' +
        '需要编译的原生依赖、包里带的 .node 二进制、写死的 /bin/bash 等等。' +
        '每条问题给 文件:行 + 原文片段 + 改法。当你把一个插件准备好要发到 GitHub 给人装到手机上时用这个。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '插件目录（或它里面的 package.json）的路径' },
          verbose: { type: 'boolean', description: '是否返回全部问题（默认只回前 20 条）' },
        },
        required: ['path'],
      },
      output: { schema: RESULT_SCHEMA, render },
      isConcurrencySafe: true,
      execute: guard(async (args) => scanOne(args.path, { maxFiles })),
    },
    {
      name: 'dsh_scan_profile_android',
      description:
        '一次扫完整个 DSH profile 里装的插件，列出哪些在 DSHA 安卓端会跑不起来。' +
        '适合「我这台手机上装了三十个插件，哪个是坏的」这种问题。按严重程度排序返回。',
      parameters: {
        type: 'object',
        properties: {
          profilePath: { type: 'string', description: 'profile 目录（含 node_modules），默认读 DSHA 的 /root/.dsh/profiles' },
          limit: { type: 'number', description: '最多检查多少个包（默认 40）' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scannedRoot: { type: 'string' },
            total: { type: 'number' },
            unusable: { type: 'array', items: { type: 'object' } },
            risky: { type: 'array', items: { type: 'object' } },
            error: { type: ['string', 'null'] },
          },
          required: ['unusable', 'risky'],
        },
        render: (value) => {
          if (value.error) return [{ type: 'text', text: `✗ ${value.error}` }]
          const lines = [`扫了 ${value.total} 个包（${value.scannedRoot}）`]
          if (value.unusable.length === 0 && value.risky.length === 0) {
            lines.push('全部能在安卓上跑。')
          }
          for (const item of value.unusable) {
            lines.push(`✗ ${item.name}@${item.version} —— ${item.top.join('；')}`)
          }
          for (const item of value.risky) {
            lines.push(`! ${item.name}@${item.version} —— ${item.top.join('；')}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      isConcurrencySafe: true,
      execute: guard(async (args) => scanProfile(args, options)),
    },
  ]
}

/** 扫描一个 profile 下的所有包。 */
export async function scanProfile(args = {}, options = {}) {
  const { readdirSync, statSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')

  const candidates = args.profilePath
    ? [args.profilePath]
    : ['/root/.dsh/profiles/web/node_modules', '/root/.dsh/profiles/desktop/node_modules']

  const scannedRoot = candidates.find((path) => existsSync(path))
  if (!scannedRoot) {
    return {
      scannedRoot: candidates.join('、'),
      total: 0,
      unusable: [],
      risky: [],
      error: '找不到 profile 的 node_modules。请显式传 profilePath。',
    }
  }

  const limit = args.limit ?? 40
  const names = readdirSync(scannedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    // @scope 目录
    .flatMap((entry) => {
      if (!entry.startsWith('@')) return [entry]
      try {
        return readdirSync(join(scannedRoot, entry), { withFileTypes: true })
          .filter((inner) => inner.isDirectory())
          .map((inner) => `${entry}/${inner.name}`)
      } catch {
        return []
      }
    })
    .slice(0, limit)

  const unusable = []
  const risky = []
  for (const pkgName of names) {
    const dir = join(scannedRoot, pkgName)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const result = scanOne(dir, { maxFiles: options.maxFiles ?? 500 })
    if (result.error) continue
    const top = result.findings
      .filter((item) => item.severity === BLOCK || item.severity === 'warn')
      .slice(0, 3)
      .map((item) => `[${item.ruleId}] ${item.problem}`)
    if (result.verdict === 'unusable') unusable.push({ name: result.name, version: result.version, top })
    else if (result.verdict === 'risky') risky.push({ name: result.name, version: result.version, top })
  }

  return { scannedRoot, total: names.length, unusable, risky, error: null }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const options = {
    maxFiles: Number(rawConfig.maxFiles) > 0 ? Number(rawConfig.maxFiles) : 2000,
    includeDev: rawConfig.includeDev === true || rawConfig.includeDev === 'true',
  }
  for (const tool of buildTools(options)) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-android-portability: ${tool.name}`)
  }
}
