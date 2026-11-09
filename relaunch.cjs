/**
 * dsh-rst relauncher —— 纯 Node 实现（不经过 PowerShell）。
 *
 * 由 index.js 以 detached 方式拉起来，环境里带 ELECTRON_RUN_AS_NODE=1，
 * 所以 process.execPath（DeepSeek Harness.exe）在这里就是个普通 node）。
 *
 * 为什么从 .ps1 改成 .cjs：
 *   从 Host 里 spawn powershell.exe 这条路实测没有任何日志落地，既不能证明
 *   启动了、也不能证明失败在哪。Node 是 DSH 自己就在用的运行时，不依赖
 *   PATH、不依赖执行策略、不依赖 5.1 的 ANSI 编码。
 *
 * 时序（v0.3.0 起和「手动关闭 DSH」对齐：旧引擎先 flush 退场，再拉起新实例）：
 *   1. 安全闸：核对 shellPid 的映像名 == 目标 exe 的文件名（与下面的等待并行跑，
 *      所以它慢也不会拖长重启时间）；不符就 abort，什么都不杀
 *   2. 等 delay 毫秒（让命令回执落盘、界面刷出来）
 *   3. taskkill /PID <shell>（不带 /F = WM_CLOSE，请它正常退出）
 *   4. grace 毫秒后还没退 → taskkill /F
 *   5. 确认 Host PID 也没了（端口和单实例锁都在它手里）
 *   6. 等所有登记端口释放：Web 端口 + bili 引擎端口（--waitports）。
 *      旧 bili 引擎是 Host 的子进程，Host 死后它要等 watchdog 发现 parent-gone
 *      才会 flush 并退出（实测约 10 秒）。这一步最多等 --enginewait 毫秒；
 *      不等的话，新实例会和仍持有端口的旧引擎重叠，插件 attach 会失败，
 *      该会话的压缩就再也不会接管（bili #5408）。这是 v0.3.0 的核心修复。
 *   7. 用同一个 exe 拉起新实例（**必须剥掉 ELECTRON_RUN_AS_NODE**，
 *      否则起来的会是 node 而不是 GUI）；CLI 模式把 --exeargs 原样带上。
 *   8. 确认新进程活着，收工
 *
 * 性能约定：全程不用 spawnSync，避免被 tasklist/taskkill 的启动开销串行卡住。
 */

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const TASKKILL = path.join(SYSTEM_ROOT, "System32", "taskkill.exe");
const TASKLIST = path.join(SYSTEM_ROOT, "System32", "tasklist.exe");

/** @type {Record<string,string>} */
const args = {};
{
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith("--")) continue;
        args[key.slice(2)] = argv[i + 1] ?? "";
        i += 1;
    }
}

const logPath = args.log || path.join(process.env.TEMP || SYSTEM_ROOT, "dsh-rst-relaunch.log");

function log(message) {
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, "[" + new Date().toISOString() + "] " + message + "\n");
    } catch {
        // 日志写不进去也要继续。
    }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function numberArg(name, fallback) {
    const value = Number.parseInt(args[name] ?? "", 10);
    return Number.isFinite(value) ? value : fallback;
}

function isAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

/** 跑一个短命命令并收 stdout（异步，不阻塞事件循环）。 */
function run(file, argv) {
    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const child = spawn(file, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
        child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

async function imageName(pid) {
    const result = await run(TASKLIST, ["/FI", "PID eq " + String(pid), "/FO", "CSV", "/NH"]);
    const first = String(result.stdout ?? "").trim().split(/\r?\n/u)[0] ?? "";
    const match = /^"([^"]*)"/u.exec(first);
    return match === null ? "" : match[1];
}

async function kill(pid, force) {
    const argv = force ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)];
    const result = await run(TASKKILL, argv);
    log("taskkill " + argv.join(" ") + " -> exit=" + String(result.code));
    return result.code === 0;
}

function portOpen(port) {
    return new Promise((resolve) => {
        if (!port) {
            resolve(false);
            return;
        }
        const socket = net.connect({ port, host: "127.0.0.1" });
        const finish = (value) => {
            try { socket.destroy(); } catch { /* ignore */ }
            resolve(value);
        };
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(400, () => finish(false));
    });
}

/**
 * 要等它释放的端口：Web 端口（--port）+ bili 引擎端口（--waitports，逗号分隔）。
 * 去重、排序，避免重复探测。
 */
function waitPortsOf() {
    const ports = new Set();
    const web = numberArg("port", 0);
    if (web > 0) ports.add(web);
    for (const raw of String(args.waitports ?? "").split(",")) {
        const port = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(port) && port > 0) ports.add(port);
    }
    return [...ports];
}

/**
 * 等一组端口全部释放。旧 bili 引擎收到 parent-gone 后要先 flush 再退出，
 * 这一步就是给它时间；端口关了 = 引擎走了。
 * @returns {Promise<{ok: boolean, stillOpen: number[]}>}
 */
