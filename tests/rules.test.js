/**
 * 规则引擎测试 —— 每条规则都用「最小的坏例子」证明它会响，
 * 再用「改好之后」证明它不响。一条规则如果只会叫不会停，就是噪音。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BLOCK,
  INFO,
  RULES,
  WARN,
  evaluateManifest,
  evaluateSource,
  sortFindings,
  verdictOf,
} from '../lib/rules.js'

/** 取某条规则的第 n 条结果。 */
function rule(findings, id) {
  return findings.filter((item) => item.ruleId === id)
}

test('规则表里 D1–D8 / S1–S9 齐全且都有中文标题', () => {
  const ids = RULES.map((item) => item.id)
  for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9']) {
    assert.ok(ids.includes(id), `缺少规则 ${id}`)
  }
  for (const item of RULES) {
    assert.ok(item.title.length > 2, `${item.id} 没有标题`)
    assert.ok(['block', 'warn', 'info'].includes(item.severity))
  }
})

// ── D 系列：清单与依赖

test('D1 认出 sharp / better-sqlite3 / node-pty 这些原生依赖', () => {
  const findings = evaluateManifest({
    dependencies: { sharp: '^0.33.0', 'better-sqlite3': '^11.0.0', 'node-pty': '^1.0.0' },
  })
  assert.equal(rule(findings, 'D1').length, 3)
  for (const item of rule(findings, 'D1')) {
    assert.equal(item.severity, BLOCK)
    assert.match(item.fix, /纯 JS|bcryptjs|jimp|可选/)
  }
})

test('D1 不误伤纯 JS 的同名功能', () => {
  const findings = evaluateManifest({ dependencies: { bcryptjs: '^2.4.3', jimp: '^0.22.0', sql: '^1.0.0' } })
  assert.equal(rule(findings, 'D1').length, 0)
})

test('D2 平台二进制包缺 linux-arm64 时阻断', () => {
  const bad = evaluateManifest({
    optionalDependencies: {
      '@esbuild/win32-x64': '0.20.0',
      '@esbuild/darwin-arm64': '0.20.0',
      '@esbuild/linux-x64': '0.20.0',
    },
  })
  assert.equal(rule(bad, 'D2').length, 1)
  assert.match(rule(bad, 'D2')[0].fix, /linux-arm64/)
})

test('D2 有 linux-arm64 就不响', () => {
  const ok = evaluateManifest({
    optionalDependencies: { '@esbuild/linux-arm64': '0.20.0', '@esbuild/win32-x64': '0.20.0' },
  })
  assert.equal(rule(ok, 'D2').length, 0)
})

test('D3 命中 postinstall 里跑 node-gyp', () => {
  const findings = evaluateManifest({ scripts: { postinstall: 'node-gyp rebuild --release' } })
  assert.equal(rule(findings, 'D3').length, 1)
  assert.equal(rule(findings, 'D3')[0].severity, BLOCK)
})

test('D3 不管普通的 postinstall（只是 echo）', () => {
  const findings = evaluateManifest({ scripts: { postinstall: 'node -e "console.log(1)"' } })
  assert.equal(rule(findings, 'D3').length, 0)
})

test('D4 binding.gyp 与 .node 产物都阻断，.wasm 只是提示', () => {
  const findings = evaluateManifest(
    {},
    { hasBindingGyp: true, binaryFiles: ['build/Release/addon.node', 'vendor/libfuse.so', 'engine.wasm'] },
  )
  const d4 = rule(findings, 'D4')
  assert.ok(d4.some((item) => item.severity === BLOCK && /binding\.gyp/.test(item.problem)))
  assert.ok(d4.some((item) => item.severity === BLOCK && /\.node/.test(item.problem)))
  assert.ok(d4.some((item) => item.severity === INFO && /wasm/.test(item.problem)))
})

test('D5 os/cpu 字段排掉 linux / arm64 时阻断', () => {
  const both = evaluateManifest({ os: ['win32'], cpu: ['x64'] })
  assert.equal(rule(both, 'D5').length, 2)
  const fine = evaluateManifest({ os: ['win32', 'linux'], cpu: ['x64', 'arm64'] })
  assert.equal(rule(fine, 'D5').length, 0)
})

test('D6 files 白名单漏了 lib 时警告', () => {
  const findings = evaluateManifest({ main: 'lib/index.js', files: ['index.js', 'README.md'] })
  assert.equal(rule(findings, 'D6').length, 1)
  assert.equal(rule(findings, 'D6')[0].severity, WARN)
  const fine = evaluateManifest({ main: 'lib/index.js', files: ['lib', 'README.md'] })
  assert.equal(rule(fine, 'D6').length, 0)
})

test('D7 engines 要求 Node 太高时警告', () => {
  assert.equal(rule(evaluateManifest({ engines: { node: '>=26' } }), 'D7').length, 1)
  assert.equal(rule(evaluateManifest({ engines: { node: '>=20' } }), 'D7').length, 0)
})

test('D8 devDependencies 里的原生模块只是提示', () => {
  const findings = evaluateManifest({ devDependencies: { sharp: '^0.33.0' } })
  assert.equal(rule(findings, 'D8').length, 1)
  assert.equal(rule(findings, 'D8')[0].severity, INFO)
})

// ── S 系列：源码

