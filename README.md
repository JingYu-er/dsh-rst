# dsh-rst

> 一条 `/rst` 重启 DSH，并让重启后的 DSH 回到你这条会话里补一张回执。

English: [README_EN.md](README_EN.md) · [安装](#安装) · [界面预览](#界面预览) · [快速开始](#快速开始) · [时序](#时序) · [安全边界](#安全边界) · [重启后的回执](#重启后的回执) · [日志与排障](#状态文件与日志) · [已知限制](#兼容性与已知限制)

[![GitHub stars](https://img.shields.io/github/stars/JingYu-er/dsh-rst?style=flat)](https://github.com/JingYu-er/dsh-rst)
![version](https://img.shields.io/badge/version-0.2.4-blue)
![platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-lightgrey)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 这是什么

`dsh-rst` 给 DSH 加一条**给人用的**斜杠命令 `/rst`：在会话里敲一下，DSH 自己重启，重启完成后在**原来那条会话**里追加一张回执卡片，告诉你「回来了，用时几秒，新 Host PID 多少」。

它不做的事：不接管进程管理、不替你切换模型或配置、不碰你的对话内容（除了那张回执卡片）。它是用户命令，不是模型工具——模型不能调用它。桌面版和 CLI 模式下都可用。

## 界面预览

在会话里敲 `/rst` 之后：

![`/rst` 重启中与重启完成回执](docs/rst-restart.png)

命令卡片显示重启器 PID、日志路径和预计耗时；几秒后**同一条会话**追加回执：「已重启完成：DSH 已经带着新配置回到这个会话（用时 X 秒，新 Host PID N）」。

## 为什么需要这个插件

手动重启 DSH 本身不难，难的是它一天要发生很多次：装完或更新插件要重启才生效，改一行插件代码要看效果，切了配置要确认是否吃上，一轮实验跑完想清空状态——每次都是「关掉应用 → 等它退干净 → 双击图标 → 重新打开刚才那个会话 → 回忆刚才在调什么」。动作不长，但重复几十遍之后，消耗的是注意力，不是那几秒。

`/rst` 把这一串压成一条命令：

- **装插件、改插件、切配置之后不用再手动走流程。** 在会话里敲 `/rst`，几秒后同一个会话里出现一张回执：「已重启完成（用时 X 秒，新 Host PID N）」，新 Host 加载的就是你刚装/刚改的东西。调试插件时这个循环一天能跑几十次，这是它最值钱的地方。
- **结果回到你正在说话的地方。** 回执落在原会话里，上下文不丢，不用靠记忆拼「我刚才在验证哪个改动」。
- **人在外面也能重启。** 配合 `@xmanrui/dsh-im` 等远程控制插件，手机上发一条 `/rst` 就能远程重启（走消息兜底通道）；GUI 卡住、远程桌面没连上、你不在电脑前时最有用。

### 为什么必须有一个进程外的启动器（技术说明）

重启分三步：关掉当前 Host → 等它的 Web 端口释放 → 用同样的参数把同一个 exe 拉起来。这三步不能由 Host 自己完成：

1. **命令卡片在 Host 里执行，Host 一退出就断在半路。** 没有人能保证「等端口释放 → 重新拉起」被走完，所以必须有一个**不在 DSH 进程树里**的进程去做这件事。
2. **不能靠 `process.send` 或 preload 往回要状态。** Host 和 Electron 主进程是两个进程，要重启就只能在外部动手。
3. **反向路径不存在。** 没有「重启完成」的通知通道——回执只能由**重启后的新 Host** 自己发。

于是职责被拆成三块：插件只负责「收命令、写交接文件、发回执」，重启交给一个 detached 的纯 Node 启动器（`relaunch.cjs`），回执靠重启后的新 Host 读 `pending.json` 补发。

## 安装

### 从 npm 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-rst
```

### 从 GitHub 直装

```powershell
dsh plugin --profile desktop add github:JingYu-er/dsh-rst#main
```

装完**重启一次 DSH**（让 bundle 层生效）。是否就绪这样确认：

```
/rst --dry-run
```

它会打印重启计划（父进程 / 宿主 PID、要拉起的 exe、Web 端口、日志路径）而**不动任何进程**。

本地开发可以挂 link：

```powershell
dsh plugin --profile desktop add link:D:\path\to\dsh-rst
```

改完代码不用手动重启——下次 `/rst` 拉起的 Host 加载的就是新代码（插件是自举的）。

## 快速开始

| 用法 | 行为 |
|------|------|
| `/rst` | 重启 DSH，并在回复里给出启动器 PID 与日志路径 |
| `/rst --dry-run` | 只打印重启计划，不杀、不拉 |

## 时序

```
你：/rst
 │
 ├─ 插件（Host 进程）立刻回一张命令卡片「正在重启」
 │    └─ 写 %LOCALAPPDATA%\dsh-rst\pending.json
 │       （sessionId / startedAt / shellPid / hostPid）
 │
 ├─ 用 process.execPath + ELECTRON_RUN_AS_NODE=1 spawn relaunch.cjs（detached）
 │    └─ 启动器：等 2 s → 安全闸校验 → 优雅关 Host → 等宿主退出
 │       → 等 Web 端口释放 → 拉起同一个 exe → 写 restart-<ts>.log
 │
 └─ 新 Host 起来，DSH 恢复原会话
      └─ 插件轮询 sessions.get(sessionId)（每 500 ms，最多 180 s）
         └─ 会话变成 live → 追加回执（command/run + command/done）
            → 删除 pending.json
```

## 安全边界

重启意味着要杀进程，所以边界写得比较死：

- **安全闸**：杀之前 `tasklist` 一次，确认目标 PID 的**映像名**与计划里记录的 exe 映像名一致（大小写不敏感）。名字对不上就 abort——只写日志，**一个进程都不杀**。
- **只杀 PID，不带 `/T`**：不按名字群杀，也不顺手带走子进程（Vite、构建工具、你的终端都不在重启范围里）。
- **每一步都有账**：start / gate / wait / kill / spawn / abort 全写进 `restart-<ts>.log`；abort 时命令结果里会如实写「已中止：shell 不是 …」。
- **不做假成功**：拉不起来就是 failed 并给出日志路径，不静默、不假装。
- **`--dry-run` 零副作用**：只打印计划，不碰进程、不写 pending.json。

## 重启后的回执

回执是跨重启的一次交接：

1. `/rst` 触发时写 `pending.json`（会话 id、启动时间、各 PID）。
2. 新 Host 里插件在 `apply` 完成后轮询 `sessions.get(sessionId)`，每 500 ms 一次，最多 180 s。
3. 会话恢复成 live 的那一轮成功，就往原会话追加两条事件：
   - `command/run`：命令卡片（name `rst`，`source` 为 user）
   - `command/done`：kind `success`，文本「已重启完成：DSH 已经带着新配置回到这个会话（用时 X 秒，新 Host PID N）。」
4. 写成功后删除 `pending.json`；超时就只记日志。

**只写命令卡片，不写 assistant / message，不插合成回合。** 这是踩过坑的结论：早期版本为了「让回复出现在对话里」，往会话日志里缝 assistant 事件、往当前 turn 里塞一条消息，结果会话上下文当场解析失败（turns 乱、parseFail 非 0、帧被丢弃）。会话日志是 DSH 的持久化格式，能被它自己解析是硬约束；命令卡片是官方支持的写入面，回执就走这条。

回执超时**不等于重启失败**：如果 180 s 内你一直没打开那条会话，pending 会留着，下次启动再补一次（日志里如实记 timeout）。

## 状态文件与日志

全部在 `%LOCALAPPDATA%\dsh-rst\`：

| 文件 | 内容 |
|------|------|
| `loaded.log` | 插件被 Host 加载（pid、electron 版本、commands 服务是否可用） |
| `invocations.log` | 每次触发记录（命令或消息、会话、上下文） |
| `host-trace.log` | Host 侧痕迹；用来区分「命令没进来」还是「启动器没起来」 |
| `announce.log` | 回执轮询明细：start / attempt / appended / timeout |
| `pending.json` | 待补发的回执（拿到才算完，成功即删） |
| `restart-<ts>.log` | 单次重启的启动器逐步日志 |

## 实现细节

| 项 | 桌面模式 | CLI 模式 |
|----|----------|----------|
| 判定 | `process.versions.electron` 存在且 `process.send` 是函数 | 其余情况 |
| 关掉谁 | `taskkill /PID <Electron 主进程>`（先优雅，2 s 没走再强制） | 由启动器 `process.exit(0)` |
| 拉起谁 | 同一个 exe，环境里去掉 `ELECTRON_RUN_AS_NODE` | 同一个 node + 同样的 argv |
| 等端口 | 从 `DSH_WEB_URL` 解析端口，最多等 10 s | 不等 |
| 失败形态 | 命令卡片显示启动器 PID 与日志路径 | 同左 |

启动器参数：`--shell --host --exe --workdir --log --delay --grace [--port] [--exeargs]`，默认 `delay=2000ms`（给命令卡片落日志的时间）、`grace=2000ms`（优雅关机的宽限）。拉起失败会重试，最多 3 次，每次拉起后 1 s 检查是否还活着。

环境变量：`DSH_WEB_URL`（解析 Web 端口）、`LOCALAPPDATA`（状态目录，缺省回退 `TEMP` / 用户目录）。

**消息兜底**：远程控制插件（如 `@xmanrui/dsh-im`）把消息送进来时，`/rst` 会以普通消息出现；插件全局监听 `session/event`，命中 `^/rst(\s|$)` 且 5 s 防抖后走同一套流程。

## 兼容性与已知限制

- 进程枚举与关停依赖 `tasklist` / `taskkill`：目前**只支持 Windows 10/11**。
- 只覆盖桌面版与 CLI 模式；TUI 模式没有 Web 端口，拉起后不再等端口。
- 回执需要 180 s 内那条会话被恢复成 live；超时只写日志，会话里不会有任何提示。
- 重启会打断正在跑的回合，长回合里别 `/rst`。
- 命令名固定 `rst`，与其他插件撞名时先改名再装。
- `pending.json` 超时后不自动清理：下次启动会再试，如果那个会话早已不存在，日志里会多几行 timeout（无害）。

## 排错

1. **输入 `/rst` 没有补全** → 插件没加载。看 `loaded.log` 有没有新行，profile 的 `package.json` 里是否同时有 link 依赖和 `bundles` 列表项。
2. **命令报「找不到重启器脚本」** → 包不完整：发布时 `files` 里漏了 `relaunch.cjs`。
3. **应用没回来** → 看 `restart-<ts>.log` 停在哪一步。`abort: shell … is not …` 说明安全闸拦下了（父进程不是 DSH）。
4. **回执没来** → `announce.log` 只有 start/attempt：会话没恢复成 live。把那条会话打开，最多等 180 s；或下次启动时补发。
5. **会话日志报 dropped frames / parseFail** → 不该再出现：回执只写命令卡片，不缝 assistant 消息。

## 目录结构

```
dsh-rst/
├── index.js          插件入口：name / apply / 命令注册 / 回执交接
├── relaunch.cjs      启动器（纯 Node，被 detached 拉起，脱离 DSH 进程树）
├── relaunch.ps1      早期 PowerShell 版启动器（已弃用，保留作参考）
├── cordis.patch.yml  bundle 层声明：把插件挂进 loader 树
├── package.json
├── README.md / README_EN.md
└── LICENSE
```

## 开发

`index.js` 是唯一的宿主侧入口；`relaunch.cjs` 不依赖 DSH 运行时，只用 Node 标准库，方便单独调试。

改完直接 `/rst` 验证即可——被拉起的新 Host 会加载工作区里的新代码。动手前建议先 `/rst --dry-run` 看一眼计划，确认你准备杀的是对的进程。

## 许可证

[MIT](LICENSE)
