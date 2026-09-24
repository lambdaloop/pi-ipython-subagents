import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildPiRlmRuntimePrompt } from "./prompt.js";
import { createIpythonRenderers } from "./render.js";
import { RLM_USAGE_ENTRY, SessionRuntime } from "./session.js";
import { loadRecursion, MAX_DEPTH } from "./state.js";
import { SUBAGENT_EXTENSION_NAME } from "./subagent.js";
import { browseSubagent, showSubagents, subagentTreeView } from "./ui.js";

const IPYTHON_TOOL = "ipython";
const DISABLED_MAIN_TOOLS = new Set(["bash", "powershell"]);
const RUNTIME_FLAG = "rlm-runtime";
const NO_RUNTIME_FLAG = "no-rlm-runtime";
const MAX_DEPTH_FLAG = "rlm-runtime-max-depth";
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_IPYTHON_TIMEOUT_SECONDS = 20;
const UPDATE_INTERVAL_MS = 100;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(packageRoot, "python");
const USAGE_PATCH_MARK = Symbol.for("pi-rlm-runtime.usage-patch");
function externalUsage(entry) {
    return entry?.type === "custom" && entry.customType === RLM_USAGE_ENTRY ? entry.data?.usage : undefined;
}
function usageTotals(entries) {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const entry of entries) {
        const usage = externalUsage(entry);
        if (!usage)
            continue;
        totals.input += Number(usage.input) || 0;
        totals.output += Number(usage.output) || 0;
        totals.cacheRead += Number(usage.cacheRead) || 0;
        totals.cacheWrite += Number(usage.cacheWrite) || 0;
        totals.cost += Number(usage.cost?.total) || 0;
    }
    return totals;
}
function isUsageConsumer() {
    const stack = new Error().stack ?? "";
    return (stack.includes("FooterComponent.render") ||
        stack.includes("AgentSession.getSessionStats") ||
        stack.includes("InteractiveMode.handleSessionCommand") ||
        stack.includes("getUsageCostBreakdown"));
}
function installUsageAccountingPatch(sessionManager) {
    const prototype = sessionManager?.constructor?.prototype;
    if (!prototype || prototype[USAGE_PATCH_MARK])
        return;
    prototype[USAGE_PATCH_MARK] = true;
    const originalGetEntries = prototype.getEntries;
    prototype.getEntries = function (...args) {
        const entries = originalGetEntries.apply(this, args);
        if (!isUsageConsumer())
            return entries;
        const extra = usageTotals(entries);
        if (!extra.input && !extra.output && !extra.cacheRead && !extra.cacheWrite && !extra.cost)
            return entries;
        // Both the footer and getSessionStats already understand compaction
        // usage. This ephemeral entry is never persisted and never enters LLM
        // context; it only bridges extension telemetry into Pi's built-in views.
        return [...entries, { type: "compaction", usage: {
                    input: extra.input,
                    output: extra.output,
                    cacheRead: extra.cacheRead,
                    cacheWrite: extra.cacheWrite,
                    totalTokens: extra.input + extra.output + extra.cacheRead + extra.cacheWrite,
                    cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: extra.cost,
                    },
                } }];
    };
}
const ipythonParameters = Type.Object({
    code: Type.String({
        minLength: 1,
        maxLength: 262_144,
        description: "Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. A cell whose first line is `%%kernel` lists the available kernel environments, and `%%kernel pixi` / `%%kernel uv` / `%%kernel python /abs/path` restarts the kernel in that environment. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
    }),
    timeout_seconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 3600,
        description: "Seconds this cell may run before it is interrupted (default 20). Raise it only for a specific slow step; use bg(...) for genuinely long-running work.",
    })),
}, { additionalProperties: false });
function createPiRlmRuntimeExtension(subagent, registerStop) {
    return {
        name: subagent ? SUBAGENT_EXTENSION_NAME : "pi-rlm-runtime",
        hidden: subagent !== undefined,
        factory: (pi) => bindExtension(pi, subagent, registerStop),
    };
}
function bindExtension(pi, subagent, registerStop) {
    if (!subagent) {
        pi.registerFlag(RUNTIME_FLAG, {
            description: "Run this Pi session with pi-rlm-runtime",
            type: "boolean",
            default: true,
        });
        pi.registerFlag(NO_RUNTIME_FLAG, {
            description: "Disable the automatically enabled pi-rlm-runtime",
            type: "boolean",
            default: false,
        });
        pi.registerFlag(MAX_DEPTH_FLAG, {
            description: "Maximum rlm() sub-agent depth (0-16)",
            type: "string",
            default: String(DEFAULT_MAX_DEPTH),
        });
    }
    let runtime;
    let uiContext;
    let toolRegistered = false;
    let subagentsExpanded = false;
    let selectedSubagent;
    let unsubscribeSelectionInput;
    let activityRefreshTimer;
    const enabled = () => subagent !== undefined || (pi.getFlag(RUNTIME_FLAG) === true && pi.getFlag(NO_RUNTIME_FLAG) !== true);
    const stopRuntime = async () => {
        const current = runtime;
        runtime = undefined;
        await current?.dispose();
    };
    const activeRows = (live) => subagentTreeView(live?.listActiveSubagents() ?? [], Number.MAX_SAFE_INTEGER).rows;
    const stopActivityRefresh = () => {
        if (!activityRefreshTimer)
            return;
        clearInterval(activityRefreshTimer);
        activityRefreshTimer = undefined;
    };
    const syncActivityRefresh = (ctx, live) => {
        if (subagent || !ctx.hasUI || ctx.mode !== "tui" || !live?.listActiveSubagents().some((item) => item.status === "running")) {
            stopActivityRefresh();
            return;
        }
        if (activityRefreshTimer)
            return;
        activityRefreshTimer = setInterval(() => {
            if (!runtime || !uiContext || !runtime.listActiveSubagents().some((item) => item.status === "running")) {
                stopActivityRefresh();
                return;
            }
            if (subagentsExpanded)
                redrawSubagents(uiContext, runtime, true);
        }, 1000);
        activityRefreshTimer.unref?.();
    };
    const redrawSubagents = (ctx, live, expanded = subagentsExpanded) => {
        if (selectedSubagent && !activeRows(live).some(({ subagent: item }) => item.name === selectedSubagent))
            selectedSubagent = undefined;
        showSubagents(ctx, live, expanded, selectedSubagent);
        syncActivityRefresh(ctx, live);
    };
    const clearSelection = (ctx) => {
        if (!selectedSubagent)
            return;
        selectedSubagent = undefined;
        if (runtime)
            redrawSubagents(ctx, runtime);
    };
    const ensureSelectionInput = (ctx) => {
        if (subagent || unsubscribeSelectionInput || !ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui.onTerminalInput !== "function")
            return;
        unsubscribeSelectionInput = ctx.ui.onTerminalInput((data) => {
            const selected = selectedSubagent;
            if (!selected)
                return;
            if (matchesKey(data, Key.enter)) {
                const editorText = ctx.ui.getEditorText?.() ?? "";
                if (editorText.trim()) {
                    clearSelection(ctx);
                    return;
                }
                selectedSubagent = undefined;
                const live = runtime;
                if (live)
                    redrawSubagents(ctx, live);
                if (live)
                    void browseSubagent(ctx, live, selected);
                return { consume: true };
            }
            if (matchesKey(data, Key.escape)) {
                clearSelection(ctx);
            }
        });
    };
    // Subagents have independent sessions, so forward each completed assistant
    // response's provider usage to the parent session. The parent stores it as
    // a context-excluded usage entry and forwards it upward for nested RLM.
    if (subagent) {
        pi.on("message_end", (event) => {
            const message = event.message;
            if (message.role !== "assistant" || !message.usage)
                return;
            subagent.parent.recordUsage(message.usage, {
                sourceTimestamp: message.timestamp,
                model: message.provider + "/" + (message.responseModel ?? message.model),
            });
        });
    }
    registerStop?.(async () => {
        unsubscribeSelectionInput?.();
        unsubscribeSelectionInput = undefined;
        selectedSubagent = undefined;
        stopActivityRefresh();
        await stopRuntime();
    });
    const runtimeFor = (ctx) => {
        installUsageAccountingPatch(ctx.sessionManager);
        uiContext = ctx;
        if (runtime) {
            runtime.updateContext(ctx);
            if (!subagent)
                ensureSelectionInput(ctx);
            return runtime;
        }
        const recursion = subagent ??
            loadRecursion(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId(), {
                depth: 0,
                maxDepth: configuredMaxDepth(pi),
            });
        runtime = new SessionRuntime({
            pi,
            ctx,
            depth: recursion.depth,
            maxDepth: recursion.maxDepth,
            ...(subagent ? { parent: subagent.parent } : {}),
            agentDir: getAgentDir(),
            runtimeDir,
            ...(subagent ? { runtime: subagent.runtime } : {}),
            subagentsChanged: () => {
                if (runtime && uiContext)
                    redrawSubagents(uiContext, runtime);
            },
            makeExtension: createPiRlmRuntimeExtension,
        });
        if (!subagent)
            ensureSelectionInput(ctx);
        redrawSubagents(ctx, runtime);
        return runtime;
    };
    if (!subagent) {
        const stepSubagentSelection = (ctx, direction) => {
            const live = runtimeFor(ctx);
            const rows = activeRows(live);
            if (!rows.length) {
                selectedSubagent = undefined;
                ctx.ui.notify("No active sub-agents or background tasks", "info");
                redrawSubagents(ctx, live);
                return;
            }
            const names = rows.map(({ subagent: item }) => item.name);
            let currentIndex = names.indexOf(selectedSubagent ?? "");
            if (currentIndex < 0)
                currentIndex = direction > 0 ? -1 : 0;
            selectedSubagent = names[(currentIndex + direction + names.length) % names.length];
            subagentsExpanded = true;
            ensureSelectionInput(ctx);
            redrawSubagents(ctx, live, true);
        };
        const toggleSubagents = (ctx) => {
            if (!runtime?.listActiveSubagents().length) {
                ctx.ui.notify("No active sub-agents or background tasks", "info");
                return;
            }
            subagentsExpanded = !subagentsExpanded;
            if (!subagentsExpanded)
                selectedSubagent = undefined;
            redrawSubagents(ctx, runtime);
        };
        pi.registerCommand("subagents", {
            description: "Toggle the active sub-agent tree",
            handler: async (_args, ctx) => toggleSubagents(ctx),
        });
        pi.registerCommand("subagent", {
            description: "Browse a live RLM sub-agent or background task transcript",
            handler: async (args, ctx) => browseSubagent(ctx, runtimeFor(ctx), args),
        });
        pi.registerCommand("ipython-subagent", {
            description: "Choose the default model for IPython sub-agents",
            handler: async (args, ctx) => {
                const live = runtimeFor(ctx);
                const requested = args.trim();
                if (requested.toLowerCase() === "off" || requested.toLowerCase() === "reset") {
                    live.setDefaultSubagentModel(undefined);
                    ctx.ui.notify("Default sub-agent model cleared; sub-agents will inherit the current model.", "info");
                    return;
                }
                if (requested) {
                    live.setDefaultSubagentModel(requested);
                    ctx.ui.notify(`Default IPython sub-agent model: ${requested}`, "info");
                    return;
                }
                const models = ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
                const current = live.getDefaultSubagentModel();
                const choices = models.map((model) => `${model.name} (${model.provider}/${model.id})`);
                const modelByChoice = new Map(models.map((model) => [`${model.name} (${model.provider}/${model.id})`, `${model.provider}/${model.id}`]));
                choices.unshift("Use current model");
                if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
                    ctx.ui.notify(`Default IPython sub-agent model: ${current ?? "current session model"}. Run /ipython-subagent provider/model or /ipython-subagent off to change it.`, "info");
                    return;
                }
                const selected = await ctx.ui.select("Default IPython sub-agent model", choices);
                if (selected === undefined)
                    return;
                const selector = modelByChoice.get(selected);
                live.setDefaultSubagentModel(selector);
                ctx.ui.notify(selector ? `Default IPython sub-agent model: ${selector}` : "Default sub-agent model cleared.", "info");
            },
        });
        pi.registerShortcut("ctrl+alt+s", {
            description: "Browse a live RLM sub-agent or background task transcript",
            handler: async (ctx) => browseSubagent(ctx, runtimeFor(ctx)),
        });
        pi.registerShortcut("ctrl+alt+a", {
            description: "Toggle the active sub-agent tree",
            handler: toggleSubagents,
        });
        pi.registerShortcut("shift+up", {
            description: "Select the previous sub-agent or background task",
            handler: async (ctx) => stepSubagentSelection(ctx, -1),
        });
        pi.registerShortcut("shift+down", {
            description: "Select the next sub-agent or background task",
            handler: async (ctx) => stepSubagentSelection(ctx, 1),
        });
    }
    const registerIpythonTool = () => {
        if (toolRegistered)
            return;
        if (!subagent && pi.getAllTools().some((tool) => tool.name === IPYTHON_TOOL)) {
            throw new Error("Another extension already registered an ipython tool");
        }
        pi.registerTool({
            name: IPYTHON_TOOL,
            label: "ipython",
            description: "Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls. Start a cell with `%%kernel` to list or switch the kernel's Python environment (for example `%%kernel pixi` for the project's local pixi environment). The preloaded `bg(...)` wrapper starts our own tracked long-running shell tasks from Python. Preloaded `rg_files(...)` and `rg_search(...)` helpers are the expected way to find files and code. Cells are interrupted after 20 seconds by default; pass timeout_seconds explicitly for a specific slow step, or use bg(...) for genuinely long-running work. Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
            promptSnippet: "ipython - persistent agent notebook for Python, %%bash, tracked bg(...) tasks, and bounded rg search (20s default timeout)",
            parameters: ipythonParameters,
            executionMode: "sequential",
            ...createIpythonRenderers(),
            async execute(_toolCallId, { code, timeout_seconds }, signal, onUpdate, ctx) {
                const live = runtimeFor(ctx);
                const startedAt = Date.now();
                let timer;
                let update;
                if (onUpdate) {
                    let stdout = "";
                    let stderr = "";
                    let lastUpdate = 0;
                    const flush = () => {
                        timer = undefined;
                        lastUpdate = Date.now();
                        onUpdate({
                            content: textContent(formatLive(code, stdout, stderr, startedAt)),
                            details: {
                                status: "running",
                                output: formatStreams(stdout, stderr),
                                durationMs: Date.now() - startedAt,
                            },
                        });
                    };
                    // Show the cell before the kernel produces any output. This is
                    // especially useful for %%bash cells, whose command otherwise
                    // disappears behind the tool spinner.
                    flush();
                    update = (chunk) => {
                        if (chunk.stream === "stdout")
                            stdout += chunk.text;
                        else
                            stderr += chunk.text;
                        if (timer)
                            return;
                        const wait = UPDATE_INTERVAL_MS - (Date.now() - lastUpdate);
                        if (wait <= 0)
                            flush();
                        else
                            timer = setTimeout(flush, wait);
                    };
                }
                try {
                    const result = await live.execute(code, signal, update, (timeout_seconds ?? DEFAULT_IPYTHON_TIMEOUT_SECONDS) * 1000);
                    if (result.status === "error")
                        throw kernelError(code, result);
                    return {
                        content: resultContent(code, result),
                        details: {
                            status: "ok",
                            durationMs: result.durationMs,
                            executionCount: result.executionCount,
                            output: formatResult(result),
                        },
                    };
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            },
        });
        toolRegistered = true;
    };
    const useIpython = () => {
        if (!enabled())
            return;
        syncActiveTools(pi, subagent !== undefined);
    };
    if (subagent)
        registerIpythonTool();
    pi.on("session_start", (_event, ctx) => {
        if (!enabled())
            return;
        registerIpythonTool();
        useIpython();
        runtimeFor(ctx);
    });
    pi.on("before_agent_start", (event, ctx) => {
        if (!enabled())
            return;
        registerIpythonTool();
        useIpython();
        const live = runtimeFor(ctx);
        const rlmPrompt = buildPiRlmRuntimePrompt({
            cwd: ctx.cwd,
            messagesPath: ctx.sessionManager.getSessionFile() ?? "not persisted",
            depth: live.depth,
            maxDepth: live.maxDepth,
            ...(!subagent && live.getDefaultSubagentModel() ? { defaultSubagentModel: live.getDefaultSubagentModel() } : {}),
            ...(subagent ? { parentName: subagent.parent.name } : {}),
        });
        return {
            // Keep Pi's assembled system prompt (native tool guidance, project
            // context, skills, and user configuration) and append RLM guidance.
            systemPrompt: [event.systemPrompt, rlmPrompt].filter(Boolean).join("\n\n"),
        };
    });
    pi.on("turn_start", useIpython);
    pi.on("session_tree", async (_event, ctx) => {
        uiContext = ctx;
        if (runtime)
            await runtime.refresh(ctx);
        else {
            selectedSubagent = undefined;
            showSubagents(ctx, undefined, subagentsExpanded);
        }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        unsubscribeSelectionInput?.();
        unsubscribeSelectionInput = undefined;
        selectedSubagent = undefined;
        stopActivityRefresh();
        await stopRuntime();
        showSubagents(ctx, undefined, subagentsExpanded);
    });
}
/**
 * Tool policy. Sub-agents work through IPython alone; the main session keeps
 * native tools except for shell tools, and gains IPython alongside them.
 */
