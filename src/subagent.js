import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { loadRecursion, NODE_ENTRY } from "./state.js";
export const SUBAGENT_EXTENSION_NAME = "pi-rlm-runtime-subagent";
const ROOT_EXTENSION_PATH = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "index.js"));
function isRootExtension(loaded) {
    try {
        return realpathSync(loaded.resolvedPath) === ROOT_EXTENSION_PATH;
    }
    catch {
        return false;
    }
}
export function filterChildExtensions(result) {
    return {
        ...result,
        extensions: result.extensions.filter((loaded) => !isRootExtension(loaded)),
    };
}
export async function startSubagent(options) {
    if (options.signal?.aborted)
        throw aborted();
    mkdirSync(options.subagentDir, { recursive: true });
    const isNew = options.sessionFile === undefined;
    const sessions = options.sessionFile
        ? SessionManager.open(options.sessionFile)
        : SessionManager.create(options.cwd, options.subagentDir);
    const sessionId = sessions.getSessionId();
    const name = options.name ?? defaultName(options.task ?? "subagent", sessionId);
    const recursion = isNew
        ? { depth: options.depth, maxDepth: options.maxDepth }
        : loadRecursion(sessions.getBranch(), sessionId, { depth: options.depth, maxDepth: options.maxDepth });
    if (isNew) {
        sessions.appendSessionInfo(name);
        sessions.appendCustomEntry(NODE_ENTRY, {
            version: 1,
            sessionId,
            depth: recursion.depth,
            maxDepth: recursion.maxDepth,
        });
    }
    let stop;
    const extension = options.makeExtension({
        runtime: options.runtime,
        depth: recursion.depth,
        maxDepth: recursion.maxDepth,
        parent: options.parent,
    }, (fn) => {
        stop = fn;
    });
    let session;
    let bound = false;
    try {
        const services = await createAgentSessionServices({
            cwd: options.cwd,
            agentDir: options.agentDir,
            settingsManager: SettingsManager.create(options.cwd, options.agentDir, {
                projectTrusted: options.projectTrusted,
            }),
            ...(options.signal ? { modelRuntimeSignal: options.signal } : {}),
            resourceLoaderOptions: {
                extensionFactories: [extension],
                // The package is discovered from the user's settings as well as
                // injected here with the child-scoped runtime. Keep the normal
                // extension set, but remove that duplicate top-level instance.
                extensionsOverride: filterChildExtensions,
            },
        });
        if (options.signal?.aborted)
            throw aborted();
        const errors = services.diagnostics.filter((d) => d.type === "error");
        if (errors.length)
            throw new Error(errors.map((e) => e.message).join("; "));
        const model = services.modelRuntime.getModel(options.model.provider, options.model.id);
        if (!model)
            throw new Error(`Model unavailable: ${options.model.provider}/${options.model.id}`);
        session = (await createAgentSessionFromServices({
            services,
            sessionManager: sessions,
            model,
            ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
            // Sub-agents work through IPython only; the RLM extension enforces
            // the same allowlist on every turn.
            tools: ["ipython"],
            sessionStartEvent: { type: "session_start", reason: "startup" },
        })).session;
        await session.bindExtensions({ mode: "print" });
        bound = true;
        if (options.signal?.aborted)
            throw aborted();
        const live = session;
        let closed = false;
        return {
            session: live,
            sessionId,
            ...(live.sessionFile ? { sessionFile: live.sessionFile } : {}),
            name,
            model: `${model.provider}/${model.id}`,
            prompt(text, signal) {
                return runPrompt(live, `[task from parent]\n\n${text}`, signal);
            },
            async close() {
                if (closed)
                    return;
                closed = true;
                await shutdown(live, stop, true);
            },
        };
    }
    catch (error) {
        if (session)
            await shutdown(session, stop, bound).catch(() => undefined);
        else
            await stop?.().catch(() => undefined);
        if (isNew) {
            const file = sessions.getSessionFile();
            if (file)
                rmSync(file, { force: true });
        }
        throw error;
    }
}
async function shutdown(session, stop, bound) {
    try {
        await session.abort().catch(() => undefined);
        if (bound)
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        else
            await stop?.();
    }
    finally {
        session.dispose();
    }
}
function runPrompt(session, prompt, signal) {
    if (signal?.aborted) {
        const stopped = Promise.reject(aborted());
        return { accepted: stopped, finished: stopped };
    }
    let settled = false;
    let accept;
    let reject;
    let unsubscribe = () => undefined;
    const accepted = new Promise((resolve, rejectPromise) => {
        accept = resolve;
        reject = rejectPromise;
    });
    const settle = (finish) => {
        if (settled)
            return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        finish();
    };
    const onAbort = () => settle(() => reject(aborted()));
    unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_start")
            settle(accept);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    const finished = session
        .prompt(prompt, {
        expandPromptTemplates: false,
        source: "extension",
    })
        .then(() => settle(() => reject(new Error("Sub-agent stopped before starting"))))
        .catch((error) => {
        settle(() => reject(error));
        throw error;
    });
    return { accepted, finished };
}
function defaultName(prompt, sessionId) {
    const slug = prompt
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    return `${slug || "subagent"}-${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-8)}`;
}
function aborted() {
    const e = new Error("Sub-agent creation aborted");
    e.name = "AbortError";
    return e;
}
