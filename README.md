# dsh-android-portability

> 发插件之前先量一下：**这东西装到安卓手机上跑得起来吗？**

DSHA（DeepSeek Harness for Android）里跑的是 **Linux arm64 + glibc** 的 proot 容器，不是你的 Windows 台式机。
一个在电脑上完美运行的 DSH 插件，搬到手机上最常见的死法有三种：

1. 依赖 `sharp` / `better-sqlite3` / `node-pty` 这类**要编译的原生模块** —— arm64 预编译包多半没有，现编译又没有工具链；
2. 代码里写死 `C:\Users\...`、`%APPDATA%`、`powershell.exe` —— 安卓容器里这些一个都不存在；
3. 下载逻辑只认 `x64`，装到 arm64 上直接下错二进制然后崩。

这个插件在**装之前**把这些都指出来，逐条给 `文件:行` + 原文片段 + 改法。只读源码文本，不执行、不装依赖、不联网。

## 装

```
dsha-plugin install Liaoyun666/dsh-android-portability
```

装完在任意会话里直接问模型「帮我查一下这个插件能不能装到手机上」，或者显式调工具：

- `dsh_check_android_portability` —— 查一个插件目录
- `dsh_scan_profile_android` —— 批量查 `/root/.dsh/profiles/*/node_modules` 里已装的插件

## 命令行

也能脱离 DSH 单独跑（CI 里很好用）：

```bash
node tools/cli.js ./my-plugin              # 人看的报告
node tools/cli.js ./my-plugin --json       # 机器读
node tools/cli.js ./my-plugin --github     # GitHub Actions 注解，直接标在文件的对应行
node tools/cli.js . --verbose              # 每处都列出来（默认每组只列 3 处）
node tools/cli.js . --strict               # 警告也算失败
node tools/cli.js --list-rules             # 看 17 条规则
```

退出码：`0` 可装 / `1` 有问题 / `2` 用法错误。

## 17 条规则

**依赖与清单（D 组）**

| 号 | 查什么 | 级别 |
| --- | --- | --- |
| D1 | `dependencies` 里有原生模块（sharp、better-sqlite3、node-pty…） | 阻断 |
| D2 | `optionalDependencies` 里只有 win32/darwin 二进制，缺 linux-arm64 那份 | 阻断 |
| D3 | 安装期跑 `node-gyp` / `node-pre-gyp` / `prebuild-install` / `cmake-js` | 阻断 |
| D4 | 包里带 `binding.gyp` 或 `.node` 二进制（`.wasm` 只提示） | 阻断 |
| D5 | `os` / `cpu` 字段排除了 linux / arm64 | 阻断 |
| D6 | `files` 白名单漏了入口文件 | 阻断 |
| D7 | `engines.node` 要求高于容器的 Node | 阻断 |
| D8 | 开发依赖里有原生模块 | 提示（开发期无所谓） |

**源码（S 组）**

| 号 | 查什么 | 级别 |
| --- | --- | --- |
| S1 | Windows 绝对路径（`C:\` `E:\`） | 阻断 |
| S2 | `%APPDATA%` 这种 Windows 环境变量 | 阻断 |
| S3 | 调 `cmd.exe` / `powershell` | 阻断 |
| S4 | 引用 `.bat` / `.ps1` / `.exe` | 警告 |
| S5 | 只写了 `win32`/`darwin` 分叉，安卓走 else | 警告 |
| S6 | 下载逻辑里出现 `x64` | 警告 |
| S7 | 写死 `/bin/bash`（容器里通常只有 sh） | 警告 |
| S8 | 直接 `require('./x.node')` | 阻断 |
| S9 | `child_process` 调外部程序（PATH 很短） | 提示 |

注释行不算 —— 写了「不要用 C:\ 路径」的注释不会被误报。

## 误报怎么办

规则定义文件、测试样本里天然带着一堆坏例子（不然怎么测）。用 `.portabilityignore` 排除：

```
# 一行一个，支持三种写法
lib/rules.js        # 精确路径
tests/              # 目录前缀
*.min.js            # 通配符
```

也可以写在 `package.json`：

```json
{ "dsh": { "androidPortability": { "ignore": ["generated/"] } } }
```

两处叠加生效。

## 它不做什么

- **不**执行插件代码，**不** `npm install`，**不**联网 —— 纯静态读文本，安全到可以对着陌生仓库跑。
- **不**替你改代码，只给结论和改法。
- 扫不到运行时才暴露的问题（比如某个 API 在安卓上行为不同）。静态检查的边界就到这。

## 开发

```bash
node --test tests/rules.test.js tests/scan.test.js tests/report.test.js tests/cli.test.js
node tools/check-manifest.js
node tools/cli.js .        # 自检：本插件自己也得是可移植的
```

零运行时依赖，纯 ESM，`node >= 20`。

## License

MIT
