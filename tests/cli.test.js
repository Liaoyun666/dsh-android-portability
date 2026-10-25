/**
 * CLI 测试 —— 真起子进程跑，验证退出码与三种输出格式。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

import { parseArgs } from '../tools/cli.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'tools', 'cli.js')

let bad = ''
let good = ''

/** 起一次 CLI，返回 { code, stdout, stderr }。 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

before(() => {
  bad = mkdtempSync(join(tmpdir(), 'dsh-cli-bad-'))
  writeFileSync(
    join(bad, 'package.json'),
    JSON.stringify({ name: 'bad-plugin', version: '0.1.0', main: 'index.js', dependencies: { sharp: '^0.33.0' } }),
  )
  writeFileSync(join(bad, 'index.js'), "const p = 'D:\\\\work\\\\data'\n")

  good = mkdtempSync(join(tmpdir(), 'dsh-cli-good-'))
  writeFileSync(join(good, 'package.json'), JSON.stringify({ name: 'good-plugin', version: '0.1.0', main: 'index.js' }))
  writeFileSync(join(good, 'index.js'), "import { join } from 'node:path'\nexport const x = join('a', 'b')\n")
})

after(() => {
  rmSync(bad, { recursive: true, force: true })
  rmSync(good, { recursive: true, force: true })
})

test('parseArgs 认得所有选项', () => {
  const options = parseArgs(['pkg', '--json', '--verbose', '--strict', '--no-color'])
  assert.equal(options.target, 'pkg')
  assert.equal(options.json, true)
  assert.equal(options.verbose, true)
  assert.equal(options.strict, true)
  assert.equal(options.color, false)
})

test('parseArgs 对未知选项与多余参数报错', () => {
  assert.throws(() => parseArgs(['--nope']), /未知选项/)
  assert.throws(() => parseArgs(['a', 'b']), /多余的参数/)
})

test('有问题时退出码为 1，报告里有规则号与文件位置', () => {
  const result = runCli([bad, '--no-color'])
  assert.equal(result.code, 1)
  assert.match(result.stdout, /bad-plugin@0\.1\.0/)
  assert.match(result.stdout, /装到安卓上跑不起来/)
  assert.match(result.stdout, /D1/)
  assert.match(result.stdout, /S1/)
  assert.match(result.stdout, /index\.js:1/)
})

test('干净插件退出码为 0', () => {
  const result = runCli([good, '--no-color'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /没有命中任何安卓可移植性规则/)
})

test('--json 输出可被 JSON.parse，且不含 ANSI 转义', () => {
  const result = runCli([bad, '--json'])
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.verdict, 'unusable')
  assert.ok(parsed.counts.block >= 2)
  assert.ok(!result.stdout.includes('\u001b['), 'JSON 里不该有颜色')
})

test('--github 输出 ::error 注解', () => {
  const result = runCli([bad, '--github'])
  assert.match(result.stdout, /^::error file=index\.js,line=1,title=\[S1\]/m)
})

test('--strict 把警告也算失败', () => {
  const warnOnly = mkdtempSync(join(tmpdir(), 'dsh-cli-warn-'))
  writeFileSync(join(warnOnly, 'package.json'), JSON.stringify({ name: 'warny', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(warnOnly, 'index.js'), "if (process.platform === 'win32') { go() }\n")
  const loose = runCli([warnOnly, '--no-color'])
  const strict = runCli([warnOnly, '--no-color', '--strict'])
  rmSync(warnOnly, { recursive: true, force: true })
  assert.equal(loose.code, 0, '默认只有警告时退出码应为 0')
  assert.equal(strict.code, 1, '--strict 时警告也返回 1')
})

test('--list-rules 打印 17 条规则', () => {
  const result = runCli(['--list-rules'])
  assert.equal(result.code, 0)
  const lines = result.stdout.split('\n').filter((line) => /^\s+[DS]\d/.test(line))
  assert.equal(lines.length, 17)
})

test('--help 给出用法且退出码 0', () => {
  const result = runCli(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /用法: dsh-android-portability/)
})

test('不给目标时退出码 2', () => {
  const result = runCli([])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /需要一个插件目录/)
})

test('路径不存在时退出码 1 且说明原因', () => {
  const result = runCli([join(good, 'nope')])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /NOT_FOUND|不是/)
})
