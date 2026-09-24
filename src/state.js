export const SUBAGENT_ENTRY = "pi-rlm-runtime.subagent";
export const NODE_ENTRY = "pi-rlm-runtime.node";
export const DEFAULT_SUBAGENT_MODEL_ENTRY = "pi-rlm-runtime.default-subagent-model";
export const MAX_DEPTH = 16;
export function loadSubagents(entries, ownerSessionId) {
    const subagents = new Map();
    for (const entry of entries) {
        if (entry.type !== "custom" ||
            entry.customType !== SUBAGENT_ENTRY ||
            !entry.data ||
            typeof entry.data !== "object") {
            continue;
        }
        const change = entry.data;
        if (change.version !== 1 || change.ownerSessionId !== ownerSessionId)
            continue;
        if (change.action === "delete" && typeof change.subagentSessionId === "string") {
            subagents.delete(change.subagentSessionId);
        }
        else if (change.action === "create" && subagentRecord(change.subagent)) {
            subagents.set(change.subagent.sessionId, change.subagent);
        }
    }
    return subagents;
}
export function loadDefaultSubagentModel(entries, sessionId) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== DEFAULT_SUBAGENT_MODEL_ENTRY || !entry.data || typeof entry.data !== "object")
            continue;
        const value = entry.data;
        if (value.version === 1 && value.sessionId === sessionId && (typeof value.model === "string" || value.model === null))
            return value.model ?? undefined;
    }
    return undefined;
}
export function defaultSubagentModel(sessionId, model) {
    return { version: 1, sessionId, model: model ?? null };
}
export function loadRecursion(entries, sessionId, fallback) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== NODE_ENTRY || !entry.data || typeof entry.data !== "object") {
            continue;
        }
        const node = entry.data;
        const { depth, maxDepth } = node;
        if (node.version === 1 &&
            node.sessionId === sessionId &&
            typeof depth === "number" &&
            typeof maxDepth === "number" &&
            Number.isInteger(depth) &&
            Number.isInteger(maxDepth) &&
            depth >= 0 &&
            maxDepth >= depth &&
            maxDepth <= MAX_DEPTH) {
            return { depth, maxDepth };
        }
    }
    return fallback;
}
export function subagentCreated(ownerSessionId, subagent) {
    return {
        version: 1,
        ownerSessionId,
        action: "create",
        subagent: {
            sessionId: subagent.sessionId,
            name: subagent.name,
            ...(subagent.sessionFile ? { sessionFile: subagent.sessionFile } : {}),
            model: subagent.model,
        },
    };
}
export function subagentDeleted(ownerSessionId, subagentSessionId) {
    return { version: 1, ownerSessionId, action: "delete", subagentSessionId };
}
function subagentRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const subagent = value;
    return (typeof subagent.sessionId === "string" &&
        typeof subagent.name === "string" &&
        typeof subagent.model === "string" &&
        (subagent.sessionFile === undefined || typeof subagent.sessionFile === "string"));
}