test('S1 Windows 绝对路径阻断', () => {
  const findings = evaluateSource('lib/index.js', "const dir = 'E:\\\\工作区\\\\data'\nconst ok = 'hello'")
  assert.equal(rule(findings, 'S1').length, 1)
  assert.equal(rule(findings, 'S1')[0].severity, BLOCK)
  assert.equal(rule(findings, 'S1')[0].line, 1)
  assert.match(rule(findings, 'S1')[0].fix, /path\.join|homedir|配置项/)
})

test('S1 不误伤普通的 C: 之后带冒号的文字', () => {
  const findings = evaluateSource('a.js', 'const note = "see http://x.com"')
  assert.equal(rule(findings, 'S1').length, 0)
})

test('S2 %APPDATA% 阻断', () => {
  const findings = evaluateSource('lib/paths.js', "const p = join(process.env['%APPDATA%'], 'dsh')")
  assert.equal(rule(findings, 'S2').length, 1)
  assert.equal(rule(findings, 'S2')[0].severity, BLOCK)
  const findings2 = evaluateSource('lib/paths.js', "const base = '%LOCALAPPDATA%/dsh'")
  assert.equal(rule(findings2, 'S2').length, 1)
})

test('S3 cmd.exe / powershell 阻断', () => {
  const findings = evaluateSource('lib/run.js', "execFileSync('powershell.exe', ['-c', 'x'])")
  assert.equal(rule(findings, 'S3').length, 1)
  assert.equal(rule(findings, 'S3')[0].severity, BLOCK)
})

test('S4 .bat / .ps1 警告', () => {
  const findings = evaluateSource('lib/a.js', "spawn('scripts/build.bat')")
  assert.equal(rule(findings, 'S4').length, 1)
  assert.equal(rule(findings, 'S4')[0].severity, WARN)
})

test('S5 只处理 win32 的分支会给出警告而不是阻断', () => {
  const findings = evaluateSource('lib/x.js', "if (process.platform === 'win32') { doWin() }")
  assert.equal(rule(findings, 'S5').length, 1)
  assert.equal(rule(findings, 'S5')[0].severity, WARN)
})

test('S6 x64 出现在下载逻辑里才警告', () => {
  const withDownload = evaluateSource('lib/fetch.js', 'const url = `https://x/${version}/tool-x64.tar.gz`')
  assert.equal(rule(withDownload, 'S6').length, 1)
  const plain = evaluateSource('lib/a.js', 'const note = "历史上曾是 x64"')
  assert.equal(rule(plain, 'S6').length, 0)
})

test('S7 /bin/bash 警告', () => {
  const findings = evaluateSource('lib/sh.js', "spawn('/bin/bash', ['-lc', cmd])")
  assert.equal(rule(findings, 'S7').length, 1)
})

test('S8 直接 require .node 阻断', () => {
  const findings = evaluateSource('lib/native.js', "const addon = require('./build/Release/addon.node')")
  assert.equal(rule(findings, 'S8').length, 1)
  assert.equal(rule(findings, 'S8')[0].severity, BLOCK)
})

test('S9 用 child_process 执行外部程序只是提示', () => {
  const findings = evaluateSource('lib/x.js', "import { execSync } from 'node:child_process'\nexecSync('ls')")
  assert.equal(rule(findings, 'S9').length, 1)
  assert.equal(rule(findings, 'S9')[0].severity, INFO)
})

test('S 系列同一规则在同一文件只报第一处（带计数逻辑不重复刷屏）', () => {
  const text = ["const a = 'C:\\\\one'", "const b = 'C:\\\\two'", "const c = 'D:\\\\three'"].join('\n')
  const findings = evaluateSource('lib/x.js', text)
  assert.equal(rule(findings, 'S1').length, 1, '同一文件同一规则只留一条')
})

test('注释里的 Windows 路径不算（减少噪音）', () => {
  const findings = evaluateSource('lib/x.js', "// 以前写死过 C:\\\\Users\\\\me\nconst ok = 1")
  assert.equal(rule(findings, 'S1').length, 0)
})

test('干净的纯 JS 插件不产生任何阻断', () => {
  const findings = [
    ...evaluateManifest({
      name: 'clean',
      version: '1.0.0',
      main: 'lib/index.js',
      files: ['lib'],
      dependencies: {},
      engines: { node: '>=20' },
    }),
    ...evaluateSource('lib/index.js', "import { join } from 'node:path'\nexport const name = 'clean'"),
  ]
  assert.equal(findings.filter((item) => item.severity === BLOCK).length, 0)
  assert.equal(verdictOf(findings), 'ok')
})

// ── 汇总

test('verdictOf：有 block 就是 unusable，只有 warn 是 risky', () => {
  assert.equal(verdictOf([]), 'ok')
  assert.equal(verdictOf([{ severity: INFO }]), 'ok')
  assert.equal(verdictOf([{ severity: WARN }]), 'risky')
  assert.equal(verdictOf([{ severity: WARN }, { severity: BLOCK }]), 'unusable')
})

test('sortFindings 把 block 排在最前', () => {
  const sorted = sortFindings([
    { severity: INFO, ruleId: 'S9', file: 'a.js' },
    { severity: BLOCK, ruleId: 'S1', file: 'b.js' },
    { severity: WARN, ruleId: 'S5', file: 'a.js' },
  ])
  assert.deepEqual(
    sorted.map((item) => item.severity),
    [BLOCK, WARN, INFO],
  )
})
