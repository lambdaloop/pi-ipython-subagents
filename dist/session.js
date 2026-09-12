import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createKernelRuntime, SessionKernel, verifyKernelEnvironment, } from "./kernel.js";
import { loadSubagents, SUBAGENT_ENTRY, subagentCreated, subagentDeleted } from "./state.js";
import { startSubagent, } from "./subagent.js";
const AGENT_MESSAGE_TYPE = "pi-rlm-runtime.message";
const OUT_OF_REACH = "can only message parent, siblings, and direct subagents";
const MAX_NAME = 64;
const MAX_MESSAGE = 16_384;
const MAX_PROMPT = 256 * 1024;
export class SessionRuntime {
    options;
    ctx;
    kernels;
    kernel;
    subagents = new Map();
    starting = new Set();
    reservedNames = new Set();
    tempDir;
    closed = false;
    constructor(options) {
        this.options = options;
        this.ctx = options.ctx;
        this.kernels = options.runtime ?? createKernelRuntime({ cwd: options.ctx.cwd, runtimeDir: options.runtimeDir });
        for (const [id, saved] of loadSubagents(options.ctx.sessionManager.getBranch(), this.sessionId)) {
            this.subagents.set(id, { ...saved });
        }
    }
    get sessionId() {
        return this.ctx.sessionManager.getSessionId();
    }
    get depth() {
        return this.options.depth;
    }
    get maxDepth() {
        return this.options.maxDepth;
    }
    updateContext(ctx) {
        this.ctx = ctx;
    }
    listSubagents() {
        return sortedSubagents(this.subagents.values()).map(subagentInfo);
    }
    subagentTranscript(target) {
        const subagent = this.require(target);
        const session = subagent.agent?.session;
        const messages = session ? [...session.messages] : loadTranscriptFile(subagent.sessionFile);
        if (!session && !messages.length)
            return `Sub-agent ${subagent.name} is dormant.\nSession: ${subagent.sessionFile ?? "not persisted"}`;
        const streaming = session?.state.streamingMessage;
        if (streaming && messages.at(-1) !== streaming)
            messages.push(streaming);
        const body = messages.slice(-80).map(formatTranscriptMessage).filter(Boolean).join("\n\n");
        return body || "(no messages yet)";
    }
    listActiveSubagents() {
        const active = [];
        for (const subagent of sortedSubagents(this.subagents.values())) {
            const currentStatus = status(subagent);
            if (currentStatus === "dormant")
                continue;
            active.push({
                id: subagent.sessionId,
                name: subagent.name,
                status: currentStatus,
                command: subagent.command,
                output: subagent.output,
                activity: subagent.activity,
                subagents: subagent.subagents ?? [],
            });
        }
        return active;
    }
    async refresh(ctx) {
        this.open();
        this.ctx = ctx;
        const saved = loadSubagents(ctx.sessionManager.getBranch(), this.sessionId);
        const removed = [];
        for (const [id, subagent] of this.subagents) {
            if (saved.has(id))
                continue;
            this.subagents.delete(id);
            subagent.unsubscribe?.();
            removed.push(subagent);
        }
        for (const [id, subagent] of saved) {
            const live = this.subagents.get(id);
            if (!live) {
                this.subagents.set(id, { ...subagent });
                continue;
            }
            live.name = subagent.name;
            live.model = subagent.model;
            if (subagent.sessionFile)
                live.sessionFile = subagent.sessionFile;
            else
                delete live.sessionFile;
        }
        this.notifySubagents();
        await Promise.allSettled(removed.map(async (subagent) => {
            await subagent.opening?.catch(() => undefined);
            await subagent.agent?.close();
        }));
    }
    execute(code, signal, onUpdate) {
        this.open();
        const directive = parseKernelDirective(code);
        if (directive !== undefined)
            return this.runKernelDirective(directive);
        this.kernel ??= new SessionKernel(this.kernels);
        return this.kernel.execute(code, this, signal, onUpdate);
    }
    /**
     * Host-side handling for the `%%kernel` directive: the kernel cannot restart
     * itself, so the runtime swaps the environment and recreates the kernel.
     */
    async runKernelDirective(args) {
        const startedAt = Date.now();
        const result = (stdout) => ({
            status: "ok",
            durationMs: Date.now() - startedAt,
            executionCount: null,
            stdout,
            stderr: "",
            result: "",
            display: "",
            attachments: [],
        });
        const failure = (message) => ({
            status: "error",
            durationMs: Date.now() - startedAt,
            executionCount: null,
            stdout: "",
            stderr: "",
            result: "",
            display: "",
            attachments: [],
            error: { ename: "KernelDirective", evalue: message, traceback: [message] },
        });
        const kernels = this.kernels;
        if (!Array.isArray(kernels?.environments) || !kernels.environments.length)
            return failure("IPython kernel environments are unavailable in this session");
        const tokens = args.split(/\s+/).filter(Boolean);
        if (!tokens.length) {
            const lines = ["IPython kernel environments (use `%%kernel <name>` to restart into one):"];
            for (const environment of kernels.environments)
                lines.push(...kernels.describe(environment));
            return result(lines.join("\n"));
        }
        let spec = kernels.find(tokens[0]);
        if (tokens[0] === "python") {
            const path = tokens[1];
            if (!path)
                return failure("`%%kernel python <absolute path>` needs an interpreter path");
            if (!isAbsolute(path))
                return failure(`Kernel interpreter path must be absolute: ${path}`);
            spec = kernels.find("python") ?? undefined;
            if (!spec) {
                spec = {
                    name: "python",
                    label: "ad-hoc interpreter",
                    detail: path,
                    kind: "python",
                    command: path,
                    commandArgs: [],
                    cwd: kernels.cwd,
                    python: path,
                };
                kernels.environments.push(spec);
            }
            else {
                spec.detail = path;
                spec.command = path;
                spec.python = path;
            }
        }
        if (!spec)
            return failure(`Unknown kernel environment '${tokens[0]}'. Available: ${kernels.names().join(", ")}`);
        const previous = kernels.activeSpec;
        try {
            kernels.apply(spec);
        }
        catch (error) {
            return failure(errorMessage(error));
        }
        if (spec.kind !== "uv") {
            const check = verifyKernelEnvironment(kernels.activeSpec, kernels.kernelEnv);
            if (!check.ok) {
                try {
                    kernels.apply(previous);
                }
                catch {
                    // Keep the previous environment as-is when the revert fails.
                }
                return failure(`Cannot start a kernel in '${spec.name}': ${check.detail ?? "ipykernel is unavailable"}\nStill using '${previous.name}'.`);
            }
        }
        const hadKernel = this.kernel !== undefined;
        await this.kernel?.dispose().catch(() => undefined);
        this.kernel = undefined;
        return result(`${hadKernel ? "Restarted" : "Set"} the IPython kernel to environment '${spec.name}' (${spec.detail}).\nThe next cell runs there; Python state from the previous kernel is gone.`);
    }
    async request(value, signal) {
        this.open();
        if (signal.aborted)
            throw abortErr();
        if (!value || typeof value !== "object")
            throw new Error("Invalid pi-rlm-runtime request");
        const req = value;
        switch (req.type) {
            case "rlm.run": {
                const starting = this.spawn(text(req.prompt, "prompt", MAX_PROMPT), req.name == null ? undefined : agentName(req.name, "name"), req.model == null ? undefined : text(req.model, "model"), signal);
                this.starting.add(starting);
                try {
                    return await starting;
                }
                finally {
                    this.starting.delete(starting);
                }
            }
            case "rlm.find_models": {
                if (typeof req.query !== "string")
                    throw new Error("query must be a string");
                const query = req.query.trim().toLowerCase();
                return sessionModels(this.ctx)
                    .filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query))
                    .map((model) => ({
                    provider: model.provider,
                    id: model.id,
                    name: model.name,
                    selector: `${model.provider}/${model.id}`,
                }));
            }
            case "rlm.list_subagents":
                return this.listSubagents();
            case "rlm.delete_subagent":
                return this.drop(text(req.target, "subagent", MAX_NAME));
            case "agent_message.send":
                return this.send(req);
            case "agent_message.list_agents":
                return this.listAgents();
            default:
                throw new Error("Unsupported pi-rlm-runtime request");
        }
    }
    async dispose() {
        if (this.closed)
            return;
        this.closed = true;
        await this.kernel?.dispose().catch(() => undefined);
        this.kernel = undefined;
        await Promise.allSettled(this.starting);
        await Promise.allSettled([...this.subagents.values()].map(async (subagent) => {
            subagent.unsubscribe?.();
            await subagent.opening?.catch(() => undefined);
            await subagent.agent?.close();
            delete subagent.agent;
        }));
        if (this.tempDir)
            rmSync(this.tempDir, { recursive: true, force: true });
    }
    // --- spawn / delete ---
    async spawn(prompt, subagentName, modelSelector, signal) {
        if (this.depth >= this.maxDepth)
            throw new Error(`Sub-agent depth limit reached (${this.depth}/${this.maxDepth})`);
        let model = this.ctx.model;
        if (modelSelector) {
            model = sessionModels(this.ctx).find(({ provider, id }) => `${provider}/${id}` === modelSelector);
            if (!model)
                throw new Error(`Sub-agent model is unavailable: ${modelSelector}`);
        }
        if (!model)
            throw new Error("Select a Pi model before creating a sub-agent");
        if (subagentName && (this.findSubagent(subagentName) || this.reservedNames.has(subagentName))) {
            throw new Error(`A direct sub-agent named ${JSON.stringify(subagentName)} already exists`);
        }
        if (subagentName)
            this.reservedNames.add(subagentName);
        let started;
        try {
            started = await startSubagent({
                cwd: this.ctx.cwd,
                agentDir: this.options.agentDir,
                subagentDir: this.subagentDir(),
                projectTrusted: this.ctx.isProjectTrusted(),
                model,
                ...(this.ctx.thinkingLevel ? { thinkingLevel: this.ctx.thinkingLevel } : {}),
                runtime: this.kernels,
                depth: this.depth + 1,
                maxDepth: this.maxDepth,
                parent: this.parentLink(),
                ...(subagentName ? { name: subagentName } : {}),
                task: prompt,
                signal,
                makeExtension: this.options.makeExtension,
            });
            if (signal.aborted)
                throw abortErr();
            if (this.closed)
                throw new Error("Parent session closed while sub-agent was starting");
            const subagent = {
                sessionId: started.sessionId,
                name: started.name,
                ...(started.sessionFile ? { sessionFile: started.sessionFile } : {}),
                model: started.model,
                agent: started,
            };
            this.subagents.set(subagent.sessionId, subagent);
            this.attach(subagent, started);
            const run = started.prompt(prompt, signal);
            const subagentRun = { finished: run.finished, replied: false };
            subagent.run = subagentRun;
            void run.finished.catch(() => undefined);
            await run.accepted;
            if (signal.aborted)
                throw abortErr();
            if (this.closed)
                throw new Error("Parent session closed while sub-agent was starting");
            this.options.pi.appendEntry(SUBAGENT_ENTRY, subagentCreated(this.sessionId, subagent));
            this.watch(subagent, subagentRun);
            return subagentInfo(subagent);
        }
        catch (error) {
            if (started) {
                const subagent = this.subagents.get(started.sessionId);
                if (subagent?.agent === started)
                    subagent.unsubscribe?.();
                this.subagents.delete(started.sessionId);
                await started.close().catch(() => undefined);
                if (started.sessionFile)
                    rmSync(started.sessionFile, { force: true });
                this.notifySubagents();
            }
            throw error;
        }
        finally {
            if (subagentName)
                this.reservedNames.delete(subagentName);
        }
    }
    async drop(target) {
        const subagent = this.require(target);
        const view = subagentInfo(subagent);
        this.options.pi.appendEntry(SUBAGENT_ENTRY, subagentDeleted(this.sessionId, subagent.sessionId));
        this.subagents.delete(subagent.sessionId);
        subagent.unsubscribe?.();
        this.notifySubagents();
        await subagent.opening?.catch(() => undefined);
        await subagent.agent?.close().catch(() => undefined);
        return view;
    }
    // --- messages ---
    async send(req) {
        const message = text(req.message, "message", MAX_MESSAGE);
        const role = roleOf(req.receiver_role);
        if (role === "parent") {
            if (req.receiver_name != null)
                throw new Error("receiver_name must be omitted for parent messages");
            if (!this.options.parent)
                throw new Error("This session has no parent");
            return this.options.parent.send(message, this.me(), "parent");
        }
        if (role === "sibling") {
            if (!this.options.parent)
                throw new Error(OUT_OF_REACH);
            return this.options.parent.send(message, this.me(), { sibling: agentName(req.receiver_name) });
        }
        return this.toSubagent(this.require(agentName(req.receiver_name)), message, this.me(), "parent");
    }
    listAgents() {
        const me = this.me();
        const entries = [];
        if (this.options.parent)
            entries.push(...this.options.parent.list(me));
        for (const subagent of sortedSubagents(this.subagents.values())) {
            entries.push({
                relationship: "subagent",
                name: subagent.name,
                id: subagent.sessionId,
                depth: this.depth + 1,
                status: status(subagent),
            });
        }
        return { current: me, entries };
    }
    parentLink() {
        return {
            name: this.me().name,
            send: (message, from, to) => this.fromSubagent(message, from, to),
            list: (forSubagent) => this.listFor(forSubagent),
            updateSubagents: (from, subagents) => this.updateSubagents(from, subagents),
        };
    }
    updateSubagents(from, subagents) {
        if (this.closed)
            return;
        const subagent = this.subagents.get(from.id);
        if (!subagent)
            return;
        subagent.subagents = subagents;
        this.notifySubagents();
    }
    async fromSubagent(message, from, to) {
        this.open();
        const subagent = this.subagents.get(from.id);
        if (!subagent)
            throw new Error(OUT_OF_REACH);
        if (to === "parent") {
            this.here(message, from);
            if (subagent.run && subagent.run.replyTo === undefined)
                subagent.run.replied = true;
            return;
        }
        const sibling = this.require(to.sibling);
        if (sibling.sessionId === from.id)
            throw new Error("Cannot message yourself");
        await this.toSubagent(sibling, message, from, "sibling");
        if (subagent.run?.replyTo === sibling.sessionId)
            subagent.run.replied = true;
    }
    listFor(forSubagent) {
        if (!this.subagents.has(forSubagent.id))
            throw new Error(OUT_OF_REACH);
        const entries = [
            {
                relationship: "parent",
                name: this.me().name,
                id: this.sessionId,
                depth: this.depth,
                status: this.ctx.isIdle() ? "idle" : "running",
            },
        ];
        for (const subagent of sortedSubagents(this.subagents.values())) {
            if (subagent.sessionId === forSubagent.id)
                continue;
            entries.push({
                relationship: "sibling",
                name: subagent.name,
                id: subagent.sessionId,
                depth: this.depth + 1,
                status: status(subagent),
            });
        }
        return entries;
    }
    async toSubagent(subagent, message, from, fromRelationship) {
        const agent = subagent.agent ?? (await this.reopen(subagent));
        if (this.closed || this.subagents.get(subagent.sessionId) !== subagent) {
            await agent.close().catch(() => undefined);
            delete subagent.agent;
            throw new Error(`Sub-agent ${JSON.stringify(subagent.name)} is no longer available`);
        }
        const queued = agent.session.isStreaming;
        const label = fromRelationship === "sibling" ? `Message from sibling ${from.name}` : `Message from parent ${from.name}`;
        const sending = agent.session.sendCustomMessage({
            customType: AGENT_MESSAGE_TYPE,
            content: `${label}:\n\n${message}`,
            display: true,
            details: { from, fromRelationship, to: { id: subagent.sessionId, name: subagent.name } },
        }, queued ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: true });
        if (queued)
            await sending;
        else {
            const run = {
                finished: sending,
                replied: false,
                ...(fromRelationship === "sibling" ? { replyTo: from.id } : {}),
            };
            subagent.run = run;
            this.watch(subagent, run);
        }
    }
    here(message, from) {
        this.open();
        const queued = !this.ctx.isIdle();
        const me = this.me();
        this.options.pi.sendMessage({
            customType: AGENT_MESSAGE_TYPE,
            content: `Message from sub-agent ${from.name}:\n\n${message}`,
            display: true,
            details: { from, fromRelationship: "subagent", to: me },
        }, queued ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: true });
    }
    // --- reopen saved subagent ---
    reopen(subagent) {
        subagent.opening ??= this.openSaved(subagent).finally(() => {
            delete subagent.opening;
        });
        return subagent.opening;
    }
    async openSaved(subagent) {
        if (!subagent.sessionFile || !existsSync(subagent.sessionFile)) {
            throw new Error(`Sub-agent ${JSON.stringify(subagent.name)} has no saved Pi session`);
        }
        const agent = await startSubagent({
            cwd: this.ctx.cwd,
            agentDir: this.options.agentDir,
            subagentDir: this.subagentDir(),
            projectTrusted: this.ctx.isProjectTrusted(),
            model: modelOf(this.ctx, subagent.model),
            runtime: this.kernels,
            depth: this.depth + 1,
            maxDepth: this.maxDepth,
            parent: this.parentLink(),
            name: subagent.name,
            sessionFile: subagent.sessionFile,
            makeExtension: this.options.makeExtension,
        });
        if (this.closed || this.subagents.get(subagent.sessionId) !== subagent) {
            await agent.close().catch(() => undefined);
            throw new Error(`Sub-agent ${JSON.stringify(subagent.name)} is no longer available`);
        }
        this.attach(subagent, agent);
        return agent;
    }
    attach(subagent, agent) {
        subagent.unsubscribe?.();
        subagent.agent = agent;
        subagent.subagents = [];
        subagent.unsubscribe = agent.session.subscribe((event) => {
            updateSubagentActivity(subagent, event);
            this.notifySubagents();
        });
        this.notifySubagents();
    }
    watch(subagent, run) {
        void run.finished
            .then(() => this.subagentFinished(subagent, run), (error) => this.subagentFinished(subagent, run, errorMessage(error)))
            .catch(() => undefined);
    }
    async subagentFinished(subagent, run, failure) {
        if (subagent.run !== run)
            return;
        delete subagent.run;
        if (this.closed || this.subagents.get(subagent.sessionId) !== subagent)
            return;
        const agent = subagent.agent;
        try {
            if (!run.replied) {
                const result = lastAssistant(agent?.session);
                const error = failure ?? result.error;
                const message = (error ? `Task failed: ${error}` : result.text ? `Task finished:\n\n${result.text}` : "Task finished.").slice(0, MAX_MESSAGE);
                this.here(message, { id: subagent.sessionId, name: subagent.name, depth: this.depth + 1 });
            }
        }
        finally {
            if (agent && subagent.agent === agent && this.subagents.get(subagent.sessionId) === subagent) {
                subagent.unsubscribe?.();
                delete subagent.unsubscribe;
                const closing = agent.close();
                delete subagent.agent;
                delete subagent.subagents;
                this.notifySubagents();
                await closing.catch(() => undefined);
            }
        }
    }
    me() {
        return {
            id: this.sessionId,
            name: this.ctx.sessionManager.getSessionName() ?? this.sessionId,
            depth: this.depth,
        };
    }
    subagentDir() {
        if (this.ctx.sessionManager.getSessionFile()) {
            return join(this.ctx.sessionManager.getSessionDir(), ".pi-rlm-runtime", this.sessionId);
        }
        this.tempDir ??= mkdtempSync(join(tmpdir(), "pi-rlm-runtime-"));
        return this.tempDir;
    }
    findSubagent(requestedName) {
        for (const subagent of this.subagents.values())
            if (subagent.name === requestedName)
                return subagent;
    }
    require(target) {
        const subagent = this.subagents.get(target) ?? this.findSubagent(target);
        if (!subagent)
            throw new Error(`No agent matches ${JSON.stringify(target)}`);
        return subagent;
    }
    open() {
        if (this.closed)
            throw new Error("pi-rlm-runtime session is closed");
    }
    notifySubagents() {
        this.options.subagentsChanged?.();
        this.options.parent?.updateSubagents(this.me(), this.listActiveSubagents());
    }
}
function loadTranscriptFile(sessionFile) {
    if (!sessionFile || !existsSync(sessionFile))
        return [];
    try {
        return readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message).filter(Boolean);
    }
    catch {
        return [];
    }
}
function formatTranscriptMessage(message) {
    if (!message || typeof message !== "object")
        return "";
    const role = typeof message.role === "string" ? message.role : "message";
    const label = role === "toolResult" ? `tool result${message.toolName ? ` · ${message.toolName}` : ""}` : role;
    const content = formatTranscriptContent(message.content);
    return content ? `${label}\n${content}` : "";
}
function formatTranscriptContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content.map((part) => {
        if (!part || typeof part !== "object")
            return "";
        if (part.type === "text" || part.type === "thinking")
            return String(part.text ?? "");
        if (part.type === "toolCall") {
            const name = part.name ?? "tool";
            if (name === "ipython" && typeof part.arguments?.code === "string") {
                const code = part.arguments.code.split("\n").map((line, index) => `${index === 0 ? "$ " : "  "}${line}`).join("\n");
                return `→ ipython\n${code}`;
            }
            const args = part.arguments === undefined ? "" : `\n${JSON.stringify(part.arguments, null, 2)}`;
            return `→ ${name}${args}`;
        }
        if (part.type === "image")
            return "[image]";
        return "";
    }).filter(Boolean).join("\n");
}
function updateSubagentActivity(subagent, event) {
    switch (event.type) {
        case "agent_start":
            subagent.activity = "starting";
            break;
        case "turn_start":
            subagent.activity = "thinking";
            break;
        case "message_update":
            subagent.activity = "thinking";
            break;
        case "tool_execution_start":
            subagent.toolName = event.toolName;
            subagent.toolStartedAt = Date.now();
            subagent.activity = `running ${event.toolName}`;
            subagent.command = toolCommand(event.toolName, event.args);
            subagent.output = undefined;
            break;
        case "tool_execution_update": {
            if (subagent.toolName && subagent.toolStartedAt)
                subagent.activity = `running ${subagent.toolName} ${formatDuration(Date.now() - subagent.toolStartedAt)}`;
            const text = contentText(event.partialResult?.content);
            if (text)
                subagent.output = summarizeOutput(text);
            break;
        }
        case "tool_execution_end": {
            const text = contentText(event.result?.content);
            const duration = subagent.toolStartedAt ? ` in ${formatDuration(Date.now() - subagent.toolStartedAt)}` : "";
            subagent.activity = event.isError ? `failed ${event.toolName}${duration}` : `finished ${event.toolName}${duration}`;
            if (text)
                subagent.output = summarizeOutput(text);
            delete subagent.toolName;
            delete subagent.toolStartedAt;
            break;
        }
        case "agent_settled":
            subagent.activity = "idle";
            break;
    }
}
function toolCommand(toolName, args) {
    if (toolName === "ipython" && typeof args?.code === "string") {
        const lines = args.code.trim().split("\n").filter(Boolean);
        const code = lines.length > 1 && lines[0].trim() === "%%bash" ? lines.slice(1).join(" && ") : lines[0] ?? "";
        return `$ ${trimActivity(code)}`;
    }
    const serialized = args === undefined ? "" : JSON.stringify(args);
    return `${toolName}${serialized ? ` ${trimActivity(serialized)}` : ""}`;
}
function contentText(content) {
    if (!Array.isArray(content))
        return "";
    return content
        .filter((part) => part?.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n");
}
function trimActivity(value, limit = 180) {
    const text = String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
function formatDuration(milliseconds) {
    return milliseconds < 1000 ? `${Math.max(0, Math.round(milliseconds))}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}
function summarizeOutput(value) {
    let text = String(value);
    const separator = text.indexOf("\n\n");
    if (separator >= 0 && (text.startsWith("$ ") || text.startsWith("[command]")))
        text = text.slice(separator + 2);
    text = text.replace(/\s+\[(?:running|exit [01]) \| [^\]]+\]\s*$/, "");
    return trimActivity(text);
}
function subagentInfo(subagent) {
    return {
        id: subagent.sessionId,
        name: subagent.name,
        session_dir: subagent.sessionFile ? dirname(subagent.sessionFile) : null,
        model: subagent.model,
        status: status(subagent),
    };
}
function status(subagent) {
    return subagent.agent ? (subagent.agent.session.isStreaming ? "running" : "idle") : "dormant";
}
function sortedSubagents(subagents) {
    return [...subagents].sort((left, right) => left.name.localeCompare(right.name));
}
function sessionModels(ctx) {
    return ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
}
function modelOf(ctx, selector) {
    const slash = selector.indexOf("/");
    if (slash < 1)
        throw new Error(`Stored sub-agent model is invalid: ${selector}`);
    const model = ctx.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
    if (!model)
        throw new Error(`Sub-agent model is unavailable: ${selector}`);
    return model;
}
function roleOf(value) {
    if (value === "parent" || value === "sibling" || value === "subagent")
        return value;
    throw new Error('receiver_role must be "parent", "sibling", or "subagent"');
}
function agentName(value, label = "receiver_name") {
    const parsed = text(value, label, MAX_NAME);
    for (const character of parsed) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
            throw new Error("Names cannot contain control characters");
        }
    }
    return parsed;
}
function lastAssistant(session) {
    if (!session)
        return { text: "" };
    for (let index = session.agent.state.messages.length - 1; index >= 0; index--) {
        const message = session.agent.state.messages[index];
        if (message?.role !== "assistant")
            continue;
        const text = message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim();
        if (message.stopReason === "error" || message.stopReason === "aborted") {
            return { text, error: message.errorMessage || `Agent stopped: ${message.stopReason}` };
        }
        return { text };
    }
    return { text: "" };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function text(value, label, max) {
    if (typeof value !== "string")
        throw new Error(`${label} must be a string`);
    const parsed = value.trim();
    if (!parsed)
        throw new Error(`${label} must not be empty`);
    if (max !== undefined && parsed.length > max)
        throw new Error(`${label} must be at most ${max} characters`);
    return parsed;
}
const KERNEL_DIRECTIVE = /^(?:#\s*)?%%kernel(?:\s+(.*))?$/;
function parseKernelDirective(code) {
    const firstLine = String(code).split("\n", 1)[0].trim();
    const match = firstLine.match(KERNEL_DIRECTIVE);
    return match ? (match[1] ?? "").trim() : undefined;
}
function abortErr() {
    const e = new Error("Operation aborted");
    e.name = "AbortError";
    return e;
}
