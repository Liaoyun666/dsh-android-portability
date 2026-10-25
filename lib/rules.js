/**
 * 规则引擎 —— 判断一个 DSH 插件能不能在 DSHA 的安卓容器里活下来。
 *
 * 为什么需要它：DSHA 的运行时是 **Linux arm64 + glibc**，跑在 proot 里，没有
 * Windows、没有 x64、没有编译器、没有 `cmd.exe`。一个插件在作者的 Windows 上
 * 「测试全绿」，装到手机上却是 `Cannot find module 'xxx.node'` 或者静默不工作。
 * 这些错**在安装完成之后才暴露**，而且报错信息通常指不到真正的病因。
 *
 * 所以这里做静态体检：不动插件、不装依赖，只读 package.json 和源码文本，
 * 把「在安卓上一定会断」和「在安卓上大概会断」分开。
 *
 * 规则分三类：清单级（M）、依赖级（D）、源码级（S）。每条规则给出
 * 证据（文件:行 + 原文片段）和改法 —— 只说「有问题」是不够的。
 */

/** 严重程度：block = 一定跑不起来；warn = 可能出问题；info = 只是不像安卓。 */
export const BLOCK = 'block'
export const WARN = 'warn'
export const INFO = 'info'

/** 严重程度排序（报告里 block 在前）。 */
const SEVERITY_ORDER = { [BLOCK]: 0, [WARN]: 1, [INFO]: 2 }

/**
 * 已知的原生模块：装了就要在手机上编 C/C++，而容器里没有编译器。
 * 名单不求全 —— 真正的判据是「有没有 install 脚本跑 node-gyp」和「包里有 .node 文件」，
 * 这个名单只是让人一眼看到：「哦，sharp 啊」。
 */
 const NATIVE_PACKAGES = new Map([
  ['sharp', 'libvips 原生绑定'],
  ['better-sqlite3', 'SQLite 原生绑定'],
  ['sqlite3', 'SQLite 原生绑定'],
  ['canvas', 'Cairo 原生绑定'],
  ['node-canvas', 'Cairo 原生绑定'],
  ['node-pty', 'PTY 原生绑定，需要编译'],
  ['bcrypt', 'bcrypt 原生实现（换成 bcryptjs）'],
  ['argon2', '原生密码哈希'],
  ['fsevents', '只有 macOS 有'],
  ['re2', 'C++ 正则引擎'],
  ['node-sass', 'LibSass 原生绑定（换成 sass）'],
  ['puppeteer', '自带 Chromium 二进制，体积与架构都不对'],
  ['playwright', '自带浏览器二进制，架构不对'],
  ['@napi-rs/canvas', 'napi 原生二进制包'],
  ['@napi-rs/keyring', 'napi 原生二进制包'],
  ['usb', 'libusb 原生绑定'],
  ['serialport', '串口原生绑定'],
  ['node-gyp', '编译工具，容器里没有编译器'],
  ['keytar', '系统钥匙串原生绑定'],
  ['realm', '原生数据库'],
  ['leveldown', 'LevelDB 原生绑定'],
  ['zeromq', 'libzmq 原生绑定'],
  ['sodium-native', 'libsodium 原生绑定'],
])

/** 平台后缀的包名（esbuild / rollup / swc 那一套可选依赖）。 */
const PLATFORM_SUFFIX = /(?:^|[-/])(win32|darwin|linux|android|freebsd|openbsd|sunos|netbsd)[-_](x64|arm64|arm|ia32|universal|ppc64|s390x|riscv64)/i

/** 会在安装时编译的原生构建线索。 */
const BUILD_HINTS = /\b(node-gyp|node-pre-gyp|prebuild-install|cmake-js|gyp|make\s+-C|cc1plus|gcc|g\+\+)\b/i

/** 产物可执行的架构名（打包进来的 .node 只可能是其中一种）。 */
const BINARY_ARCH = /\.(node|so|dylib|dll|a|wasm)$/i

/** 造一条 finding。 */
function finding(ruleId, severity, problem, fix, extra = {}) {
  return { ruleId, severity, problem, fix, ...extra }
}

/**
 * 清单级检查（package.json）。
 * @param {Record<string, any>} pkg
 * @param {{ hasBindingGyp?: boolean, binaryFiles?: string[] }} facts
 */
