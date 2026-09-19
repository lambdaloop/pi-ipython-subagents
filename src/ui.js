import { Key, matchesKey, ScrollView, Text, VStack } from "@earendil-works/pi-tui";

const SUBAGENTS_WIDGET = "pi-rlm-runtime-subagents";
const MAX_VISIBLE_SUBAGENTS = 12;
const MAX_PREVIEW_LINES = 2;
const MAX_NAME_PREVIEW_CHARS = 48;
const MAX_ACTIVITY_PREVIEW_CHARS = 48;
const MAX_DETAIL_PREVIEW_CHARS = 120;
const MAX_DETAIL_FIELD_CHARS = 80;
function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    if (seconds >= 3600)
        return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
    if (seconds >= 60)
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return milliseconds < 1000 ? `${Math.max(0, Math.round(milliseconds))}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}
function previewText(value, maxChars) {
    const text = String(value ?? "")
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
function liveActivity(subagent) {
    if (subagent.status !== "running" || !Number.isFinite(subagent.startedAt))
        return subagent.activity;
    const elapsed = formatDuration(Date.now() - subagent.startedAt);
    if (subagent.kind === "task")
        return `running ${elapsed}`;
    const activity = String(subagent.activity ?? "");
    if (/^running\s+\S+/.test(activity))
        return `running ${activity.slice("running ".length).split(/\s+/)[0]} ${elapsed}`;
    if (/^thinking\b/.test(activity))
        return `thinking ${elapsed}`;
    if (/^starting\b/.test(activity))
        return `starting ${elapsed}`;
    return activity;
}
class PreservingScrollView extends ScrollView {
    updateLayout(contentHeight, viewportHeight, requestRender) {
        const preserveManualPosition = !this.isFollowingEnd;
        const previousScrollTop = this.scrollTop;
        super.updateLayout(contentHeight, viewportHeight, requestRender);
        if (preserveManualPosition && this.isFollowingEnd) {
            this.scrollTo(previousScrollTop, { disableFollow: true });
        }
    }
}
export function subagentTreeView(subagents, limit = MAX_VISIBLE_SUBAGENTS) {
    const rows = [];
    let running = 0;
    let total = 0;
    const visit = (siblings, ancestors) => {
        for (const [index, subagent] of siblings.entries()) {
            const last = index === siblings.length - 1;
            total++;
            if (subagent.status === "running")
                running++;
            if (rows.length < limit) {
                const indentation = ancestors.map((ancestorWasLast) => (ancestorWasLast ? "   " : "│  ")).join("");
                rows.push({ prefix: `${indentation}${last ? "└─" : "├─"} `, subagent });
            }
            visit(subagent.subagents, [...ancestors, last]);
        }
    };
    visit(subagents, []);
    return { rows, running, total };
}
class SubagentBrowser extends VStack {
    constructor(tui, theme, name, runtime, done) {
        const transcript = new Text("", 1, 0);
        const scroll = new PreservingScrollView(transcript, {
            follow: "end",
            primary: true,
            overscroll: "contain",
            scrollbar: "always",
        });
        const header = new Text("", 1, 0);
        const footer = new Text("", 1, 0);
        super([
            { component: header, basis: 1, grow: 0, shrink: 0, minSize: 1 },
            { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
            { component: footer, basis: 1, grow: 0, shrink: 0, minSize: 1 },
        ]);
        this.tui = tui;
        this.theme = theme;
        this.name = name;
        this.runtime = runtime;
        this.done = done;
        this.transcript = transcript;
        this.scroll = scroll;
        this.header = header;
        this.footer = footer;
        this.closed = false;
        this.refresh = () => {
            if (this.closed)
                return;
            try {
                const body = runtime.subagentTranscript(name);
                const inspectable = (runtime.listInspectable?.() ?? runtime.listSubagents()).find((agent) => agent.name === name);
                const status = inspectable?.status ?? "unknown";
                const kind = inspectable?.kind === "task" ? "background task" : "RLM sub-agent";
                const atBottom = scroll.isFollowingEnd;
                header.setText(theme.fg("accent", `${kind} · ${name} · ${status}`));
                transcript.setText(body);
                footer.setText(theme.fg("muted", `↑/↓ scroll · PgUp/PgDn page · Home/End jump · q/Esc close${atBottom ? " · following latest" : " · paused"}`));
            }
            catch (error) {
                header.setText(theme.fg("warning", `RLM sub-agent · ${name} · unavailable`));
                transcript.setText(error instanceof Error ? error.message : String(error));
                footer.setText(theme.fg("muted", "q/Esc close"));
            }
            this.invalidate();
            tui.requestRender();
        };
        this.refresh();
        this.timer = setInterval(this.refresh, 150);
    }
    handleMouse(event) {
        if (this.closed || event.type !== "wheel" || !event.wheelDelta)
            return;
        this.scroll.scrollBy(event.wheelDelta);
        this.tui.requestRender();
        return { handled: true };
    }
    handleInput(data) {
        if (this.closed)
            return;
        if (data === "q" || data === "Q" || matchesKey(data, Key.escape)) {
            this.close();
            return;
        }
        if (matchesKey(data, Key.pageUp)) {
            this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1));
        }
        else if (matchesKey(data, Key.pageDown)) {
            this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
        }
        else if (matchesKey(data, Key.up)) {
            this.scroll.scrollBy(-1);
        }
        else if (matchesKey(data, Key.down)) {
            this.scroll.scrollBy(1);
        }
        else if (matchesKey(data, Key.home)) {
            this.scroll.scrollToStart();
        }
        else if (matchesKey(data, Key.end)) {
            this.scroll.scrollToEnd();
        }
        else {
            return;
        }
        this.tui.requestRender();
    }
    // Keep direct component rendering usable as well as the host's layout-node
    // overlay path; both paths keep the header and footer fixed.
    render(width) {
        const safeWidth = Math.max(1, width);
        const contentWidth = this.scroll.getContentWidth(safeWidth);
        const contentLines = this.transcript.render(contentWidth);
        const viewportHeight = Math.max(1, Math.floor((this.tui.terminal.rows ?? 24) * 0.88) - 2);
        this.scroll.updateLayout(contentLines.length, viewportHeight, () => this.tui.requestRender());
        const visible = contentLines.slice(this.scroll.scrollTop, this.scroll.scrollTop + viewportHeight);
        while (visible.length < viewportHeight)
            visible.push("");
        return [
            ...this.header.render(safeWidth).slice(0, 1),
            ...visible,
            ...this.footer.render(safeWidth).slice(0, 1),
        ];
    }
    invalidate() {
        super.invalidate();
    }
    dispose() {
        this.close();
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        clearInterval(this.timer);
        this.done(undefined);
    }
}
export async function browseSubagent(ctx, runtime, requestedName) {
    if (!ctx.hasUI || ctx.mode !== "tui" || !runtime)
        return;
    const agents = runtime.listInspectable?.() ?? runtime.listSubagents();
    if (!agents.length) {
        ctx.ui.notify("No RLM sub-agents or background tasks", "info");
        return;
    }
    let name = requestedName?.trim();
    if (!name) {
        name = await ctx.ui.select("Inspect agent or task", agents.map((agent) => `${agent.kind === "task" ? "◆ " : ""}${agent.name}`));
        name = name?.replace(/^◆\s+/, "");
    }
    if (!name)
        return;
    const selected = agents.find((agent) => agent.name === name);
    if (!selected) {
        ctx.ui.notify(`No RLM sub-agent or background task named ${name}`, "error");
        return;
    }
    await ctx.ui.custom((tui, theme, _keybindings, done) => new SubagentBrowser(tui, theme, name, runtime, done), {
        overlay: true,
        overlayOptions: { width: "94%", maxHeight: "88%", anchor: "center" },
    });
}
export function showSubagents(ctx, runtime, expanded, selectedName) {
    if (!ctx.hasUI)
        return;
    const view = subagentTreeView(runtime?.listActiveSubagents() ?? []);
    if (!view.total) {
        ctx.ui.setWidget(SUBAGENTS_WIDGET, undefined);
        return;
    }
    const header = `${expanded ? "▾" : "▸"} Sub-agents · ${view.running} running · ${view.total} active`;
    const hint = "Shift+↑/↓ select · Enter open · Ctrl+Alt+A";
    const lines = [ctx.ui.theme.fg("muted", `${header}  ${hint}`)];
    if (expanded) {
        for (const { prefix, subagent } of view.rows)
            lines.push(...formatSubagent(ctx, prefix, subagent, subagent.name === selectedName));
        if (view.rows.length < view.total)
            lines.push(ctx.ui.theme.fg("dim", `   … ${view.total - view.rows.length} more`));
    }
    ctx.ui.setWidget(SUBAGENTS_WIDGET, lines);
}
function formatSubagent(ctx, prefix, subagent, selected = false) {
    const isTask = subagent.kind === "task";
    const state = isTask
        ? ctx.ui.theme.fg(subagent.taskStatus === "failed" ? "error" : subagent.taskStatus === "completed" ? "success" : "muted", `◆ ${subagent.taskStatus ?? subagent.status}`)
        : subagent.status === "running" ? ctx.ui.theme.fg("success", "● running") : ctx.ui.theme.fg("muted", "idle");
    const name = previewText(subagent.name, MAX_NAME_PREVIEW_CHARS);
    const activity = previewText(liveActivity(subagent), MAX_ACTIVITY_PREVIEW_CHARS);
    const detail = previewText([
        previewText(subagent.command, MAX_DETAIL_FIELD_CHARS),
        subagent.output && `↳ ${previewText(subagent.output, MAX_DETAIL_FIELD_CHARS)}`,
    ].filter(Boolean).join(" · "), MAX_DETAIL_PREVIEW_CHARS);
    const marker = selected ? ctx.ui.theme.fg("accent", "▶ ") : "  ";
    const lines = [`${marker}${ctx.ui.theme.fg("dim", prefix)}${ctx.ui.theme.fg("text", name)} ${ctx.ui.theme.fg("dim", "·")} ${state}${activity ? ` ${ctx.ui.theme.fg("dim", `(${activity})`)}` : ""}`];
    if (detail) {
        const continuation = prefix.replace(/[├└]─ /, "   ");
        lines.push(`  ${ctx.ui.theme.fg("dim", continuation)}${ctx.ui.theme.fg("muted", detail)}`);
    }
    return lines.slice(0, MAX_PREVIEW_LINES);
}
