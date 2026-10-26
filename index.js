/**
 * dsh-rst —— 一个斜杠命令 `/rst`：重启 DSH 本体。
 *
 * 为什么不能"自己重启自己"：
 *   DSH 桌面版是「Electron 外壳 + Host 子进程」两层。这个插件跑在 Host 里，
 *   而重启应用用的是外壳主进程的 `app.relaunch()`，既没有 IPC 通道，
 *   也没有任何插件能调用的服务；外壳上唯一的重启入口是托盘菜单
 *   「重启应用与 Host」。所以这里换一个思路：由一个**独立于 DSH 进程树**的
 *   启动器负责「先送走旧的，再拉起新的」，Host 只负责把启动器派出去。
 *
 * 时序：
 *   /rst → Host 写日志 + 起一个分离的 PowerShell 启动器 → 立即返回
 *        → 启动器等 0.7 s（让消息落盘、让界面刷出来）
 *        → 请外壳正常退出（WM_CLOSE）；2 s 没退就强杀
 *        → 确认 Host 真死（端口和单实例锁都在它手里）
 *        → Start-Process 拉起同一个可执行文件
 *
 * 安全闸（都在 relaunch.ps1 里，宿主这边只是传参）：
 *   · 动手前先核对「父进程路径 == 要拉起的可执行文件」，
 *     对不上就 abort —— 绝不误杀别的进程。
 *   · 只按 PID 杀，不用 /T（/T 会连带杀掉启动器自己）。
 *   · 全程写日志，重启失败时日志是唯一线索。
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-rst";

/** 启动器脚本：与 index.js 同目录（纯 Node 实现，不依赖 PowerShell）。 */
const HELPER_SCRIPT = fileURLToPath(new URL("./relaunch.cjs", import.meta.url));

/** 桌面版给外壳的"正常退出"窗口；超时后强杀。 */
const DEFAULT_GRACE_MS = 2000;

/** 启动器动手前的等待：留出 2 秒让命令回执落盘、界面刷出来，然后才送走进程。 */
const DEFAULT_DELAY_MS = 2000;

/** 桌面版 Host：Electron 以 ELECTRON_RUN_AS_NODE 跑起来的 node 子进程，ppid 就是 Electron 主进程。 */
function isDesktopHost() {
    return process.versions.electron !== undefined && typeof process.send === "function";
}

function logFilePath() {
    const base = process.env.LOCALAPPDATA ?? process.env.TEMP ?? homedir();
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    return join(base, "dsh-rst", "restart-" + stamp + ".log");
}

/**
 * 加载标记：插件被 Host 真正加载（或热重载）时会往 %LOCALAPPDATA%\dsh-rst\loaded.log 追加一行。
 * 排障用：有这个文件 = 插件在这台机器上被加载过，`/rst` 这个命令就该存在。
 */
function markLoaded(scope) {
    try {
        const dir = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? homedir(), "dsh-rst");
        mkdirSync(dir, { recursive: true });
        appendFileSync(
            join(dir, "loaded.log"),
            new Date().toISOString() +
                " pid=" + String(process.pid) +
                " electron=" + String(process.versions.electron ?? "none") +
                " commands=" + String(scope.commands !== undefined) +
                "\n",
        );
    } catch {
        // 标记失败不影响插件本身。
    }
}

//#region 「重启完成后回一句」用的待办文件
//
// 时序跨进程边界：/rst 发生在**旧** Host 里，回话发生在**新** Host 里，
// 中间隔着一次进程死亡。所以用一个小 JSON 文件把「哪个会话在等这条回话」交接过去：
// 旧 Host 动手前写 pending.json，新 Host 启动后读到它，就往那个会话追加一条回执。

function stateDir() {
    return join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? homedir(), "dsh-rst");
}

function pendingPath() {
    return join(stateDir(), "pending.json");
}

/** 旧 Host 在动手前调用：记下"这次重启是为了哪个会话"。 */
function writePending(pending) {
    try {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(pendingPath(), JSON.stringify(pending), "utf8");
    } catch {
        // 写不进去只是少了那条回执，不能拦着重启本身。
    }
}