export function evaluateManifest(pkg, facts = {}) {
  const out = []
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }
  const devDeps = { ...(pkg.devDependencies ?? {}) }

  // D1：点名道姓的原生依赖
  for (const [name, range] of Object.entries(deps)) {
    const known = NATIVE_PACKAGES.get(name)
    if (known) {
      out.push(
        finding(
          'D1',
          BLOCK,
          `依赖 ${name}@${range} 是原生模块（${known}），安卓容器里没有编译器也下不到 arm64 预编译包`,
          `把它改成纯 JS 等价物（sharp→jimp、bcrypt→bcryptjs、better-sqlite3→sql.js、node-pty→跳过），或者把这块能力做成可选：运行时 try/catch require，缺了就降级。`,
          { package: name },
        ),
      )
    }
  }

  // D2：可选依赖里只有 x64 / win32 的二进制包
  const platformDeps = Object.keys(deps).filter((name) => PLATFORM_SUFFIX.test(name))
  if (platformDeps.length > 0) {
    const hasArm64Linux = platformDeps.some((name) => /linux[-_]arm64|linux-arm64/i.test(name))
    const others = platformDeps.filter((name) => !/linux[-_]arm64/i.test(name))
    if (!hasArm64Linux) {
      out.push(
        finding(
          'D2',
          BLOCK,
          `可选依赖里有 ${platformDeps.length} 个平台二进制包（${others.slice(0, 3).join('、')}…），但没有 linux-arm64 那一份`,
          '补上 `linux-arm64` 对应的可选依赖（esbuild/rollup/swc 都有），否则这些包的 require 会抛「找不到本平台二进制」。',
          { packages: platformDeps },
        ),
      )
    }
  }

  // D3：安装期编译
  const scripts = { ...(pkg.scripts ?? {}) }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    const command = scripts[hook]
    if (typeof command === 'string' && BUILD_HINTS.test(command)) {
      out.push(
        finding(
          'D3',
          BLOCK,
          `${hook} 脚本里在编译：${command.slice(0, 80)}`,
          'DSHA 安装依赖时会跑生命周期脚本，但容器里没有 gcc/python/make。改成发布预编译产物，或者把这个依赖降为可选。',
          { hook },
        ),
      )
    }
  }

  // D4：包里有原生二进制产物
  if (facts.hasBindingGyp) {
    out.push(
      finding('D4', BLOCK, '包里带 binding.gyp（安装时会尝试现场编译）', '删掉它，或改成下载预编译产物。安卓上编译必失败。')
    )
  }
  const binaries = (facts.binaryFiles ?? []).filter((file) => /\.node$/i.test(file))
  if (binaries.length > 0) {
    // wasm 是跨架构的，.node 不是
    out.push(
      finding(
        'D4',
        BLOCK,
        `包里直接带了 ${binaries.length} 个 .node 二进制（${binaries.slice(0, 3).join('、')}）`,
        '.node 是按架构和 glibc 版本编的，x64/win 的那份在 arm64 上加载会报 ELF 错误。要带就带 linux-arm64 + glibc 的那份。',
        { files: binaries },
      ),
    )
  }
  const wasm = (facts.binaryFiles ?? []).filter((file) => /\.wasm$/i.test(file))
  if (wasm.length > 0) {
    out.push(finding('D4', INFO, `包里有 ${wasm.length} 个 .wasm（跨架构，安全）`, '无需处理。'))
  }

  // D5：package.json 的 os / cpu 字段把 linux/arm64 排除在外
  const os = pkg.os
  const cpu = pkg.cpu
  if (Array.isArray(os) && !os.includes('linux') && !os.includes('!win32')) {
    if (os.every((item) => !String(item).startsWith('!'))) {
      out.push(
        finding('D5', BLOCK, `os 字段只允许 ${os.join('/')}，装不到 Linux 上`, '把 "linux" 加进 os 数组（或干脆别限制）。')
      )
    }
  }
  if (Array.isArray(cpu) && cpu.length > 0 && cpu.every((item) => !String(item).startsWith('!'))) {
    if (!cpu.includes('arm64')) {
      out.push(finding('D5', BLOCK, `cpu 字段只允许 ${cpu.join('/')}，arm64 不在里面`, '把 "arm64" 加进 cpu 数组。'))
    }
  }

  // D6：files 白名单漏了入口（装完是空的）
  if (Array.isArray(pkg.files)) {
    const entry = pkg.main || pkg?.cordis?.entry
    if (typeof entry === 'string') {
      const entryDir = entry.split('/')[0]
      if (!pkg.files.includes(entry) && !pkg.files.includes(entryDir)) {
        out.push(
          finding('D6', WARN, `files 白名单里没有入口 ${entry} 所在的 ${entryDir}/`, `把 "${entryDir}" 加进 files，否则发布出去的包缺代码。`),
        )
      }
    }
  }

  // D7：engines.node 高于容器里的版本（DSHA 带 Node >= 20）
  const engines = pkg.engines?.node
  if (typeof engines === 'string') {
    const match = /(\d+)/.exec(engines)
    if (match && Number(match[1]) > 24) {
      out.push(
        finding('D7', WARN, `engines.node 要求 ${engines}`, 'DSHA 内置的 Node 是 20–24。要求更高的话，装得上但运行时会崩。'),
      )
    }
  }

  // D8：只声明了 devDependencies 里的原生包 —— 提示一下，不拦
  for (const name of Object.keys(devDeps)) {
    if (NATIVE_PACKAGES.has(name)) {
      out.push(finding('D8', INFO, `devDependencies 里有原生模块 ${name}`, '开发期用没关系，只要运行时不需要它。'))
    }
  }

  return out
}

