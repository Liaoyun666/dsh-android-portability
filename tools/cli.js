#!/usr/bin/env node
/**
 * 命令行：`dsh-android-portability <插件目录>`。
 *
 * 给两种人用：CI 里跑（--json / --github），和本地手上扫一下（默认彩色报告）。
 * 退出码只表达一件事：有没有「一定跑不起来」的问题（--strict 时把警告也算上）。
 */

import { BLOCK, RULES, evaluateManifest, evaluateSource, sortFindings, verdictOf } from '../lib/rules.js'
import { formatGithubActions, formatHuman, formatJson, useColor } from '../lib/report.js'
import { scanDirectory } from '../lib/scan.js'

const USAGE = `用法: dsh-android-portability <插件目录|package.json> [选项]

选项:
  --json         输出 JSON（给 CI / 脚本）
  --github       输出 GitHub Actions 注解
  --verbose      每组显示全部命中位置（默认每组 3 处）
  --strict       有警告也返回非零（默认只有阻断才非零）
  --no-color     不用颜色
  --list-rules   打印规则表
  -h, --help     显示这段帮助

退出码: 0 可以装, 1 有问题, 2 用法错误
`

/** 解析参数（不引第三方包）。 */
export function parseArgs(argv) {
  const options = { target: null, json: false, github: false, verbose: false, strict: false, color: undefined, listRules: false, help: false }
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--github') options.github = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--no-color') options.color = false
    else if (arg === '--list-rules') options.listRules = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg.startsWith('-')) throw new Error(`未知选项: ${arg}`)
    else if (!options.target) options.target = arg
    else throw new Error(`多余的参数: ${arg}`)
  }
  return options
}

/** 扫一个目录并算判定。 */
export function runScan(target, options = {}) {
  const scanned = scanDirectory(target, { maxFiles: options.maxFiles })
  if (!scanned.ok) return { ...scanned, findings: [], stats: null }
  const findings = sortFindings([
    ...evaluateManifest(scanned.pkg, scanned.facts),
    ...scanned.facts.sources.flatMap((source) => evaluateSource(source.path, source.text)),
  ])
  return {
    ...scanned,
    findings,
    stats: {
      files: scanned.listing.files.length,
      sources: scanned.facts.sources.length,
      skipped: scanned.listing.skipped.length,
      truncated: scanned.listing.truncated,
    },
  }
}

/** 打印规则表。 */
function printRules() {
  console.log('规则表：\n')
  for (const rule of RULES) {
    console.log(`  ${rule.id}  ${rule.severity.padEnd(5)}  [${rule.scope}] ${rule.title}`)
  }
  console.log('\n  D = 清单与依赖，S = 源码')
}

/** 入口。 */
export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.error(`✗ ${error.message}\n\n${USAGE}`)
    return 2
  }

  if (options.help) {
    io.log(USAGE)
    return 0
  }
  if (options.listRules) {
    printRules()
    return 0
  }
  if (!options.target) {
    io.error(`✗ 需要一个插件目录\n\n${USAGE}`)
    return 2
  }

  const result = runScan(options.target, options)
  if (!result.ok) {
    if (options.json) io.log(JSON.stringify({ error: result.error, root: result.root }, null, 2))
    else io.error(`✗ ${result.error}`)
    return 1
  }

  const verdict = verdictOf(result.findings)
  if (options.json) {
    io.log(formatJson(result))
  } else if (options.github) {
    const annotations = formatGithubActions(result)
    if (annotations) io.log(annotations)
    io.log(`${result.pkg.name}@${result.pkg.version} → ${verdict}`)
  } else {
    io.log(formatHuman(result, { color: options.color ?? useColor(), verbose: options.verbose }))
  }

  const blocking = result.findings.filter((item) => item.severity === BLOCK).length
  const warning = result.findings.filter((item) => item.severity === 'warn').length
  if (blocking > 0) return 1
  if (options.strict && warning > 0) return 1
  return 0
}

// 只有被直接执行时才跑（被 import 时不跑）
const invokedDirectly = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exitCode = main()
}
