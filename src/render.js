/**
 * Presentation for the ipython tool.
 *
 * Mirrors the host's shell renderer: the cell code heads the row like a shell
 * command, the output previews below it, and a footer counts elapsed time while
 * the cell runs and reports the total once it finishes.
 */
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
const PREVIEW_LINES = 6;
const MAX_CALL_LINES = 12;
const TICK_MS = 1_000;
function formatDuration(milliseconds) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
}
/** `keyHint` needs the interactive theme; degrade to plain text outside it. */
function expandHint() {
    try {
        return keyHint("app.tools.expand", "to expand");
    }
    catch {
        return "to expand";
    }
}
function formatCall(code, theme) {
    const lines = String(code ?? "").replace(/\s+$/, "").split("\n");
    const shown = lines.slice(0, MAX_CALL_LINES);
    const head = theme.fg("toolTitle", theme.bold(`$ ${shown[0] || "…"}`));
    const rest = shown.slice(1).map((line) => theme.fg("dim", `  ${line}`));
    if (lines.length > MAX_CALL_LINES)
        rest.push(theme.fg("muted", `  … (+${lines.length - MAX_CALL_LINES} more lines)`));
    return [head, ...rest].join("\n");
}
function textOutput(result) {
    if (!Array.isArray(result?.content))
        return "";
    return result.content
        .filter((part) => part?.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n");
}
/** Raw cell output when the tool supplies it, otherwise the result text verbatim. */
function resultBody(result) {
    const output = result?.details?.output;
    return typeof output === "string" ? output : textOutput(result);
}
class IpythonResultRenderComponent extends Container {
    state = {
        cachedWidth: undefined,
        cachedLines: undefined,
        cachedSkipped: undefined,
    };
}
function rebuild(component, result, options, theme, startedAt, endedAt) {
    const state = component.state;
    component.clear();
    const output = resultBody(result).trimEnd();
    if (output) {
        const styled = output
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n");
        if (options.expanded) {
            component.addChild(new Text(`\n${styled}`, 0, 0));
        }
        else {
            component.addChild({
                render: (width) => {
                    if (state.cachedWidth !== width || state.cachedLines === undefined) {
                        const preview = truncateToVisualLines(styled, PREVIEW_LINES, width);
                        state.cachedLines = preview.visualLines;
                        state.cachedSkipped = preview.skippedCount;
                        state.cachedWidth = width;
                    }
                    if (state.cachedSkipped > 0) {
                        const hint = `${theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`)} ${expandHint()}${theme.fg("muted", ")")}`;
                        return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
                    }
                    return ["", ...(state.cachedLines ?? [])];
                },
                invalidate: () => {
                    state.cachedWidth = undefined;
                    state.cachedLines = undefined;
                    state.cachedSkipped = undefined;
                },
            });
        }
    }
    if (startedAt !== undefined) {
        const label = options.isPartial ? "Elapsed" : "Took";
        const end = endedAt ?? Date.now();
        component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(end - startedAt)}`)}`, 0, 0));
    }
}
export function createIpythonRenderers() {
    return {
        renderCall(args, theme, context) {
            const state = context.state;
            if (context.executionStarted && state.startedAt === undefined) {
                state.startedAt = Date.now();
                state.endedAt = undefined;
            }
            const text = context.lastComponent ?? new Text("", 0, 0);
            text.setText(formatCall(args?.code, theme));
            return text;
        },
        renderResult(result, options, theme, context) {
            const state = context.state;
            if (state.startedAt !== undefined && options.isPartial && !state.interval) {
                state.interval = setInterval(() => context.invalidate(), TICK_MS);
            }
            if (!options.isPartial || context.isError) {
                state.endedAt ??= Date.now();
                if (state.interval) {
                    clearInterval(state.interval);
                    state.interval = undefined;
                }
            }
            const component = context.lastComponent instanceof IpythonResultRenderComponent
                ? context.lastComponent
                : new IpythonResultRenderComponent();
            rebuild(component, result, options, theme, state.startedAt, state.endedAt);
            component.invalidate();
            return component;
        },
    };
}