export function syncActiveTools(pi, subagent) {
    const tools = pi.getActiveTools();
    if (subagent) {
        if (tools.length !== 1 || tools[0] !== IPYTHON_TOOL)
            pi.setActiveTools([IPYTHON_TOOL]);
        return;
    }
    const filtered = tools.filter((name) => !DISABLED_MAIN_TOOLS.has(name));
    if (!filtered.includes(IPYTHON_TOOL))
        filtered.push(IPYTHON_TOOL);
    if (filtered.length !== tools.length || filtered.some((name, index) => name !== tools[index]))
        pi.setActiveTools(filtered);
}
function configuredMaxDepth(pi) {
    const value = Number(pi.getFlag(MAX_DEPTH_FLAG) ?? DEFAULT_MAX_DEPTH);
    if (!Number.isInteger(value) || value < 0 || value > MAX_DEPTH) {
        throw new Error(`--${MAX_DEPTH_FLAG} must be an integer from 0 to ${MAX_DEPTH}`);
    }
    return value;
}
function resultContent(code, result) {
    const output = formatResult(result);
    const status = result.status === "error" ? "exit 1" : "exit 0";
    const text = formatInvocation(code, output || (result.attachments.length ? "" : "(no output)"), `${status} | ${formatDuration(result.durationMs)}`);
    return [
        ...(text ? [{ type: "text", text }] : []),
        ...result.attachments.map((attachment) => ({
            type: "image",
            data: attachment.data,
            mimeType: attachment.mimeType,
        })),
    ];
}
function kernelError(code, result) {
    const output = formatResult(result);
    const failure = result.error?.traceback.join("\n") ||
        [result.error?.ename, result.error?.evalue].filter(Boolean).join(": ") ||
        "IPython execution failed";
    return new Error(formatInvocation(code, output ? `${output}\n\n${failure}` : failure, `exit 1 | ${formatDuration(result.durationMs)}`));
}
function formatResult(result) {
    return [result.stdout, result.stderr && `[stderr]\n${result.stderr}`, result.display, result.result]
        .filter(Boolean)
        .join("\n");
}
function formatInvocation(code, output, footer) {
    const lines = String(code).split("\n");
    const command = lines.map((line, index) => `${index === 0 ? "$ " : "  "}${line}`).join("\n");
    return `${command}\n\n${output || "(no output)"}\n\n[${footer}]`;
}
function formatDuration(durationMs) {
    const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}
function formatLive(code, stdout, stderr, startedAt) {
    return formatInvocation(code, formatStreams(stdout, stderr) || "(running…)", `running | ${formatDuration(Date.now() - startedAt)}`);
}
function formatStreams(stdout, stderr) {
    return [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n");
}
function textContent(text) {
    return text ? [{ type: "text", text }] : [];
}
export default function piRlmRuntime(pi) {
    bindExtension(pi);
}
