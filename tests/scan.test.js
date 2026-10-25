/**
 * 扫描器测试 —— 用临时目录造真的插件包，验证「读得对、不越界」。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { collectFacts, isIgnored, listFiles, parseIgnorePatterns, readManifest, scanDirectory } from '../lib/scan.js'

let root = ''

/** 造一个文件（自动建父目录）。 */
function put(relative, content) {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-portability-'))
  put(
    'package.json',
    JSON.stringify({
      name: 'demo-plugin',
      version: '1.2.3',
      main: 'lib/index.js',
      files: ['lib'],
      dependencies: { sharp: '^0.33.0' },
      scripts: { postinstall: 'node-gyp rebuild' },
    }),
  )
  put('lib/index.js', "import { join } from 'node:path'\nconst dir = 'C:\\\\data\\\\demo'\n")
  put('lib/helper.mjs', "export const x = '%APPDATA%'\n")
  put('README.md', '# demo\n')
  put('node_modules/should-be-skipped/index.js', "const p = 'D:\\\\skip'\n")
  put('build/binding.gyp', '{}')
  put('build/Release/addon.node', 'binary')
})

after(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

test('readManifest 读得出 package.json', () => {
  const manifest = readManifest(root)
  assert.equal(manifest.error, null)
  assert.equal(manifest.pkg.name, 'demo-plugin')
})

test('readManifest 对坏 JSON 给出 INVALID_JSON', () => {
  const broken = mkdtempSync(join(tmpdir(), 'dsh-broken-'))
  writeFileSync(join(broken, 'package.json'), '{ not json')
  const manifest = readManifest(broken)
  assert.equal(manifest.pkg, null)
  assert.match(manifest.error, /INVALID_JSON/)
  rmSync(broken, { recursive: true, force: true })
})

test('listFiles 跳过 node_modules，并记录跳过原因', () => {
  const listing = listFiles(root)
  const paths = listing.files.map((item) => item.path)
  assert.ok(paths.includes('package.json'))
  assert.ok(paths.includes('lib/index.js'))
  assert.ok(!paths.some((path) => path.startsWith('node_modules/')), 'node_modules 不该被扫描')
  assert.ok(listing.skipped.some((item) => item.path === 'node_modules' && item.reason === 'skipped-dir'))
})

test('listFiles 不 follow 指向根目录外的软链', () => {
  const outside = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
  writeFileSync(join(outside, 'secret.js'), "const p = 'Z:\\\\outside'\n")
  const linked = mkdtempSync(join(tmpdir(), 'dsh-link-'))
  writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'linked', version: '1.0.0' }))
  try {
    symlinkSync(outside, join(linked, 'linked-dir'), 'dir')
  } catch {
    // 无权限建软链（Windows 无开发者模式）时跳过这条
    rmSync(outside, { recursive: true, force: true })
    rmSync(linked, { recursive: true, force: true })
    return
  }
  const listing = listFiles(linked)
  assert.ok(!listing.files.some((item) => item.path.includes('secret.js')))
  assert.ok(listing.skipped.some((item) => /symlink/.test(item.reason)))
  rmSync(outside, { recursive: true, force: true })
  rmSync(linked, { recursive: true, force: true })
})

test('collectFacts 找得到 binding.gyp、二进制与源码', () => {
  const listing = listFiles(root)
  const facts = collectFacts(root, listing)
  assert.equal(facts.hasBindingGyp, true)
  assert.ok(facts.binaryFiles.includes('build/Release/addon.node'))
  assert.ok(facts.sources.some((item) => item.path === 'lib/index.js'))
  assert.ok(!facts.sources.some((item) => item.path === 'README.md'), 'md 不算源码')
})

test('scanDirectory 一条龙返回清单 + 事实', () => {
  const result = scanDirectory(root)
  assert.equal(result.ok, true)
  assert.equal(result.pkg.name, 'demo-plugin')
  assert.ok(result.listing.files.length >= 5)
})

test('scanDirectory 也接受直接指向 package.json', () => {
  const result = scanDirectory(join(root, 'package.json'))
  assert.equal(result.ok, true)
  assert.equal(result.root.split(/[\\/]/).pop(), root.split(/[\\/]/).pop())
})

test('scanDirectory 对不存在的路径给 NOT_FOUND', () => {
  const result = scanDirectory(join(root, 'nope'))
  assert.equal(result.ok, false)
  assert.match(result.error, /NOT_FOUND/)
})

test('scanDirectory 对没有 package.json 的目录给 NOT_A_PLUGIN', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
  const result = scanDirectory(empty)
  assert.equal(result.ok, false)
  assert.match(result.error, /NOT_A_PLUGIN/)
  rmSync(empty, { recursive: true, force: true })
})

/* ---------- 忽略机制：规则定义文件里塞满了别人的坏例子，得能被排除 ---------- */

test('parseIgnorePatterns 认注释、空行、目录前缀、通配符', () => {
  const patterns = parseIgnorePatterns('# 注释\n\nlib/rules.js\ntests/\n*.min.js\n')
  assert.deepEqual(patterns, ['lib/rules.js', 'tests/', '*.min.js'])
})

test('isIgnored 匹配目录前缀、精确路径与通配符', () => {
  const patterns = ['tests/', 'lib/rules.js', '*.min.js']
  assert.equal(isIgnored('tests/a/b.test.js', patterns), true, '目录前缀要匹配子路径')
  assert.equal(isIgnored('tests', patterns), true, '目录本身也要匹配')
  assert.equal(isIgnored('lib/rules.js', patterns), true)
  assert.equal(isIgnored('lib/index.js', patterns), false)
  assert.equal(isIgnored('dist/app.min.js', patterns), true, '通配符按整路径匹配')
  assert.equal(isIgnored('lib/scan.js', patterns), false)
})

test('scanDirectory 会读 .portabilityignore 并真的跳过被忽略的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'with-ignore', version: '1.0.0', main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), "export const ok = 1\n")
  writeFileSync(join(dir, '.portabilityignore'), 'samples/\n')
  mkdirSync(join(dir, 'samples'), { recursive: true })
  writeFileSync(join(dir, 'samples', 'bad.js'), "const p = 'C:\\\\windows'\n")

  const result = scanDirectory(dir)
  const paths = result.listing.files.map((item) => item.path)
  assert.ok(!paths.includes('samples/bad.js'), '被忽略的目录不该出现在文件列表里')
  assert.ok(result.listing.skipped.some((item) => item.path === 'samples' && item.reason === 'ignored'))
  assert.deepEqual(result.ignore, ['samples/'])
  rmSync(dir, { recursive: true, force: true })
})

test('package.json 的 dsh.androidPortability.ignore 与忽略文件叠加生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ignore-pkg-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'pkg-ignore',
      version: '1.0.0',
      dsh: { androidPortability: { ignore: ['generated.js'] } },
    }),
  )
  writeFileSync(join(dir, 'generated.js'), "const p = 'C:\\\\x'\n")
  writeFileSync(join(dir, 'index.js'), 'export const a = 1\n')
  const result = scanDirectory(dir)
  const paths = result.listing.files.map((item) => item.path)
  assert.ok(!paths.includes('generated.js'))
  assert.ok(paths.includes('index.js'))
  rmSync(dir, { recursive: true, force: true })
})
