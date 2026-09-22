import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_TASKS = 32;
const MAX_NAME = 64;
const MAX_LOG_BYTES = 50_000;
const MAX_PREVIEW_BYTES = 64 * 1024;
const KILL_GRACE_MS = 3_000;
const MAX_MESSAGE = 16_384;
const DEFAULT_TIMEOUT_SECONDS = 60;

export class BackgroundTasks {
    tasks = new Map();
    constructor(options) {
        this.options = options;
        mkdirSync(options.logDir, { recursive: true });
    }
    start(options) {
        const running = [...this.tasks.values()].filter((task) => task.status === "running").length;
        if (running >= MAX_TASKS)
            throw new Error(`Too many background tasks are running (maximum ${MAX_TASKS})`);
        const command = text(options.command, "command");
        const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)
            throw new Error("timeout_seconds must be a positive integer");
        const name = taskName(options.name, command);
        if ([...this.tasks.values()].some((task) => task.name === name))
            throw new Error(`A background task named ${JSON.stringify(name)} already exists`);
        if (this.options.nameAvailable && !this.options.nameAvailable(name))
            throw new Error(`A sub-agent or background task named ${JSON.stringify(name)} already exists`);
        const id = this.newId();
        const cwd = options.cwd ?? this.options.cwd;
        const logPath = join(this.options.logDir, `${id}.log`);
        const output = createWriteStream(logPath, { flags: "a" });
        const task = {
            id,
            name,
            command,
            cwd,
            status: "running",
            pid: undefined,
            startedAt: this.options.now?.() ?? Date.now(),
            endedAt: undefined,
            exitCode: undefined,
            signal: undefined,
            logPath,
            output,
            preview: "",
            lastLine: "",
            process: undefined,
            killReason: undefined,
            timeout: undefined,
            previewNotify: undefined,
            notify: options.notify !== false,
            done: undefined,
        };
        task.done = new Promise((resolve) => {
            task.resolveDone = resolve;
        });
        this.tasks.set(id, task);
        this.options.onChange?.();
        let child;
        try {
            child = (this.options.spawn ?? nodeSpawn)(command, {
                shell: true,
                cwd,
                env: process.env,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            output.end();
            this.tasks.delete(id);
            this.options.onChange?.();
            throw error;
        }
        task.process = child;
        task.pid = child.pid;
        const onData = (chunk) => {
            const text = String(chunk);
            output.write(text);
            task.preview = `${task.preview}${text}`.slice(-MAX_PREVIEW_BYTES);
            const lines = task.preview.split(/\r\n|\n|\r/);
            task.lastLine = (lines.at(-1) ? lines.at(-1) : lines.at(-2) ?? "").trim().slice(-240);
            // Propagate output previews while the process is still running. This
            // is especially important for tasks started by a sub-agent: their
            // parent only has the snapshots sent through onChange. Coalesce
            // bursts from chatty processes so output cannot flood the UI.
            if (!task.previewNotify) {
                task.previewNotify = setTimeout(() => {
                    task.previewNotify = undefined;
                    if (task.status === "running")
                        this.options.onChange?.();
                }, 100);
                task.previewNotify.unref?.();
            }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (error) => {
            task.error = error instanceof Error ? error.message : String(error);
        });
        child.on("close", (code, signal) => {
            const finalStatus = task.killReason === "timeout" ? "failed" : task.killReason ? "killed" : code === 0 ? "completed" : "failed";
            this.finish(task, finalStatus, code, signal);
        });
        task.timeout = setTimeout(() => {
            void this.kill(task.id, "timeout");
        }, timeoutSeconds * 1000);
        task.timeout.unref?.();
        return this.snapshot(task);
    }
    list() {
        return [...this.tasks.values()].sort((left, right) => left.startedAt - right.startedAt).map((task) => this.snapshot(task));
    }
    hasName(name) {
        return [...this.tasks.values()].some((task) => task.name === name);
    }
    find(target) {
        const value = text(target, "task");
        return this.tasks.get(value) ?? [...this.tasks.values()].find((candidate) => candidate.name === value);
    }
    get(target) {
        const value = text(target, "task");
        const task = this.find(value);
        if (!task)
            throw new Error(`No background task matches ${JSON.stringify(value)}`);
        return task;
    }
    status(target) {
        return target === undefined ? this.list() : this.snapshot(this.get(target));
    }
    logs(target, options = {}) {
        const task = this.get(target);
        const maxBytes = options.maxBytes ?? 20_000;
        if (!Number.isInteger(maxBytes) || maxBytes <= 0)
            throw new Error("max_bytes must be a positive integer");
        const bounded = Math.min(maxBytes, MAX_LOG_BYTES);
        const bytes = existsSync(task.logPath) ? readFileSync(task.logPath) : Buffer.alloc(0);
        const tail = options.tail !== false;
        const truncated = bytes.length > bounded;
        const selected = tail ? bytes.subarray(Math.max(0, bytes.length - bounded)) : bytes.subarray(0, bounded);
        return {
            text: selected.toString("utf8"),
            path: task.logPath,
            bytesRead: selected.length,
            truncated,
            tail,
        };
    }
    async kill(target, reason = "user") {
        const task = this.get(target);
        if (task.status !== "running")
            return this.snapshot(task);
        // The timeout, user, and session-shutdown paths can race. Preserve
        // the first reason so terminal status and notifications are stable.
        if (!task.killReason) {
            task.killReason = reason;
            if (reason === "timeout")
                task.error = "Background task timed out";
        }
        this.signal(task, "SIGTERM");
        await Promise.race([task.done, delay(KILL_GRACE_MS)]);
        if (task.status === "running")
            this.signal(task, "SIGKILL");
        return await task.done;
    }
    async wait(target, signal, timeoutMs) {
        const task = this.get(target);
        if (signal?.aborted)
            throw abortError();
        if (task.status !== "running")
            return this.snapshot(task);
        return await new Promise((resolve, reject) => {
            let timer;
            const abort = () => {
                cleanup();
                reject(abortError());
            };
            const cleanup = () => {
                signal?.removeEventListener("abort", abort);
                if (timer)
                    clearTimeout(timer);
            };
            signal?.addEventListener("abort", abort, { once: true });
            if (timeoutMs !== undefined)
                timer = setTimeout(() => {
                    cleanup();
                    reject(new Error("Background task wait timed out"));
                }, timeoutMs);
            task.done.then((result) => {
                cleanup();
                resolve(result);
            });
        });
    }
    async dispose() {
        const running = [...this.tasks.values()].filter((task) => task.status === "running");
        for (const task of running)
            task.notify = false;
        await Promise.allSettled(running.map((task) => this.kill(task.id, "session shutdown")));
        for (const task of this.tasks.values())
            task.output?.end();
    }
    transcript(target) {
        const task = this.get(target);
        const snapshot = this.snapshot(task);
        const logs = this.logs(task.id, { maxBytes: 50_000, tail: true });
        const header = `Background task · ${snapshot.name} · ${snapshot.status}\nCommand: ${snapshot.command}\nWorking directory: ${snapshot.cwd}\nLog: ${snapshot.logPath}`;
        return `${header}\n\n${logs.text || "(no output yet)"}`;
    }
    snapshot(task) {
        const endedAt = task.endedAt;
        return {
            id: task.id,
            name: task.name,
            command: task.command,
            cwd: task.cwd,
            status: task.status,
            pid: task.pid ?? null,
            exit_code: task.exitCode ?? null,
            started_at: task.startedAt,
            ended_at: endedAt ?? null,
            duration_ms: endedAt === undefined ? (this.options.now?.() ?? Date.now()) - task.startedAt : endedAt - task.startedAt,
            log_path: task.logPath,
            last_line: task.lastLine || null,
            signal: task.signal ?? null,
            error: task.error ?? null,
        };
    }
    finish(task, status, code, signal) {
        if (task.status !== "running")
            return;
        if (task.timeout)
            clearTimeout(task.timeout);
        task.timeout = undefined;
        if (task.previewNotify)
            clearTimeout(task.previewNotify);
        task.previewNotify = undefined;
        task.status = status;
        task.exitCode = code ?? undefined;
        task.signal = signal ?? undefined;
        task.endedAt = this.options.now?.() ?? Date.now();
        const finalize = () => {
            const snapshot = this.snapshot(task);
            task.resolveDone?.(snapshot);
            // Wake the owning session before publishing the task's terminal
            // snapshot. For nested runtimes this lets the parent observe the
            // follow-up turn before it sees the task disappear from the active
            // tree.
            if (task.notify)
                this.options.notify?.(this.completionMessage(snapshot), snapshot);
            this.options.onChange?.();
        };
        task.output.end(finalize);
    }
    completionMessage(task) {
        const outcome = task.status === "completed" ? "finished" : task.status === "killed" ? "stopped" : "failed";
        const exit = task.exit_code === null ? task.signal ? `signal ${task.signal}` : task.status : `exit ${task.exit_code}`;
        const duration = `${(task.duration_ms / 1000).toFixed(1)}s`;
        const preview = task.last_line ? `\n\nLast output: ${task.last_line}` : "";
        const timeoutNote = task.error === "Background task timed out"
            ? "\nHit its time limit. Re-run with bg(\"...\", timeout_seconds=<n>) for longer work."
            : "";
        return `Background task ${outcome}: ${task.name} (${exit} in ${duration})${timeoutNote}\nCommand: ${task.command}\nLog: ${task.log_path}${preview}`.slice(0, MAX_MESSAGE);
    }
    signal(task, signal) {
        if (task.status !== "running")
            return;
        try {
            if (process.platform !== "win32" && task.pid)
                process.kill(-task.pid, signal);
            else
                task.process?.kill(signal);
        }
        catch {
            try {
                task.process?.kill(signal);
            }
            catch {
                // The process may have exited between status and signal delivery.
            }
        }
    }
    newId() {
        let id;
        do {
            id = `t${randomBytes(4).toString("hex")}`;
        } while (this.tasks.has(id));
        return id;
    }
}
function taskName(value, command) {
    const explicit = value !== undefined;
    const name = explicit ? text(value, "name") : command.split(/\s+/).slice(0, 4).join(" ").slice(0, MAX_NAME);
    if (name.length > MAX_NAME)
        throw new Error(`name must be at most ${MAX_NAME} characters`);
    for (const character of name) {
        if (character.codePointAt(0) <= 0x1f || character.codePointAt(0) === 0x7f)
            throw new Error("Names cannot contain control characters");
    }
    return name;
}
function text(value, label) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${label} must not be empty`);
    return value.trim();
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function abortError() {
    const error = new Error("Operation aborted");
    error.name = "AbortError";
    return error;
}
