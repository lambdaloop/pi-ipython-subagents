import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildPiRlmRuntimePrompt } from "./prompt.js";
import { SessionRuntime } from "./session.js";
import { loadRecursion, MAX_DEPTH } from "./state.js";
import { SUBAGENT_EXTENSION_NAME } from "./subagent.js";
import { createIpythonRenderers } from "./render.js";
import { browseSubagent, showSubagents } from "./ui.js";
const IPYTHON_TOOL = "ipython";
const RUNTIME_FLAG = "rlm-runtime";
const NO_RUNTIME_FLAG = "no-rlm-runtime";
const MAX_DEPTH_FLAG = "rlm-runtime-max-depth";
const DEFAULT_MAX_DEPTH = 4;
const UPDATE_INTERVAL_MS = 100;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(packageRoot, "python");
const ipythonParameters = Type.Object({
    code: Type.String({
        minLength: 1,
        maxLength: 262_144,
        description: "Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. A cell whose first line is `%%kernel` lists the available kernel environments, and `%%kernel pixi` / `%%kernel uv` / `%%kernel python /abs/path` restarts the kernel in that environment. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
    }),
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
    const enabled = () => subagent !== undefined || (pi.getFlag(RUNTIME_FLAG) === true && pi.getFlag(NO_RUNTIME_FLAG) !== true);
    const stopRuntime = async () => {
        const current = runtime;
        runtime = undefined;
        await current?.dispose();
    };
    registerStop?.(stopRuntime);
    const runtimeFor = (ctx) => {
        uiContext = ctx;
        if (runtime) {
            runtime.updateContext(ctx);
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
                    showSubagents(uiContext, runtime, subagentsExpanded);
            },
            makeExtension: createPiRlmRuntimeExtension,
        });
        showSubagents(ctx, runtime, subagentsExpanded);
        return runtime;
    };
    if (!subagent) {
        const toggleSubagents = (ctx) => {
            if (!runtime?.listActiveSubagents().length) {
                ctx.ui.notify("No active sub-agents", "info");
                return;
            }
            subagentsExpanded = !subagentsExpanded;
            showSubagents(ctx, runtime, subagentsExpanded);
        };
        pi.registerCommand("subagents", {
            description: "Toggle the active sub-agent tree",
            handler: async (_args, ctx) => toggleSubagents(ctx),
        });
        pi.registerCommand("subagent", {
            description: "Browse a live RLM sub-agent transcript",
            handler: async (args, ctx) => browseSubagent(ctx, runtimeFor(ctx), args),
        });
        pi.registerShortcut("ctrl+alt+s", {
            description: "Browse a live RLM sub-agent transcript",
            handler: async (ctx) => browseSubagent(ctx, runtimeFor(ctx)),
        });
        pi.registerShortcut("ctrl+alt+a", {
            description: "Toggle the active sub-agent tree",
            handler: toggleSubagents,
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
            description: "Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls. Start a cell with `%%kernel` to list or switch the kernel's Python environment (for example `%%kernel pixi` for the project's local pixi environment). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
            promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
            parameters: ipythonParameters,
            executionMode: "sequential",
            ...createIpythonRenderers(),
            async execute(_toolCallId, { code }, signal, onUpdate, ctx) {
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
                    const result = await live.execute(code, signal, update);
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
        else
            showSubagents(ctx, undefined, subagentsExpanded);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
        await stopRuntime();
        showSubagents(ctx, undefined, subagentsExpanded);
    });
}
/**
 * Tool policy. A sub-agent works through IPython alone; the main session keeps
 * every active tool and gains IPython alongside them.
 */
export function syncActiveTools(pi, subagent) {
    const tools = pi.getActiveTools();
    if (subagent) {
        if (tools.length !== 1 || tools[0] !== IPYTHON_TOOL)
            pi.setActiveTools([IPYTHON_TOOL]);
        return;
    }
    if (!tools.includes(IPYTHON_TOOL))
        pi.setActiveTools([...tools, IPYTHON_TOOL]);
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
