/**
 * 报告与工具入口的测试。
 *
 * 这里测的是「模型看到什么」与「人看到什么」：结论必须一句话讲清，
 * JSON 必须能被 CI 直接消费，工具必须永远返回结构化结果而不是抛异常。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, buildTools, scanProfile } from '../lib/index.js'
import { formatCompact, formatGithubActions, formatJson, formatHuman } from '../lib/report.js'

/** 一份有代表性的扫描结果。 */
const sample = {
  root: 'E:/demo',
  pkg: { name: 'demo-plugin', version: '1.0.0' },
  findings: [
    {
      ruleId: 'S1',
      severity: 'block',
      file: 'lib/a.js',
      line: 12,
      problem: '写死了 Windows 绝对路径',
      excerpt: "const p = 'C:\\\\x'",
      fix: '改用 path.join',
    },
    { ruleId: 'S5', severity: 'warn', file: 'lib/b.js', line: 3, problem: '只处理 win32', fix: '改成 win32/其他 两路' },
    { ruleId: 'S9', severity: 'info', file: 'lib/c.js', problem: '调用外部程序', fix: '确认 PATH' },
  ],
  stats: { files: 10, sources: 6, skipped: 1, truncated: false },
}

test('formatHuman 同时给出结论、计数、证据与改法', () => {
  const text = formatHuman(sample, { color: false })
  assert.match(text, /demo-plugin@1\.0\.0/)
  assert.match(text, /装到安卓上跑不起来/)
  assert.match(text, /1 阻断/)
  assert.match(text, /lib\/a\.js:12/)
  assert.match(text, /改用 path\.join/)
})

test('formatHuman 干净结果直接说可以装', () => {
  const text = formatHuman({ root: 'E:/x', pkg: { name: 'ok', version: '1.0.0' }, findings: [] }, { color: false })
  assert.match(text, /没有命中任何安卓可移植性规则/)
})

test('formatHuman 默认每组只显示 3 处，verbose 显示全部', () => {
  const many = {
    root: 'E:/x',
    pkg: { name: 'many', version: '1.0.0' },
    findings: Array.from({ length: 6 }, (_, index) => ({
      ruleId: 'S1',
      severity: 'block',
      file: `lib/f${index}.js`,
      line: index + 1,
      problem: 'Windows 路径',
      fix: '改掉',
    })),
  }
  const brief = formatHuman(many, { color: false })
  assert.match(brief, /还有 3 处/)
  const full = formatHuman(many, { color: false, verbose: true })
  assert.ok(!/还有 3 处/.test(full))
  assert.match(full, /lib\/f5\.js/)
})

test('formatJson 结构稳定：schemaVersion / verdict / counts / findings', () => {
  const parsed = JSON.parse(formatJson(sample))
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.verdict, 'unusable')
  assert.deepEqual(parsed.counts, { block: 1, warn: 1, info: 1 })
  assert.equal(parsed.findings[0].ruleId, 'S1')
  assert.equal(parsed.findings[0].line, 12)
  assert.equal(parsed.target.name, 'demo-plugin')
  assert.equal(parsed.scanned.files, 10)
})

test('formatCompact 首行就是结论，info 用 · 标记', () => {
  const text = formatCompact(sample)
  const first = text.split('\n')[0]
  assert.match(first, /demo-plugin@1\.0\.0 → 装到安卓上跑不起来/)
  assert.match(text, /✗ \[S1\] lib\/a\.js:12/)
  assert.match(text, /! \[S5\]/)
  assert.match(text, /· \[S9\]/)
})

test('formatCompact 超过 20 条时给出「另有 N 个」', () => {
  const many = {
    ...sample,
    findings: Array.from({ length: 25 }, (_, index) => ({
      ruleId: 'S1',
      severity: 'block',
      file: `f${index}.js`,
      line: 1,
      problem: 'x',
      fix: 'y',
    })),
  }
  assert.match(formatCompact(many), /另有 5 个问题/)
})

test('formatGithubActions 跳过 info，block 用 error', () => {
  const text = formatGithubActions(sample)
  const lines = text.split('\n')
  assert.equal(lines.length, 2, 'info 不该出现在注解里')
  assert.match(lines[0], /^::error file=lib\/a\.js,line=12,title=\[S1\]/)
  assert.match(lines[1], /^::warning file=lib\/b\.js,line=3/)
})

test('buildTools 返回两个工具，名字与描述都在', () => {
  const tools = buildTools()
  assert.equal(tools.length, 2)
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['dsh_check_android_portability', 'dsh_scan_profile_android'],
  )
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} 的描述太短`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('execute 对坏路径返回结构化错误，不抛异常', async () => {
  const [tool] = buildTools()
  const value = await tool.execute({ path: 'E:/definitely/not/here' }, {})
  assert.equal(value.verdict, 'unusable')
  assert.match(value.error, /不是可扫描的插件包/)
})

test('execute 对空参数也不炸', async () => {
  const [tool] = buildTools()
  const value = await tool.execute({}, {})
  assert.equal(typeof value.verdict, 'string')
})

test('execute 扫一个干净的临时插件时返回 ok', async () => {
  const clean = mkdtempSync(join(tmpdir(), 'dsh-clean-'))
  writeFileSync(
    join(clean, 'package.json'),
    JSON.stringify({ name: 'clean-fixture', version: '1.0.0', main: 'index.js', files: ['index.js'] }),
  )
  writeFileSync(join(clean, 'index.js'), "import { join } from 'node:path'\nexport const name = 'clean-fixture'\n")
  const [tool] = buildTools()
  const value = await tool.execute({ path: clean }, {})
  rmSync(clean, { recursive: true, force: true })
  assert.equal(value.verdict, 'ok')
  assert.equal(value.counts.block, 0)
  assert.ok(Array.isArray(value.findings))
})

test('scanProfile 在找不到 profile 时给出可读错误', async () => {
  const result = await scanProfile({ profilePath: '/definitely/missing/node_modules' })
  assert.match(result.error, /找不到 profile/)
})

test('apply 注册两个工具（用假 ctx 验证）', () => {
  const registered = []
  const ctx = {
    tools: { register: (tool) => registered.push(tool.name) },
    effect: (fn) => fn(),
  }
  apply(ctx, {})
  assert.deepEqual(registered, ['dsh_check_android_portability', 'dsh_scan_profile_android'])
})
