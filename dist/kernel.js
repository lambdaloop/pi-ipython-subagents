// One persistent ipykernel per Pi session over ZMQ.
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Dealer, Subscriber } from "zeromq";
const PROTOCOL_VERSION = "5.3";
const DELIM = Buffer.from("<IDS|MSG>");
const HOST_TARGET = "pi-rlm-runtime.host";
const PORTS_RESOLVE_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;
const IOPUB_SUBSCRIBE_DELAY_MS = 50;
const INTERRUPT_GRACE_MS = 1_000;
const INTERRUPT_REUSE_TIMEOUT_MS = 5_000;
const INTERRUPT_RETRY_MS = 500;
const HOST_REQUEST_CLOSE_TIMEOUT_MS = 5_000;
const GRACEFUL_SHUTDOWN_MS = 200;
const PROCESS_EXIT_TIMEOUT_MS = 1_000;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const TRUNCATED = "\n… output truncated …";
const TRUNCATED_BYTES = Buffer.byteLength(TRUNCATED);
export const BOOTSTRAP = `%colors NoColor
from pi_rlm_runtime import agent_message, bg, rg_files, rg_search, rlm`;
export function retainExecutionOwner(owners, requestMsgId) {
    for (const [id, owner] of owners) {
        if (id === requestMsgId)
            continue;
        owner.controller.abort();
        owners.delete(id);
    }
}
export function createKernelRuntime(options) {
    const environments = discoverKernelEnvironments(options.cwd);
    const baseEnv = {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
    };
    const shims = new Map();
    const runtime = {
        cwd: options.cwd,
        command: "uv",
        commandArgs: [],
        kernelEnv: baseEnv,
        runtimeDir: options.runtimeDir,
        environments,
        active: environments[0].name,
        activeSpec: environments[0],
        startupNote: undefined,
        startupFallbackEnvironment: undefined,
        /** Environment names, in listing order. */
        names() {
            return environments.map((environment) => environment.name);
        },
        find(name) {
            return environments.find((environment) => environment.name === name);
        },
        /**
         * Point the next kernel at one environment. A pixi environment keeps the
         * project's own interpreter and reaches ipykernel through a uv-managed
         * shim when the environment does not ship one.
         */
        apply(spec) {
            const extraPaths = [];
            if (spec.kind === "pixi") {
                let shim = shims.get(spec.python);
                if (shim === undefined) {
                    shim = "";
                    if (!probePython(spec.python).ok) {
                        const version = spec.version ?? pythonVersion(spec.python);
                        if (!version)
                            throw new Error(`Could not detect the Python version of ${spec.python}`);
                        spec.version = version;
                        shim = ensureIpykernelShim(version);
                    }
                    shims.set(spec.python, shim);
                }
                if (shim)
                    extraPaths.push(shim);
            }
            this.active = spec.name;
            this.activeSpec = spec;
            this.cwd = spec.cwd;
            // Pixi's launcher can take many seconds to resolve an already
            // materialized environment. The environment's interpreter is
            // self-contained, so launch it directly after the Pixi smoke test.
            this.command = spec.kind === "pixi" ? spec.python : spec.command;
            this.commandArgs = spec.kind === "pixi" ? [] : [...spec.commandArgs];
            this.kernelEnv = {
                ...baseEnv,
                PYTHONPATH: [options.runtimeDir, ...extraPaths, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
            };
        },
        /** Human-readable summary of one environment, including its ipykernel source. */
        describe(spec) {
            const active = spec.name === this.active ? " (active)" : "";
            const lines = [`${spec.name} — ${spec.label}${active}`];
            lines.push(`    ${spec.detail}`);
            if (spec.name === this.active && spec.name === this.startupFallbackEnvironment && this.startupNote)
                lines.push(`    startup: ${this.startupNote}`);
            if (spec.kind === "pixi") {
                if (probePython(spec.python).ok) {
                    lines.push("    ipykernel: provided by the environment");
                }
                else {
                    const version = spec.version ?? pythonVersion(spec.python);
                    const shim = shims.get(spec.python);
                    lines.push(`    ipykernel: uv shim (${IPYKERNEL_SPEC}${version ? ` for Python ${version}` : ""})${shim ? " — ready" : " — created on first use"}`);
                }
            }
            return lines;
        },
    };
    const configured = environments.find((environment) => environment.kind === "python");
    if (configured) {
        // An explicit interpreter is an authority decision; never silently
        // replace it with Pixi or uv.
        runtime.apply(configured);
    }
    else {
        const pixi = environments.find((environment) => environment.kind === "pixi");
        const uv = environments.find((environment) => environment.kind === "uv");
        if (pixi && uv) {
            try {
                runtime.apply(pixi);
                const check = verifyKernelEnvironment(pixi, runtime.kernelEnv);
                if (!check.ok)
                    throw new Error(check.detail || "the environment could not import ipykernel");
            }
            catch (error) {
                runtime.startupNote = `Pixi was unavailable (${error instanceof Error ? error.message : String(error)}); using uv`;
                runtime.startupFallbackEnvironment = uv.name;
                runtime.apply(uv);
            }
        }
        else if (uv) {
            runtime.startupNote = "No materialized Pixi environment was found; using uv";
            runtime.startupFallbackEnvironment = uv.name;
            runtime.apply(uv);
        }
        else {
            runtime.apply(environments[0]);
        }
    }
    return runtime;
}
// ---- kernel environments -------------------------------------------------
const IPYKERNEL_SPEC = "ipykernel==7.2.0";
const KERNEL_CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-rlm-runtime");
const PROBE_TIMEOUT_MS = 60_000;
function runProcess(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        env: options.env ?? process.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return { ok: result.status === 0 && !result.error, output, error: result.error?.message };
}
function probePython(python) {
    return runProcess(python, ["-c", "import ipykernel"]);
}
/**
 * Smoke-test an environment exactly the way the kernel will start, so a broken
 * environment fails at switch time instead of mid-cell. The uv fallback always
 * provides ipykernel, so it is not probed.
 */
export function verifyKernelEnvironment(spec, env) {
    if (!spec || spec.kind === "uv")
        return { ok: true };
    const result = runProcess(spec.command, [...spec.commandArgs, "-c", "import ipykernel"], {
        env,
        cwd: spec.cwd,
    });
    return { ok: result.ok, detail: result.error ?? result.output };
}
function pythonVersion(python) {
    const result = runProcess(python, ["-c", "import sys;print('%d.%d' % sys.version_info[:2])"]);
    return result.ok ? result.output.trim() || undefined : undefined;
}
function shimRoot(version) {
    return join(KERNEL_CACHE_DIR, `ipykernel-py${version}`);
}
function shimSitePackages(version) {
    return join(shimRoot(version), "lib", `python${version}`, "site-packages");
}
/** A uv-managed ipykernel for a project interpreter that does not ship one. */
function ensureIpykernelShim(version) {
    const root = shimRoot(version);
    const sitePackages = shimSitePackages(version);
    if (existsSync(sitePackages))
        return sitePackages;
    const venv = runProcess("uv", ["venv", "--python", version, root]);
    if (!venv.ok)
        throw new Error(`Could not create an ipykernel ${version} shim with uv: ${venv.error ?? venv.output}`);
    const install = runProcess("uv", ["pip", "install", "--python", join(root, "bin", "python"), IPYKERNEL_SPEC]);
    if (!install.ok)
        throw new Error(`Could not install ${IPYKERNEL_SPEC}: ${install.error ?? install.output}`);
    return sitePackages;
}
function looksLikePixiProject(dir) {
    if (existsSync(join(dir, "pixi.toml")))
        return true;
    const manifest = join(dir, "pyproject.toml");
    if (!existsSync(manifest))
        return false;
    try {
        return /^\[tool\.pixi/m.test(readFileSync(manifest, "utf8"));
    }
    catch {
        return false;
    }
}
/** Nearest enclosing pixi project with a materialised environment, if any. */
function findPixiProject(cwd) {
    let dir = cwd;
    for (;;) {
        if (looksLikePixiProject(dir)) {
            const envsDir = join(dir, ".pixi", "envs");
            let names = [];
            if (existsSync(envsDir)) {
                try {
                    names = readdirSync(envsDir).filter((name) => existsSync(join(envsDir, name, "bin", "python")));
                }
                catch {
                    names = [];
                }
            }
            if (!names.length)
                return undefined;
            const preferred = process.env.PIXI_ENVIRONMENT_NAME;
            const environment = preferred && names.includes(preferred) ? preferred : names.includes("default") ? "default" : names[0];
            return { root: dir, environment, python: join(envsDir, environment, "bin", "python") };
        }
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
function discoverKernelEnvironments(cwd) {
    const environments = [];
    const configured = process.env.PI_RLM_RUNTIME_PYTHON;
    if (configured) {
        if (!isAbsolute(configured))
            throw new Error("PI_RLM_RUNTIME_PYTHON must be an absolute path");
        environments.push({
            name: "python",
            label: "PI_RLM_RUNTIME_PYTHON",
            detail: configured,
            kind: "python",
            command: configured,
            commandArgs: [],
            cwd,
            python: configured,
        });
    }
    environments.push({
        name: "uv",
        label: "isolated uv environment",
        detail: `uv run --python 3.11 --with ${IPYKERNEL_SPEC}`,
        kind: "uv",
        command: "uv",
        commandArgs: ["run", "--quiet", "--no-project", "--python", "3.11", "--with", IPYKERNEL_SPEC, "python"],
        cwd,
    });
    const pixi = findPixiProject(cwd);
    if (pixi) {
        environments.push({
            name: "pixi",
            label: `project environment ${pixi.environment}`,
            detail: `${pixi.python}`,
            kind: "pixi",
            command: "pixi",
            commandArgs: ["run", "--manifest-path", pixi.root, "--environment", pixi.environment, "python"],
            cwd: pixi.root,
            projectRoot: pixi.root,
            environment: pixi.environment,
            python: pixi.python,
        });
    }
    return environments;
}
/** One persistent IPython kernel for one Pi session. */
export class SessionKernel {
    shell;
    iopub;
    control;
    connection;
    tempDir;
    kernel;
    iopubPump;
    startPromise;
    closePromise;
    disposePromise;
    shellReply = Promise.resolve();
    controlQueue = Promise.resolve();
    interruptPromise;
    sequence = Promise.resolve();
    active;
    executionOwners = new Map();
    hostComms = new Map();
    hostRequests = new Set();
    session = randomUUID();
    username = "pi-rlm-runtime";
    kernelStderr = "";
    closed = false;
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
    }
    execute(code, host, signal, onUpdate, timeoutMs) {
        const run = this.sequence.then(() => this.executeCell(code, host, signal, onUpdate, timeoutMs));
        this.sequence = run.then(() => undefined, () => undefined);
        return run;
    }
    dispose() {
        this.closed = true;
        this.disposePromise ??= this.finishDispose();
        return this.disposePromise;
    }
    async finishDispose() {
        const start = this.startPromise;
        await this.closeKernel(new Error("IPython kernel shut down"));
        await start?.catch(() => undefined);
        await this.closeKernel(new Error("IPython kernel shut down"));
    }
    async executeCell(code, host, signal, onUpdate, timeoutMs) {
        if (this.closed)
            throw new Error("IPython kernel is closed");
        if (Buffer.byteLength(code) > MAX_CODE_BYTES)
            throw new Error("IPython cell is larger than 256 KiB");
        if (signal?.aborted)
            throw abortError();
        await this.start();
        await this.waitForIdle(signal);
        await this.shellReply;
        if (signal?.aborted)
            throw abortError();
        if (!this.shell || !this.connection) {
            throw new Error("IPython kernel connection is unavailable");
        }
        return this.runCell(code, host, signal, onUpdate, false, timeoutMs);
    }
    async runCell(code, host, signal, onUpdate, silent, timeoutMs) {
        const conn = this.connection;
        const shell = this.shell;
        if (!conn || !shell)
            throw new Error("IPython kernel connection is unavailable");
        const started = performance.now();
        const output = new CellOutput(onUpdate);
        const controller = new AbortController();
        const msg = buildMessage("execute_request", {
            code,
            silent,
            store_history: !silent,
            user_expressions: {},
            allow_stdin: false,
            stop_on_error: true,
        }, this.session, this.username);
        const requestMsgId = msg.header.msg_id;
        let markIdle = () => { };
        const idle = new Promise((resolve) => {
            markIdle = resolve;
        });
        let abortTimer;
        let resolveResult;
        let rejectResult;
        const result = new Promise((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        const execution = {
            host,
            controller,
            requestMsgId,
            output,
            started,
            resolve: resolveResult,
            reject: rejectResult,
            settled: false,
            idle,
            markIdle,
            replySettled: false,
        };
        this.active = execution;
        this.executionOwners.set(requestMsgId, { host, controller });
        const forceAbort = () => {
            // Do not allow a delayed timer from an old execution to reset a
            // newer cell. If this execution still owns the active slot or its
            // pending shell reply, however, the kernel did not finish its
            // interrupted request within the grace period and must be
            // recreated before another cell can run.
            const ownsShellReply = execution.reply !== undefined && this.shellReply === execution.reply;
            if (this.active !== execution && !ownsShellReply)
                return;
            if (!execution.settled) {
                execution.settled = true;
                execution.reject(abortError());
            }
            void this.closeKernel(new Error("IPython kernel reset after interrupted cell")).catch(() => undefined);
        };
        const onAbort = () => {
            controller.abort();
            void this.interrupt().catch(() => undefined);
            abortTimer = setTimeout(forceAbort, INTERRUPT_GRACE_MS);
            abortTimer.unref?.();
        };
        let timedOut = false;
        const cellTimer = timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                onAbort();
            }, timeoutMs)
            : undefined;
        cellTimer?.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        // Abort may settle the cell while ZeroMQ is still applying backpressure.
        void result.catch(() => undefined);
        let sent = false;
        try {
            await shell.send(encode(msg, conn.key));
            sent = true;
            const reply = receiveExecuteReply(shell, conn.key, requestMsgId);
            this.shellReply = reply;
            execution.reply = reply;
            void reply.then(() => {
                execution.replySettled = true;
                if (abortTimer) {
                    clearTimeout(abortTimer);
                    abortTimer = undefined;
                }
            }, (error) => {
                execution.replySettled = true;
                if (abortTimer) {
                    clearTimeout(abortTimer);
                    abortTimer = undefined;
                }
                if (this.shell === shell && !this.closePromise) {
                    void this.closeKernel(new Error(`Kernel shell channel failed: ${errorMessage(error)}`));
                }
            });
            // IOPub's idle status is the execution-complete signal. The shell
            // reply is still consumed and tracked above (and the next request
            // waits for it), but waiting for a separate socket here can keep a
            // completed cell looking hung when the kernel is under load.
            return await result;
        }
        catch (error) {
            if (timedOut) {
                if (!sent && !execution.settled) {
                    this.releaseExecution(execution);
                    this.executionOwners.delete(requestMsgId);
                    controller.abort();
                    execution.settled = true;
                }
                const timeout = new Error(`IPython cell exceeded its ${Math.round(timeoutMs / 1000)}s time limit and was interrupted. Re-run with timeout_seconds=<n> for a longer cell, or start it with bg("...") for genuinely long work.`);
                timeout.name = "CellTimeout";
                throw timeout;
            }
            if (sent)
                throw error;
            if (execution.settled)
                return await result;
            this.releaseExecution(execution);
            this.executionOwners.delete(requestMsgId);
            controller.abort();
            execution.settled = true;
            throw new Error(`Failed to send execute_request: ${errorMessage(error)}`);
        }
        finally {
            // Keep the abort timer alive while the shell reply is pending.
            // The interrupt can settle `result` first, and clearing the timer
            // here would leave a stale execute_request blocking future cells.
            if (abortTimer && execution.replySettled)
                clearTimeout(abortTimer);
            if (cellTimer)
                clearTimeout(cellTimer);
            signal?.removeEventListener("abort", onAbort);
        }
    }
    async start() {
        if (this.closed)
            throw new Error("IPython kernel is closed");
        if (this.closePromise)
            await this.closePromise;
        if (this.closed)
            throw new Error("IPython kernel is closed");
        if (this.kernel && this.connection && this.shell && this.iopub && this.control)
            return;
        if (this.startPromise)
            return this.startPromise;
        const start = this.openKernel();
        this.startPromise = start;
        const clear = () => {
            if (this.startPromise === start)
                this.startPromise = undefined;
        };
        void start.then(clear, clear);
        return start;
    }
    async openKernel() {
        this.kernelStderr = "";
        const connection = makeConnection();
        this.tempDir = connection.tempDir;
        const proc = spawn(this.runtime.command, [...this.runtime.commandArgs, "-m", "ipykernel_launcher", "-f", connection.path], {
            cwd: this.runtime.cwd,
            env: this.runtime.kernelEnv,
            detached: process.platform !== "win32",
            stdio: ["ignore", "ignore", "pipe"],
        });
        this.kernel = proc;
        proc.stderr?.on("data", (buf) => {
            this.kernelStderr = `${this.kernelStderr}${buf.toString()}`.slice(-16_384);
        });
        proc.once("error", (error) => this.kernelFailed(proc, `spawn error: ${error.message}`));
        proc.once("exit", (code, signal) => this.kernelFailed(proc, `unexpected exit code=${String(code)} signal=${String(signal)}`));
        try {
            const conn = await this.waitForResolvedConnection(connection.path, proc);
            if (this.closed || this.kernel !== proc)
                throw new Error("Kernel was closed during startup");
            this.connection = conn;
            this.shell = new Dealer();
            this.iopub = new Subscriber();
            this.control = new Dealer();
            this.shell.connect(`${conn.transport}://${conn.ip}:${conn.shell_port}`);
            this.iopub.connect(`${conn.transport}://${conn.ip}:${conn.iopub_port}`);
            this.control.connect(`${conn.transport}://${conn.ip}:${conn.control_port}`);
            this.iopub.subscribe(Buffer.alloc(0));
            await sleep(IOPUB_SUBSCRIBE_DELAY_MS);
            if (this.closed || this.kernel !== proc)
                throw new Error("Kernel was closed during startup");
            this.startIopubPump();
            await this.probeReady(proc);
            // Bootstrap pi-rlm-runtime into the user namespace.
            const bootstrap = await this.runCell(BOOTSTRAP, unavailableHost, undefined, undefined, true);
            if (bootstrap.status === "error") {
                throw new Error(bootstrap.error?.evalue ?? "IPython bootstrap failed");
            }
            if (this.closed || this.kernel !== proc)
                throw new Error("Kernel was closed during startup");
        }
        catch (error) {
            await this.closeKernel(new Error(errorMessage(error)));
            throw error;
        }
    }
    kernelFailed(proc, message) {
        if (this.kernel !== proc || this.closePromise)
            return;
        this.kernelStderr += `[kernel] ${message}\n`;
        void this.closeKernel(new Error(`IPython kernel stopped.\n${this.stderrTail()}`));
    }
    startIopubPump() {
        if (this.iopubPump || !this.iopub || !this.connection)
            return;
        const iopub = this.iopub;
        const key = this.connection.key;
        const pump = (async () => {
            try {
                for await (const frames of iopub) {
                    const incoming = decode(frames, key);
                    if (!incoming)
                        continue;
                    const type = incoming.header.msg_type;
                    if (type === "comm_open" || type === "comm_msg" || type === "comm_close") {
                        this.handleComm(incoming);
                        continue;
                    }
                    this.handleExecutionMessage(incoming);
                }
            }
            catch (error) {
                if (this.iopub === iopub && !this.closePromise && !this.closed) {
                    this.kernelStderr += `[kernel] iopub pump failed: ${errorMessage(error)}\n`;
                    void this.closeKernel(new Error(`Kernel IOPub channel failed: ${errorMessage(error)}`));
                }
            }
        })();
        this.iopubPump = pump;
        const clear = () => {
            if (this.iopubPump === pump)
                this.iopubPump = undefined;
        };
        void pump.then(clear, clear);
    }
    handleExecutionMessage(incoming) {
        const active = this.active;
        const parentId = incoming.parent_header.msg_id;
        if (!active || parentId !== active.requestMsgId)
            return;
        const type = incoming.header.msg_type;
        if (type === "stream" ||
            type === "execute_result" ||
            type === "display_data" ||
            type === "update_display_data" ||
            type === "clear_output" ||
            type === "error") {
            active.output.accept({ header: { msg_type: incoming.header.msg_type }, content: incoming.content });
        }
        else if (type === "status") {
            const state = incoming.content.execution_state;
            if (state === "idle")
                this.finishExecution(active);
        }
    }
    finishExecution(execution) {
        this.releaseExecution(execution);
        if (execution.controller.signal.aborted) {
            this.executionOwners.delete(execution.requestMsgId);
        }
        else {
            retainExecutionOwner(this.executionOwners, execution.requestMsgId);
        }
        if (execution.settled)
            return;
        execution.settled = true;
        if (execution.controller.signal.aborted) {
            execution.reject(abortError());
            return;
        }
        const result = execution.output.result(performance.now() - execution.started);
        execution.resolve(result);
    }
    releaseExecution(execution) {
        if (this.active === execution)
            this.active = undefined;
        execution.markIdle();
    }
    handleComm(incoming) {
        const type = incoming.header.msg_type;
        const content = incoming.content;
        const commId = content.comm_id;
        if (typeof commId !== "string")
            return;
        if (type === "comm_close") {
            this.hostComms.delete(commId);
            return;
        }
        if (type === "comm_open") {
            if (content.target_name !== HOST_TARGET)
                return;
            const parentId = incoming.parent_header.msg_id;
            const comm = {
                owner: typeof parentId === "string" ? this.executionOwners.get(parentId) : undefined,
                handled: false,
            };
            this.hostComms.set(commId, comm);
            this.startHostRequest(commId, comm, content.data);
            return;
        }
        const comm = this.hostComms.get(commId);
        if (type === "comm_msg" && comm)
            this.startHostRequest(commId, comm, content.data);
    }
    startHostRequest(commId, comm, data) {
        if (comm.handled)
            return;
        comm.handled = true;
        const task = this.serveHostRequest(commId, comm.owner, data);
        this.hostRequests.add(task);
        const clear = () => {
            this.hostRequests.delete(task);
        };
        void task.then(clear, clear);
    }
    async serveHostRequest(commId, owner, data) {
        let reply;
        try {
            if (!owner)
                throw new Error("The IPython cell that opened this request is no longer available");
            const result = await owner.host.request(data, owner.controller.signal);
            reply = { status: "ok", result };
        }
        catch (error) {
            reply = { status: "error", error: errorMessage(error) };
        }
        try {
            await this.sendControlComm(commId, reply);
        }
        catch (error) {
            this.kernelStderr += `[kernel] host reply failed: ${errorMessage(error)}\n`;
        }
    }
    async sendControlComm(commId, data) {
        await this.queueControl("comm_msg", { comm_id: commId, data });
    }
    async waitForIdle(signal) {
        const execution = this.active;
        if (!execution)
            return;
        const deadline = performance.now() + INTERRUPT_REUSE_TIMEOUT_MS;
        while (this.active === execution) {
            if (signal?.aborted)
                throw abortError();
            if (this.closed)
                throw new Error("IPython kernel is closed");
            void this.interrupt().catch(() => undefined);
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
                throw new Error("The previously interrupted IPython cell is still running");
            }
            await Promise.race([execution.idle, sleep(Math.min(INTERRUPT_RETRY_MS, remaining))]);
        }
    }
    interrupt() {
        if (!this.control || !this.connection)
            return Promise.resolve();
        if (this.interruptPromise)
            return this.interruptPromise;
        const interrupt = this.queueControl("interrupt_request", {}, "interrupt_reply");
        this.interruptPromise = interrupt;
        const clear = () => {
            if (this.interruptPromise === interrupt)
                this.interruptPromise = undefined;
        };
        void interrupt.then(clear, clear);
        return interrupt;
    }
    queueControl(msgType, content, replyType) {
        const control = this.control;
        const connection = this.connection;
        if (!control || !connection)
            return Promise.reject(new Error("control channel unavailable"));
        const message = buildMessage(msgType, content, this.session, this.username);
        const exchange = this.controlQueue.then(async () => {
            await control.send(encode(message, connection.key));
            if (replyType) {
                const reply = await receiveKernelReply(control, connection.key, message.header.msg_id, replyType);
                if (replyType === "interrupt_reply" && reply.content.status !== "ok") {
                    throw new Error("Kernel returned an invalid interrupt_reply");
                }
            }
        });
        this.controlQueue = exchange.then(() => undefined, () => undefined);
        return exchange;
    }
    async waitForResolvedConnection(path, proc) {
        const started = Date.now();
        while (Date.now() - started < PORTS_RESOLVE_TIMEOUT_MS) {
            if (this.closed || this.kernel !== proc || proc.exitCode !== null || proc.signalCode !== null) {
                throw new Error(`Kernel exited before resolving ports.\n${this.stderrTail()}`);
            }
            const info = readConnectionInfo(path);
            if (info && hasResolvedPorts(info))
                return info;
            await sleep(25);
        }
        throw new Error(`Kernel did not resolve ports within ${PORTS_RESOLVE_TIMEOUT_MS}ms.\n${this.stderrTail()}`);
    }
    async probeReady(proc) {
        const conn = this.connection;
        const shell = this.shell;
        if (!conn || !shell)
            throw new Error("IPython kernel connection is unavailable");
        const msg = buildMessage("kernel_info_request", {}, this.session, this.username);
        const id = msg.header.msg_id;
        await shell.send(encode(msg, conn.key));
        const started = Date.now();
        while (Date.now() - started < READY_TIMEOUT_MS) {
            if (this.closed || this.kernel !== proc || proc.exitCode !== null || proc.signalCode !== null) {
                throw new Error(`Kernel exited during startup.\n${this.stderrTail()}`);
            }
            const remaining = READY_TIMEOUT_MS - (Date.now() - started);
            const winner = await Promise.race([
                shell.receive().then((frames) => ({ kind: "frames", frames })),
                sleep(remaining).then(() => ({ kind: "timeout" })),
            ]);
            if (winner.kind === "timeout")
                break;
            const incoming = decode(winner.frames, conn.key);
            if (incoming?.header.msg_type === "kernel_info_reply" &&
                incoming.parent_header.msg_id === id) {
                return;
            }
        }
        throw new Error(`Kernel did not answer kernel_info_request within ${READY_TIMEOUT_MS}ms.\n${this.stderrTail()}`);
    }
    closeKernel(error) {
        if (this.closePromise)
            return this.closePromise;
        const close = this.doCloseKernel(error);
        this.closePromise = close;
        const clear = () => {
            if (this.closePromise === close)
                this.closePromise = undefined;
        };
        void close.then(clear, clear);
        return close;
    }
    async doCloseKernel(error) {
        const active = this.active;
        if (active) {
            active.controller.abort();
            this.releaseExecution(active);
            if (!active.settled) {
                active.settled = true;
                active.reject(error);
            }
        }
        for (const owner of this.executionOwners.values())
            owner.controller.abort();
        this.executionOwners.clear();
        const shell = this.shell;
        const iopub = this.iopub;
        const pump = this.iopubPump;
        try {
            await shell?.close();
        }
        catch (closeError) {
            this.kernelStderr += `[kernel] shell close failed: ${errorMessage(closeError)}\n`;
        }
        try {
            await iopub?.close();
        }
        catch (closeError) {
            this.kernelStderr += `[kernel] IOPub close failed: ${errorMessage(closeError)}\n`;
        }
        this.shell = undefined;
        this.iopub = undefined;
        await pump?.catch(() => undefined);
        await waitUntilSettled([...this.hostRequests], HOST_REQUEST_CLOSE_TIMEOUT_MS);
        const proc = this.kernel;
        this.kernel = undefined;
        const control = this.control;
        const connection = this.connection;
        if (proc && control && connection && proc.exitCode === null && proc.signalCode === null) {
            try {
                await Promise.race([
                    this.queueControl("shutdown_request", { restart: false }),
                    sleep(GRACEFUL_SHUTDOWN_MS, undefined, { ref: false }),
                ]);
            }
            catch (shutdownError) {
                this.kernelStderr += `[kernel] graceful shutdown failed: ${errorMessage(shutdownError)}\n`;
            }
        }
        this.hostComms.clear();
        if (proc)
            await stopProcess(proc);
        try {
            await control?.close();
        }
        catch (closeError) {
            this.kernelStderr += `[kernel] control close failed: ${errorMessage(closeError)}\n`;
        }
        this.control = undefined;
        this.connection = undefined;
        this.controlQueue = Promise.resolve();
        this.interruptPromise = undefined;
        this.shellReply = Promise.resolve();
        const tempDir = this.tempDir;
        this.tempDir = undefined;
        if (tempDir)
            rmSync(tempDir, { recursive: true, force: true });
    }
    stderrTail() {
        const tail = this.kernelStderr.trim();
        return tail ? `stderr:\n${tail}` : "stderr: (empty)";
    }
}
// ---- wire format ---------------------------------------------------------
function buildMessage(msgType, content, session, username) {
    return {
        header: {
            msg_id: randomUUID(),
            session,
            username,
            date: new Date().toISOString(),
            msg_type: msgType,
            version: PROTOCOL_VERSION,
        },
        parent_header: {},
        metadata: {},
        content,
    };
}
function sign(parts, key) {
    const hmac = createHmac("sha256", key);
    for (const part of parts)
        hmac.update(part);
    return Buffer.from(hmac.digest("hex"));
}
function encode(msg, key) {
    const parts = [
        Buffer.from(JSON.stringify(msg.header)),
        Buffer.from(JSON.stringify(msg.parent_header)),
        Buffer.from(JSON.stringify(msg.metadata)),
        Buffer.from(JSON.stringify(msg.content)),
    ];
    return [DELIM, sign(parts, key), ...parts];
}
function decode(frames, key) {
    let i = 0;
    while (i < frames.length && !frames[i]?.equals(DELIM))
        i++;
    const signature = frames[i + 1];
    const header = frames[i + 2];
    const parent = frames[i + 3];
    const metadata = frames[i + 4];
    const content = frames[i + 5];
    if (!signature || !header || !parent || !metadata || !content)
        return null;
    if (key) {
        const expected = sign([header, parent, metadata, content], key);
        if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
            return null;
    }
    try {
        return {
            header: JSON.parse(header.toString()),
            parent_header: JSON.parse(parent.toString()),
            metadata: JSON.parse(metadata.toString()),
            content: JSON.parse(content.toString()),
        };
    }
    catch {
        return null;
    }
}
async function receiveKernelReply(channel, key, requestMsgId, msgType) {
    const incoming = decode(await channel.receive(), key);
    const parentId = incoming?.parent_header?.msg_id;
    if (incoming?.header.msg_type !== msgType || parentId !== requestMsgId) {
        throw new Error(`Kernel returned an invalid ${msgType}`);
    }
    return incoming;
}
export async function receiveExecuteReply(shell, key, requestMsgId) {
    const incoming = await receiveKernelReply(shell, key, requestMsgId, "execute_reply");
    const status = incoming.content.status;
    if (status !== "ok" && status !== "error" && status !== "aborted") {
        throw new Error("Kernel returned an invalid execute_reply");
    }
}
function makeConnection() {
    const info = {
        ip: "127.0.0.1",
        transport: "tcp",
        shell_port: 0,
        iopub_port: 0,
        stdin_port: 0,
        control_port: 0,
        hb_port: 0,
        signature_scheme: "hmac-sha256",
        key: randomBytes(16).toString("hex"),
        kernel_name: "python3",
    };
    const tempDir = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-kernel-"));
    const path = join(tempDir, "connection.json");
    writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 });
    return { path, tempDir };
}
const PORT_KEYS = ["shell_port", "iopub_port", "stdin_port", "control_port", "hb_port"];
function hasResolvedPorts(info) {
    return PORT_KEYS.every((key) => Number.isInteger(info[key]) && info[key] > 0);
}
function readConnectionInfo(path) {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (value.ip !== "127.0.0.1" || value.transport !== "tcp")
            return null;
        if (value.signature_scheme !== "hmac-sha256" || typeof value.key !== "string")
            return null;
        const ports = PORT_KEYS.map((key) => value[key]);
        if (ports.some((port) => typeof port !== "number" || !Number.isInteger(port)))
            return null;
        return {
            ip: "127.0.0.1",
            transport: "tcp",
            shell_port: value.shell_port,
            iopub_port: value.iopub_port,
            stdin_port: value.stdin_port,
            control_port: value.control_port,
            hb_port: value.hb_port,
            signature_scheme: "hmac-sha256",
            key: value.key,
            kernel_name: typeof value.kernel_name === "string" ? value.kernel_name : "python3",
        };
    }
    catch {
        return null;
    }
}
// ---- output --------------------------------------------------------------
class CellOutput {
    stdout = new TextBuffer();
    stderr = new TextBuffer();
    value = new TextBuffer();
    display = new TextBuffer();
    attachments = [];
    imageBytes = 0;
    clearOnOutput = false;
    executionCount = null;
    error;
    onUpdate;
    constructor(onUpdate) {
        this.onUpdate = onUpdate;
    }
    accept(message) {
        const type = message.header.msg_type;
        const content = message.content;
        if (type === "clear_output") {
            if (content.wait)
                this.clearOnOutput = true;
            else
                this.clear();
            return;
        }
        if (this.clearOnOutput) {
            this.clear();
            this.clearOnOutput = false;
        }
        if (type === "stream") {
            const name = content.name === "stderr" ? "stderr" : "stdout";
            const text = this[name].append(String(content.text ?? ""));
            if (text)
                this.onUpdate?.({ stream: name, text });
            return;
        }
        if (type === "execute_result") {
            const c = content;
            if (typeof c.execution_count === "number")
                this.executionCount = c.execution_count;
            this.value.append(mimeText(c.data ?? {}));
            this.addImages(c.data ?? {});
            return;
        }
        if (type === "display_data" || type === "update_display_data") {
            const data = content.data ?? {};
            const text = mimeText(data);
            if (text)
                this.display.append(`${text}\n`);
            this.addImages(data);
            return;
        }
        if (type === "error") {
            const c = content;
            this.error = {
                ename: String(c.ename ?? "Error"),
                evalue: String(c.evalue ?? ""),
                traceback: Array.isArray(c.traceback) ? c.traceback.map(String) : [],
            };
        }
    }
    result(durationMs) {
        return {
            status: this.error ? "error" : "ok",
            durationMs,
            executionCount: this.executionCount,
            stdout: this.stdout.text,
            stderr: this.stderr.text,
            result: this.value.text,
            display: this.display.text,
            attachments: this.attachments,
            ...(this.error ? { error: this.error } : {}),
        };
    }
    addImages(data) {
        for (const mimeType of ["image/png", "image/jpeg"]) {
            const image = data[mimeType];
            if (typeof image !== "string" || this.attachments.length >= MAX_IMAGES)
                continue;
            const bytes = Buffer.byteLength(image, "base64");
            if (this.imageBytes + bytes > MAX_IMAGE_BYTES)
                continue;
            this.imageBytes += bytes;
            this.attachments.push({ mimeType, data: image });
        }
    }
    clear() {
        this.stdout.clear();
        this.stderr.clear();
        this.value.clear();
        this.display.clear();
        this.attachments = [];
        this.imageBytes = 0;
    }
}
class TextBuffer {
    parts = [];
    bytes = 0;
    truncated = false;
    append(value) {
        if (!value || this.truncated)
            return "";
        const available = MAX_TEXT_BYTES - TRUNCATED_BYTES - this.bytes;
        if (available <= 0) {
            this.truncated = true;
            return "";
        }
        const encoded = Buffer.from(value);
        const accepted = encoded.length <= available ? value : utf8Prefix(encoded, available);
        if (accepted) {
            this.parts.push(accepted);
            this.bytes += Buffer.byteLength(accepted);
        }
        if (encoded.length > available)
            this.truncated = true;
        return accepted;
    }
    clear() {
        this.parts = [];
        this.bytes = 0;
        this.truncated = false;
    }
    get text() {
        return `${this.parts.join("")}${this.truncated ? TRUNCATED : ""}`;
    }
}
function mimeText(data) {
    for (const mime of ["text/plain", "text/markdown"]) {
        const value = data[mime];
        if (typeof value === "string")
            return value;
        if (Array.isArray(value))
            return value.join("");
    }
    const json = data["application/json"];
    return json === undefined ? "" : JSON.stringify(json, null, 2);
}
function utf8Prefix(value, limit) {
    let end = Math.min(value.length, limit);
    while (end > 0 && end < value.length) {
        const byte = value[end];
        if (byte === undefined || (byte & 0xc0) !== 0x80)
            break;
        end--;
    }
    return value.subarray(0, end).toString();
}
export async function waitUntilSettled(tasks, timeoutMs) {
    if (tasks.length === 0)
        return true;
    return Promise.race([Promise.allSettled(tasks).then(() => true), sleep(timeoutMs, false, { ref: false })]);
}
async function stopProcess(proc) {
    if (proc.exitCode !== null || proc.signalCode !== null)
        return;
    const closed = once(proc, "close").then(() => true, () => true);
    if (await Promise.race([closed, sleep(GRACEFUL_SHUTDOWN_MS).then(() => false)]))
        return;
    const signal = (name) => {
        try {
            if (process.platform !== "win32" && proc.pid)
                process.kill(-proc.pid, name);
            else
                proc.kill(name);
        }
        catch {
            // The process may have exited between the close check and signal.
        }
    };
    signal("SIGTERM");
    if (await Promise.race([closed, sleep(PROCESS_EXIT_TIMEOUT_MS).then(() => false)]))
        return;
    signal("SIGKILL");
    await closed;
}
function abortError() {
    const error = new Error("IPython execution aborted");
    error.name = "AbortError";
    return error;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
const unavailableHost = {
    request: async () => {
        throw new Error("Host requests are unavailable during IPython startup");
    },
};