function readPending() {
    try {
        const parsed = JSON.parse(readFileSync(pendingPath(), "utf8"));
        return typeof parsed?.sessionId === "string" ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function clearPending() {
    try {
        rmSync(pendingPath(), { force: true });
    } catch {
        // 清不掉就下次覆盖。
    }
}

/**
 * 新 Host 启动后调用：等目标会话被恢复成活会话（用户可能还停在别的会话上），
 * 然后往它的日志里追加一对 command/run + command/done。
 *
 * 为什么只能写命令卡片：这是「系统回执」而不是模型发言，客户端把它渲染成一条
 * 斜杠命令结果，正好是"系统告诉你重启完成"的语义。而 assistant/message 要么因为
 * source 缺少 producer-owned 的 kind 让整份日志读不出来，要么因为插件插的合成回合
 * 与 agent 在 resume 时固化下来的回合计数撞号（`turn/start does not open the
 * expected turn`）—— 两种都会把会话历史写死，所以不能碰。
 */
function logAnnounce(message) {
    try {
        mkdirSync(stateDir(), { recursive: true });
        appendFileSync(join(stateDir(), "announce.log"), new Date().toISOString() + " pid=" + String(process.pid) + " " + message + "\n");
    } catch {
        // 日志写不进去不影响回执本身。
    }
}

/** 拿到 sessions 服务：优先 ctx.get()，退化到属性访问；两条路都可能因为"服务还没挂上"而落空。 */
function resolveSessions(ctx) {
    try {
        if (typeof ctx?.get === "function") {
            const viaGet = ctx.get("sessions");
            if (viaGet !== undefined && viaGet !== null) return viaGet;
        }
    } catch {
        // 某些 Context 实现对未注册的服务访问会抛错，忽略后走属性访问。
    }
    try {
        return ctx?.sessions;
    } catch {
        return undefined;
    }
}

/** 排障用：当前活着的会话 id 列表。 */
function liveSessionIds(sessions) {
    try {
        return sessions
            .list()
            .map((session) => session?.id ?? "?")
            .slice(0, 8);
    } catch {
        return [];
    }
}

async function announceRestart(ctx) {
    const pending = readPending();
    if (pending === undefined) return;
    logAnnounce("start: waiting for " + pending.sessionId + " since " + new Date(Number(pending.startedAt ?? Date.now())).toISOString());
    const deadline = Date.now() + 180_000;
    let attempt = 0;
    while (Date.now() < deadline) {
        attempt += 1;
        const sessions = resolveSessions(ctx);
        if (sessions === undefined || typeof sessions.get !== "function") {
            if (attempt === 1 || attempt % 20 === 0) logAnnounce("sessions service not resolvable (attempt " + String(attempt) + ")");
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            continue;
        }
        const session = sessions.get(pending.sessionId);
        if (session === undefined && (attempt === 1 || attempt % 10 === 0)) {
            logAnnounce("attempt " + String(attempt) + ": not live yet; live=" + JSON.stringify(liveSessionIds(sessions)));
        }
        if (session !== undefined && typeof session.append === "function") {
            const elapsed = ((Date.now() - Number(pending.startedAt ?? Date.now())) / 1000).toFixed(1);
            const text =
                "已重启完成：DSH 已经带着新配置回到这个会话（用时 " + elapsed + " 秒，新 Host PID " + String(process.pid) + "）。";
            // 只写命令卡片（command/run + command/done），绝不伪造 assistant/message，
            // 也不往日志里插合成回合。原因（两次踩坑）：
            //   1) assistant/message 的 source 必须是 {kind:"model", provider, model}，
            //      少了 kind 会让整份日志读不出来（producer-owned source kind）；
            //   2) 就算补齐 source、再补一个 turn/start…turn/end 的合成回合，仍然会撞号：
            //      agent 的回合计数器在 resume 时就固化成 lastTurn 了，插件之后往日志里插
            //      turn/start{N} 不会被它感知，用户下一条消息它照样开 turn/start{N}，
            //      读取校验于是报 `turn/start does not open the expected turn`。
            // 命令卡片不影响任何回合状态，是这里唯一安全的回执形态。
            try {
                const commandId = "cmd-rst-" + String(Date.now());
                session.append("command/run", { commandId, name: "rst", args: "", source: { kind: "user" } });
                session.append("command/done", { commandId, kind: "success", text });
                clearPending();
                logAnnounce("appended command card to " + pending.sessionId + " on attempt " + String(attempt));
            } catch (error) {
                // 追加失败就留着 pending.json，下次启动再试。
                logAnnounce("append failed: " + (error instanceof Error ? error.message : String(error)));
            }
            return;
        }
        await new Promise((resolve) => {
            setTimeout(resolve, 500);
        });
    }
    logAnnounce("timeout: " + pending.sessionId + " never became live");
}
//#endregion

/** Web 端口：重启前要确认它已经释放，否则新实例起不来。 */
function webPort() {
    const match = /:(\d+)/u.exec(process.env.DSH_WEB_URL ?? "");
    return match === null ? 0 : Number.parseInt(match[1], 10);
}

/** 给 PowerShell 的 -ExeArgs 拼命令行：只处理"含空白/引号"这一种情况。 */
function quoteArgument(value) {
    if (value === "") return '""';
    if (!/[\s"]/u.test(value)) return value;
    return '"' + value.replace(/"/gu, '\\"') + '"';
}

/**
 * 算出这次重启要做什么。
 * @returns {{ok: true, mode: "desktop"|"cli", exe: string, workDir: string, exeArgs: string,
 *            shellPid: number, hostPid: number, graceMs: number, logPath: string}
 *          | {ok: false, reason: string}}
 */
function buildPlan() {
    const logPath = logFilePath();
    const port = webPort();
    if (isDesktopHost()) {
        const exe = process.execPath;
        if (!existsSync(exe)) {
            return { ok: false, reason: "找不到 DSH 可执行文件：" + exe };
        }
        return {
            ok: true,
            mode: "desktop",
            exe,
            workDir: dirname(exe),
            exeArgs: "",
            shellPid: process.ppid,
            hostPid: process.pid,
            port,
            graceMs: DEFAULT_GRACE_MS,
            delayMs: DEFAULT_DELAY_MS,
            logPath,
        };
    }
    // 非桌面版（dsh web / dsh tui 跑在终端里）：没有外壳可杀，只能"自己退场 + 重新拉起同一个命令行"。
    const entry = process.argv[1];
    if (entry === undefined || entry === "") {
        return { ok: false, reason: "无法判断 DSH 的启动方式（argv[1] 为空），请手动重启" };
    }
    return {
        ok: true,
        mode: "cli",
        exe: process.execPath,
        workDir: process.cwd(),
        exeArgs: process.argv.slice(1).map(quoteArgument).join(" "),
        shellPid: 0,
        hostPid: process.pid,
        port,
        graceMs: 0,
        delayMs: DEFAULT_DELAY_MS,
        logPath,
    };
}

function describePlan(plan) {
    if (plan.mode === "desktop") {
        return [
            "/rst 计划（--dry-run，未执行）",
            "模式：桌面版 —— 先等 2 s，再请外壳正常退出，2 s 未退则强杀，最后由独立启动器重新拉起",
            "外壳 PID：" + String(plan.shellPid) + "（Electron 主进程）",
            "Host PID：" + String(plan.hostPid),
            "Web 端口：" + (plan.port > 0 ? String(plan.port) : "（未探测到）"),
            "可执行文件：" + plan.exe,
            "日志：" + plan.logPath,
        ].join("\n");
    }
    return [
        "/rst 计划（--dry-run，未执行）",
        "模式：命令行版 —— 本进程退场后，用同样的命令行重新拉起",
        "Host PID：" + String(plan.hostPid),
        "可执行文件：" + plan.exe + " " + plan.exeArgs,
        "工作目录：" + plan.workDir,
        "日志：" + plan.logPath,
    ].join("\n");
}

/** Host 侧痕迹：写 %LOCALAPPDATA%\dsh-rst\host-trace.log，用来区分「命令没进来」和「启动器没起来」。 */
function traceHost(message) {
    try {
        const dir = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? homedir(), "dsh-rst");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "host-trace.log"), new Date().toISOString() + " " + message + "\n");
    } catch {
        // 痕迹写不进去不影响主流程。
    }
}

/**
 * 把启动器派出去。
 * 用 process.execPath + ELECTRON_RUN_AS_NODE=1 跑 relaunch.cjs ——
 * 这是 DSH 自己派生子进程的同款路径，不依赖 PATH / 执行策略。
 * 会短暂等一下 'spawn' 事件：真正派不出去时要把错误回给用户，而不是假报成功。
 */
async function launchHelper(plan) {
    if (!existsSync(HELPER_SCRIPT)) {
        return { ok: false, reason: "找不到重启器脚本：" + HELPER_SCRIPT };
    }
    const argv = [
        HELPER_SCRIPT,
        "--shell", String(plan.shellPid),
        "--host", String(plan.hostPid),
        "--exe", plan.exe,
        "--workdir", plan.workDir,
        "--log", plan.logPath,
        "--delay", String(plan.delayMs),
        "--grace", String(plan.graceMs),
    ];
    if (plan.port > 0) argv.push("--port", String(plan.port));
    if (plan.exeArgs !== "") argv.push("--exeargs", plan.exeArgs);
    traceHost("launchHelper: exe=" + process.execPath + " argv=" + JSON.stringify(argv));
    const child = spawn(process.execPath, argv, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        cwd: plan.workDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        child.once("spawn", () => finish({ ok: true, pid: child.pid }));
        child.once("error", (error) => finish({ ok: false, reason: "启动重启器失败：" + error.message }));
        setTimeout(() => finish({ ok: true, pid: child.pid, unconfirmed: true }), 1500);
    });
    child.unref();
    traceHost("launchHelper outcome: " + JSON.stringify(outcome));
    return outcome;
}

/**
 * 每次 /rst 被唤起都留一行痕迹（成功、失败、dry-run 都写）。
 * 排障用：有这个文件 = 命令确实被调用过，raw 里是用户敲的原始参数。
 */
function traceInvocation(invocation) {
    try {
        const dir = join(process.env.LOCALAPPDATA ?? process.env.TEMP ?? homedir(), "dsh-rst");
        mkdirSync(dir, { recursive: true });
        appendFileSync(
            join(dir, "invocations.log"),
            new Date().toISOString() +
                " pid=" + String(process.pid) +
                " raw=" + JSON.stringify(String(invocation?.rawInput ?? "")) +
                " keys=" + Object.keys(invocation ?? {}).join(",") +
                "\n",
        );
    } catch {
        // 痕迹写不进去也不影响命令本身。
    }
}

/**
 * 从命令调用里取出这次 /rst 发生在哪个会话。
 * dsh-commands 交过来的 invocation 形如 { commandId, agent, rawInput, attachments, signal }，
 * 其中 agent.session 就是实时 Session（dsh-session 的 SessionStore 用 session.id 索引）。
 */
function sessionIdOf(invocation) {
    const agent = invocation?.agent;
    const session = agent?.session;
    const id = session?.id ?? agent?.sessionId;
    return typeof id === "string" ? id : "";
}

let messageTriggerAt = 0;

/** 从事件里尽力取出用户文本（content 可能是字符串，也可能是若干 part）。 */
function messageTextOf(event) {
    const data = event?.data;
    const candidates = [
        data?.content,
        data?.message?.content,
        data?.text,
        data?.message?.text,
        data?.prompt,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
        if (Array.isArray(candidate)) {
            const text = candidate
                .map((part) => (part !== null && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
                .join("");
            if (text.trim() !== "") return text;
        }
    }
    return "";
}

/** 这条会话事件是不是用户发来的 /rst？（只在没走命令分发时兜底） */
function isRestartText(event) {
    if (event === null || typeof event !== "object" || typeof event.type !== "string") return false;
    if (!/user/i.test(event.type)) return false;
    return /^\/rst(\s|$)/u.test(messageTextOf(event).trim());
}

/**
 * 兜底通道：某些前端（IM 机器人）不把 "/rst" 交给命令分发器，而是当普通消息塞进会话。
 * 监听全局 session/event，一旦看到用户消息就是 /rst，就按 /rst 处理。
 * 命令分发那条路不会产生 user/message，所以两条路不会互相抢。
 */
async function triggerFromMessage(scope, session) {
    const now = Date.now();
    if (now - messageTriggerAt < 5000) return;
    messageTriggerAt = now;
    traceHost("message-trigger: /rst seen as plain message, session=" + String(session?.id));
    const plan = buildPlan();
    if (!plan.ok) {
        logAnnounce("message-trigger aborted: " + plan.reason);
        return;
    }
    const launched = await launchHelper(plan);
    if (!launched.ok) {
        logAnnounce("message-trigger launch failed: " + launched.reason);
        return;
    }
    if (typeof session?.id === "string" && session.id !== "") {
        writePending({ sessionId: session.id, startedAt: Date.now(), shellPid: plan.shellPid, hostPid: plan.hostPid });
    }
    logAnnounce("message-trigger launched pid=" + String(launched.pid) + " session=" + String(session?.id));
    if (plan.mode === "cli") setTimeout(() => { process.exit(0); }, 800).unref?.();
}

function subscribeRestartText(scope) {
    if (typeof scope.on !== "function") return;
    try {
        scope.on("session/event", (session, event) => {
            try {
                if (isRestartText(event)) void triggerFromMessage(scope, session);
            } catch {
                // 兜底通道自己出错不能影响回合。
            }
        }, { global: true });
    } catch {
        // 订阅不上就退回纯命令通道。
    }
}

function register(ctx) {
    markLoaded(ctx);
    const commands = ctx.commands;
    if (commands === undefined || typeof commands.register !== "function") return;
    commands.register({
        definitionId: "dsh-rst/rst",
        name: "rst",
        description: "重启 DSH：由独立启动器送走当前进程并重新拉起（桌面版会重开整个应用），加 --dry-run 只看计划",
        input: { hint: "[--dry-run]" },
        handler: async (invocation) => {
            traceInvocation(invocation);
            try {
                const plan = buildPlan();
                if (!plan.ok) return { kind: "error", text: plan.reason };
                if (/(^|\s)--dry-run(\s|$)/u.test(invocation.rawInput ?? "")) {
                    return { kind: "success", text: describePlan(plan) };
                }
                const launched = await launchHelper(plan);
                if (!launched.ok) {
                    clearPending();
                    return { kind: "error", text: launched.reason };
                }
                // 派成功之后才登记待办：新 Host 启动时凭它回到这个会话回一句"已重启"。
                const sessionId = sessionIdOf(invocation);
                if (sessionId !== "") {
                    writePending({
                        sessionId,
                        startedAt: Date.now(),
                        shellPid: plan.shellPid,
                        hostPid: plan.hostPid,
                    });
                }
                if (plan.mode === "cli") {
                    // 命令行版没有外壳来杀我们：自己退场，好让新进程抢到端口。
                    setTimeout(() => { process.exit(0); }, 800).unref?.();
                }
                return {
                    kind: "success",
                    text: [
                        "正在重启 DSH…（约 3–5 秒后自己回来）",
                        "· 重启器 PID：" + String(launched.pid),
                        "· 日志：" + plan.logPath,
                        "· 回到这个会话后会再回一条「已重启」",
                        "· 正在运行的回合会被打断；如果 10 秒后没回来，看上面的日志",
                    ].join("\n"),
                };
            } catch (error) {
                return { kind: "error", text: "重启失败：" + (error instanceof Error ? error.message : String(error)) };
            }
        },
    });
}

let announceStarted = false;

/** 回执只跑一次：inject 回调和兜底定时器都调它，先到先得。 */
function startAnnounce(ctx) {
    if (announceStarted) return;
    announceStarted = true;
    announceRestart(ctx).catch(() => {
        // 回执是锦上添花，失败不影响插件其它功能。
    });
}

export function apply(ctx) {
    // 两个可选服务各走各的 inject：
    //   commands —— 没它就没 /rst，插件整体退化成空操作；
    //   sessions —— 回执要用它找会话。用 inject 而不是 apply 时直接 ctx.get()，
    //               是因为插件加载那一刻 sessions 服务可能还没挂上：inject 会等到它可用再回调。
    if (typeof ctx.inject === "function") {
        ctx.inject(["sessions"], (scope) => {
            startAnnounce(scope);
            subscribeRestartText(scope);
        });
        ctx.inject(["commands"], (scope) => {
            register(scope);
        });
        // 兜底：inject 若因故没回调，15 秒后拿原始 ctx 再试一次（服务已挂上就能用属性访问拿到）。
        setTimeout(() => {
            startAnnounce(ctx);
        }, 15_000).unref?.();
        return;
    }
    // 老版本 cordis：没有 inject，退化成直接调用。
    startAnnounce(ctx);
    register(ctx);
}