/**
 * 源码级检查：逐文件看文本。
 * @param {string} file 相对路径
 * @param {string} text 文件内容
 */
export function evaluateSource(file, text) {
  const out = []
  const lines = text.split(/\r?\n/)

  /** 在一行里找模式，命中就记一条（同一文件同一规则只留第一处 + 计数）。 */
  const hits = new Map()
  const record = (ruleId, severity, lineNumber, excerpt, problem, fix) => {
    if (hits.has(ruleId)) {
      hits.get(ruleId).count += 1
      return
    }
    hits.set(ruleId, { count: 1 })
    out.push(finding(ruleId, severity, problem, fix, { file, line: lineNumber, excerpt: excerpt.trim().slice(0, 160) }))
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    // 跳过注释行，减少噪音（不完美，但足够）
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')

    // S1：Windows 绝对路径
    const winPath = /(^|[^A-Za-z0-9_])[A-Za-z]:\\[^\s'"`)]{2,}/.exec(code)
    if (winPath) {
      record(
        'S1',
        BLOCK,
        lineNumber,
        winPath[0],
        '写死了 Windows 绝对路径（如 C:\\ 或 E:\\），安卓容器里这个盘符不存在',
        '改用 path.join(os.homedir(), ...) 或 path.resolve(import.meta.dirname, ...)，把路径做成配置项。',
      )
    }

    // S2：Windows 环境变量
    const winEnv = /%[A-Z_]+%/.exec(code)
    if (winEnv) {
      record(
        'S2',
        BLOCK,
        lineNumber,
        winEnv[0],
        `写死了 Windows 环境变量 ${winEnv[0]}，Linux 里它是字面量`,
        '改用 process.env.APPDATA ?? path.join(os.homedir(), ".config")，或者只看 XDG 变量。',
      )
    }

    // S3：调用 windows 专属可执行
    const winExe = /\b(cmd\.exe|powershell(?:\.exe)?|pwsh(?:\.exe)?|where\.exe|start\s+"")\b/i.exec(code)
    if (winExe) {
      record(
        'S3',
        BLOCK,
        lineNumber,
        winExe[0],
        `调用 Windows 专属命令 ${winExe[0]}，安卓上没有`,
        '用 node 内建能力（fs、child_process 直接调目标程序），或在 process.platform 分支里只对 win32 用这条路。',
      )
    }

    // S4：.bat / .ps1 / .cmd 脚本
    const winScript = /['"`][^'"`]*\.(bat|ps1|cmd|exe)['"`]/i.exec(code)
    if (winScript) {
      record(
        'S4',
        WARN,
        lineNumber,
        winScript[0],
        '引用了 Windows 脚本或 .exe',
        '这些文件在安卓上不存在；如果只是可选的加速路径，务必 try/catch 并降级。',
      )
    }

    // S5：只用 win32 一分支的平台判断
    const platformCheck = /process\.platform\s*(?:===?|!==?)\s*['"](win32|darwin)['"]/.exec(code)
    if (platformCheck) {
      record(
        'S5',
        WARN,
        lineNumber,
        platformCheck[0],
        `按 ${platformCheck[1]} 分支处理，安卓（linux）会走到 else —— 确认 else 不是「什么都不做」`,
        '把分支写成「win32 / 其他」两路，并在注释里写明「其他」包含 linux arm64。',
      )
    }

    // S6：只认 x64 的架构判断
    const archCheck = /\b(x64|x86_64|amd64)\b/.exec(code)
    if (archCheck && /arch|platform|download|binary|url/i.test(code)) {
      record(
        'S6',
        WARN,
        lineNumber,
        archCheck[0],
        '提到 x64/x86_64 架构（下载二进制或选路径时常见）',
        '安卓是 arm64：下载地址要按 process.arch 拼，arm64 走另一份；拼不出来就别下载。',
      )
    }

    // S7：/bin/bash — 安卓容器里通常只有 sh
    const bashPath = /['"`]\/bin\/bash['"`]/.exec(code)
    if (bashPath) {
      record(
        'S7',
        WARN,
        lineNumber,
        bashPath[0],
        '写死了 /bin/bash，DSHA 容器里一般只有 sh',
        '改用 sh，或者先探测 bash 是否存在再决定。',
      )
    }

    // S8：require/import .node
    const nodeBinary = /require\([^)]*\.node['"]\)|from\s+['"][^'"]*\.node['"]/.exec(code)
    if (nodeBinary) {
      record('S8', BLOCK, lineNumber, nodeBinary[0], '直接 require 一个 .node 原生文件', '换成纯 JS 实现，或改成可选加载并给出降级路径。')
    }
  })

  // S9：用了 child_process 的 shell 字符串（不一定是错，但安卓上 PATH 很短）
  if (/\bchild_process\b|execSync|spawnSync/.test(text) && !/spawn\(/.test(text)) {
    out.push(
      finding('S9', INFO, '用 child_process 执行外部程序', '安卓容器的 PATH 很短（没有 ls 之外的一堆工具）。确认目标程序真的在。', {
        file,
      }),
    )
  }

  return out
}

/** 按严重程度排序，再按文件。 */
export function sortFindings(findings) {
  return findings.slice().sort((left, right) => {
    const bySeverity = (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
    if (bySeverity !== 0) return bySeverity
    return String(left.file ?? '').localeCompare(String(right.file ?? '')) || (left.line ?? 0) - (right.line ?? 0)
  })
}

/** 汇总判定：有一个 block 就是 unusable，只有 warn 是 risky，干净是 ok。 */
export function verdictOf(findings) {
  if (findings.some((item) => item.severity === BLOCK)) return 'unusable'
  if (findings.some((item) => item.severity === WARN)) return 'risky'
  return 'ok'
}

/** 规则总表（给 CLI --list-rules 和 README 用）。 */
export const RULES = [
  { id: 'D1', scope: '依赖', severity: BLOCK, title: '原生依赖（需要编译 C/C++）' },
  { id: 'D2', scope: '依赖', severity: BLOCK, title: '平台二进制可选依赖缺 linux-arm64' },
  { id: 'D3', scope: '依赖', severity: BLOCK, title: '安装期编译脚本' },
  { id: 'D4', scope: '产物', severity: BLOCK, title: '包里带 binding.gyp 或 .node 二进制' },
  { id: 'D5', scope: '清单', severity: BLOCK, title: 'os / cpu 字段排除 linux-arm64' },
  { id: 'D6', scope: '清单', severity: WARN, title: 'files 白名单漏了入口' },
  { id: 'D7', scope: '清单', severity: WARN, title: 'engines.node 高于容器版本' },
  { id: 'D8', scope: '清单', severity: INFO, title: 'devDependencies 含原生模块' },
  { id: 'S1', scope: '源码', severity: BLOCK, title: 'Windows 绝对路径' },
  { id: 'S2', scope: '源码', severity: BLOCK, title: 'Windows 环境变量 %VAR%' },
  { id: 'S3', scope: '源码', severity: BLOCK, title: '调用 Windows 专属命令' },
  { id: 'S4', scope: '源码', severity: WARN, title: '引用 .bat/.ps1/.exe' },
  { id: 'S5', scope: '源码', severity: WARN, title: '只处理 win32/darwin 的平台分支' },
  { id: 'S6', scope: '源码', severity: WARN, title: '按 x64 架构下载或选路' },
  { id: 'S7', scope: '源码', severity: WARN, title: '写死 /bin/bash' },
  { id: 'S8', scope: '源码', severity: BLOCK, title: '直接 require .node 文件' },
  { id: 'S9', scope: '源码', severity: INFO, title: '调用外部程序（PATH 很短）' },
]

export { NATIVE_PACKAGES, BINARY_ARCH }