async function waitPortsFree(ports, budgetMs) {
    if (ports.length === 0) return { ok: true, stillOpen: [] };
    const deadline = Date.now() + budgetMs;
    const pending = new Set(ports);
    for (const port of ports) log("waiting for port " + String(port) + " to close");
    while (Date.now() < deadline) {
        for (const port of [...pending]) {
            if (!(await portOpen(port))) {
                pending.delete(port);
                log("port " + String(port) + " closed");
            }
        }
        if (pending.size === 0) return { ok: true, stillOpen: [] };
        await sleep(500);
    }
    return { ok: false, stillOpen: [...pending] };
}

/** 把带引号的参数字符串拆回数组（只处理 "..." 与空白，够用且不引入依赖）。 */
function splitArgString(text) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/gu;
    let match;
    while ((match = re.exec(text)) !== null) out.push(match[1] !== undefined ? match[1] : match[2]);
    return out;
}

/**
 * 拉起新实例：ELECTRON_RUN_AS_NODE 必须摘掉，否则起来的不是 GUI。
 * CLI 模式下把原命令行参数带上，否则新进程不知道要跑哪个入口。
 */
function launchApp(exe, workDir, exeArgs) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve) => {
        const child = spawn(exe, exeArgs, {
            detached: true,
            stdio: "ignore",
            windowsHide: false,
            cwd: workDir,
            env,
        });
        child.once("spawn", () => resolve({ ok: true, pid: child.pid }));
        child.once("error", (error) => resolve({ ok: false, reason: error.message }));
        child.unref();
    });
}

async function main() {
    const shellPid = numberArg("shell", 0);
    const hostPid = numberArg("host", 0);
    const exe = args.exe ?? "";
    const workDir = args.workdir || path.dirname(exe);
    const delayMs = numberArg("delay", 2000);
    const graceMs = numberArg("grace", 5000);
    const engineWaitMs = numberArg("enginewait", 30000);
    const exeArgs = splitArgString(args.exeargs ?? "");
    const ports = waitPortsOf();

    log("start: helper=" + String(process.pid) + " shell=" + String(shellPid) + " host=" + String(hostPid) + " exe=" + exe + " ports=" + JSON.stringify(ports) + " delay=" + String(delayMs) + " grace=" + String(graceMs) + " enginewait=" + String(engineWaitMs));

    if (!exe || !fs.existsSync(exe)) {
        log("abort: exe not found: " + exe);
        return;
    }

    const expected = path.basename(exe).toLowerCase();

    // 安全闸与等待并行：tasklist 本身有启动开销，不该让它拖长重启时间。
    const gate = (async () => {
        if (shellPid <= 0) return true;
        const actual = await imageName(shellPid);
        const ok = actual.toLowerCase() === expected;
        log("gate: shell " + String(shellPid) + " image=\"" + actual + "\" expected=\"" + expected + "\" -> " + (ok ? "ok" : "mismatch"));
        return ok;
    })();

    if (delayMs > 0) {
        log("waiting " + String(delayMs) + "ms before teardown");
        await sleep(delayMs);
    }
    if (!(await gate)) {
        log("abort: shell pid " + String(shellPid) + " is not " + exe);
        return;
    }

    // 先请外壳正常退出：WM_CLOSE，给应用自己退场的机会（和用户点关闭同一条路径）。
    if (shellPid > 0 && isAlive(shellPid)) {
        await kill(shellPid, false);
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline && isAlive(shellPid)) {
            await sleep(100);
        }
        if (isAlive(shellPid)) {
            log("graceful close timed out after " + String(graceMs) + "ms, forcing");
            await kill(shellPid, true);
        }
    }

    if (hostPid > 0) {
        // Host 手里握着 Web 端口和单实例锁：多给它一点时间自己退，别一上来就 /F。
        const hostDeadline = Date.now() + Math.max(graceMs, 10000);
        while (Date.now() < hostDeadline && isAlive(hostPid)) {
            await sleep(150);
        }
        if (isAlive(hostPid)) {
            log("host still alive after wait, forcing");
            await kill(hostPid, true);
        }
    }

    // 关键一步：等 Web 端口 + bili 引擎端口都释放，再拉起新实例。
    // 旧引擎要先 flush 才能退出；如果不等，新实例会和旧引擎抢端口，
    // 插件 attach 失败后该会话的压缩不会接管（bili #5408）。
    const freed = await waitPortsFree(ports, engineWaitMs);
    if (!freed.ok) {
        log("warn: ports still open after " + String(engineWaitMs) + "ms: " + JSON.stringify(freed.stillOpen) + " — launching anyway (old engine may still be flushing)");
    } else if (ports.length > 0) {
        log("all ports free after teardown");
    }

    log("launching " + exe + " (cwd=" + workDir + (exeArgs.length > 0 ? " args=" + JSON.stringify(exeArgs) : "") + ")");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const launched = await launchApp(exe, workDir, exeArgs);
        if (!launched.ok) {
            log("attempt " + String(attempt) + ": launch error: " + launched.reason);
            await sleep(800);
            continue;
        }
        await sleep(1000);
        const alive = isAlive(launched.pid);
        log("attempt " + String(attempt) + ": pid=" + String(launched.pid) + " alive=" + String(alive));
        if (alive) {
            log("done: new instance running");
            return;
        }
        await sleep(800);
    }
    log("failed: could not bring the app back up");
}

main().catch((error) => {
    log("fatal: " + (error && error.stack ? error.stack : String(error)));
});
