/**
 * 报告渲染 —— 同一份结论，三种出口：
 *   1. 给人看的彩色终端报告（CLI 默认）；
 *   2. 给机器看的 JSON（CI、脚本）；
 *   3. 给模型看的紧凑文本（插件工具的输出）。
 *
 * 分开做是因为「好看」和「好解析」是矛盾需求：CI 不该去正则匹配 emoji，
 * 而人也不该读一大坨 JSON。
 */

import { BLOCK, INFO, WARN, RULES, sortFindings, verdictOf } from './rules.js'

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
}

/** 是否输出颜色（NO_COLOR / 非 TTY / --json 时关闭）。 */
export function useColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(stream?.isTTY)
}

/** 上色。 */
function paint(text, color, enabled) {
  if (!enabled) return text
  return `${ANSI[color]}${text}${ANSI.reset}`
}

const SEVERITY_LABEL = {
  [BLOCK]: '阻断',
  [WARN]: '警告',
  [INFO]: '提示',
}

const SEVERITY_COLOR = {
  [BLOCK]: 'red',
  [WARN]: 'yellow',
  [INFO]: 'cyan',
}

const VERDICT_TEXT = {
  unusable: '装到安卓上跑不起来',
  risky: '能跑，但有几处大概会出问题',
  ok: '没有发现安卓障碍',
}

const VERDICT_COLOR = {
  unusable: 'red',
  risky: 'yellow',
  ok: 'green',
}

/**
 * 终端报告。
 * @param {{ root: string, pkg: object, findings: Array<object>, stats?: object }} result
 * @param {{ color?: boolean, verbose?: boolean }} [options]
 */
export function formatHuman(result, options = {}) {
  const color = options.color ?? useColor()
  const findings = sortFindings(result.findings)
  const verdict = verdictOf(findings)
  const lines = []

  const name = result.pkg?.name ?? '(未命名)'
  const version = result.pkg?.version ?? '?'
  lines.push('')
  lines.push(paint(`  ${name}@${version}`, 'bold', color) + paint(`  ${result.root}`, 'gray', color))
  lines.push('')
  lines.push(`  ${paint('结论', 'bold', color)}  ${paint(VERDICT_TEXT[verdict], VERDICT_COLOR[verdict], color)}`)

  const counts = { [BLOCK]: 0, [WARN]: 0, [INFO]: 0 }
  for (const item of findings) counts[item.severity] += 1
  const badge = []
  if (counts[BLOCK]) badge.push(paint(`${counts[BLOCK]} 阻断`, 'red', color))
  if (counts[WARN]) badge.push(paint(`${counts[WARN]} 警告`, 'yellow', color))
  if (counts[INFO]) badge.push(paint(`${counts[INFO]} 提示`, 'cyan', color))
  if (badge.length === 0) badge.push(paint('0 问题', 'green', color))
  lines.push(`  ${badge.join(paint(' · ', 'gray', color))}`)
  lines.push('')

  if (findings.length === 0) {
    lines.push(paint('  没有命中任何安卓可移植性规则。可以直接装。', 'green', color))
    lines.push('')
    return lines.join('\n')
  }

  // 按规则分组：同一个规则命中很多文件时，人想看「哪条规则、几处」，而不是 200 行明细
  const groups = new Map()
  for (const item of findings) {
    if (!groups.has(item.ruleId)) groups.set(item.ruleId, [])
    groups.get(item.ruleId).push(item)
  }

  for (const [ruleId, items] of groups) {
    const severity = items[0].severity
    const rule = RULES.find((entry) => entry.id === ruleId)
    const title = rule?.title ?? items[0].problem
    lines.push(
      `  ${paint(SEVERITY_LABEL[severity], SEVERITY_COLOR[severity], color)} ${paint(ruleId, 'bold', color)}  ${title}` +
        paint(`  ×${items.length}`, 'gray', color),
    )
    const shown = options.verbose ? items : items.slice(0, 3)
    for (const item of shown) {
      const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : '(清单)'
      lines.push(`      ${paint(where, 'gray', color)}  ${item.problem}`)
      if (item.excerpt) lines.push(`        ${paint(`| ${item.excerpt}`, 'dim', color)}`)
    }
    if (items.length > shown.length) {
      lines.push(paint(`      …还有 ${items.length - shown.length} 处（--verbose 看全部）`, 'gray', color))
    }
    lines.push(`      ${paint('→', 'green', color)} ${items[0].fix}`)
    lines.push('')
  }

  return lines.join('\n')
}

/** JSON 报告（稳定结构，供 CI 消费）。 */
export function formatJson(result) {
  const findings = sortFindings(result.findings)
  return JSON.stringify(
    {
      schemaVersion: 1,
      target: {
        name: result.pkg?.name ?? null,
        version: result.pkg?.version ?? null,
        root: result.root,
      },
      verdict: verdictOf(findings),
      counts: {
        block: findings.filter((item) => item.severity === BLOCK).length,
        warn: findings.filter((item) => item.severity === WARN).length,
        info: findings.filter((item) => item.severity === INFO).length,
      },
      findings: findings.map((item) => ({
        ruleId: item.ruleId,
        severity: item.severity,
        file: item.file ?? null,
        line: item.line ?? null,
        problem: item.problem,
        excerpt: item.excerpt ?? null,
        fix: item.fix,
      })),
      scanned: result.stats ?? null,
    },
    null,
    2,
  )
}

/** 给模型看的紧凑文本（工具输出）：首行结论 + 每条一行。 */
export function formatCompact(result) {
  const findings = sortFindings(result.findings)
  const verdict = verdictOf(findings)
  const head = `${result.pkg?.name ?? '(未命名)'}@${result.pkg?.version ?? '?'} → ${VERDICT_TEXT[verdict]}（${findings.length} 个问题）`
  if (findings.length === 0) return head
  const body = findings.slice(0, 20).map((item) => {
    const where = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}` : 'package.json'
    return `${item.severity === BLOCK ? '✗' : item.severity === WARN ? '!' : '·'} [${item.ruleId}] ${where} — ${item.problem}\n    → ${item.fix}`
  })
  const more = findings.length > 20 ? `\n…另有 ${findings.length - 20} 个问题` : ''
  return `${head}\n${body.join('\n')}${more}`
}

/** GitHub Actions 注解（CI 里直接标在 diff 上）。 */
export function formatGithubActions(result) {
  const lines = []
  for (const item of sortFindings(result.findings)) {
    if (item.severity === INFO) continue
    const level = item.severity === BLOCK ? 'error' : 'warning'
    const file = item.file ? ` file=${item.file}` : ''
    const line = item.file ? `,line=${item.line ?? 1}` : ''
    const title = `[${item.ruleId}] 安卓可移植性`
    const message = `${item.problem} —— ${item.fix}`
    lines.push(`::${level}${file}${line},title=${title}::${message}`)
  }
  return lines.join('\n')
}
