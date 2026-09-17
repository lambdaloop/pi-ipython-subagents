import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BackgroundTasks } from "../dist/background.js";
import piRlmRuntime, { syncActiveTools } from "../dist/index.js";
import { BOOTSTRAP, createKernelRuntime, SessionKernel } from "../dist/kernel.js";
import { buildPiRlmRuntimePrompt } from "../dist/prompt.js";
import { createIpythonRenderers } from "../dist/render.js";
import { SessionRuntime } from "../dist/session.js";
import { filterChildExtensions, startSubagent, SUBAGENT_EXTENSION_NAME } from "../dist/subagent.js";
import { browseSubagent, showSubagents } from "../dist/ui.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";

function mockPi() {
	const events = new Map();
	const flags = new Map();
	let active = ["read", "bash", "edit", "write"];
	const tools = [];
	const shortcuts = new Map();
	const pi = {
		registerFlag(name, options) {
			flags.set(name, options.default);
		},
		getFlag(name) {
			return flags.get(name);
		},
		registerCommand() {},
		registerShortcut(name, options) {
			shortcuts.set(name, options);
		},
		registerTool(tool) {
			tools.push(tool);
		},
		getAllTools() {
			return tools.map((tool) => ({ name: tool.name }));
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names) {
			active = [...names];
		},
		on(name, handler) {
			events.set(name, handler);
		},
	};
	return { pi, events, flags, tools, shortcuts, get active() { return active; } };
}

test("RLM is enabled by default and routes shell work through IPython", async () => {
	const mock = mockPi();
	piRlmRuntime(mock.pi);
	await mock.events.get("turn_start")();
	assert.equal(mock.flags.get("rlm-runtime"), true);
	assert.deepEqual(mock.active, ["read", "edit", "write", "ipython"]);
	mock.active.splice(0, mock.active.length, "read", "bash", "powershell", "edit", "write", "ipython");
	await mock.events.get("turn_start")();
	assert.deepEqual(mock.active, ["read", "edit", "write", "ipython"]);

	mock.flags.set("no-rlm-runtime", true);
	mock.active.splice(0, mock.active.length, "read", "bash");
	await mock.events.get("turn_start")();
	assert.deepEqual(mock.active, ["read", "bash"]);
});

test("sub-agent policy leaves only ipython and the prompt distinguishes session roles", () => {
	const mock = mockPi();
	syncActiveTools(mock.pi, true);
	assert.deepEqual(mock.active, ["ipython"]);
	mock.pi.setActiveTools(["ipython", "read", "bash"]);
	syncActiveTools(mock.pi, true);
	assert.deepEqual(mock.active, ["ipython"]);

	const mainPrompt = buildPiRlmRuntimePrompt({ cwd: "/tmp", messagesPath: "none", depth: 0, maxDepth: 4 });
	const subPrompt = buildPiRlmRuntimePrompt({
		cwd: "/tmp",
		messagesPath: "none",
		depth: 1,
		maxDepth: 4,
		parentName: "main",
	});
	assert.match(mainPrompt, /native Pi tools stay enabled except the native shell tools \(`bash` and `powershell`\)/);
	assert.match(subPrompt, /only direct tool/);
	assert.match(mainPrompt, /rg_files\(\.\.\.\)/);
	assert.match(mainPrompt, /rg_search\(\.\.\.\)/);
	assert.match(mainPrompt, /Never search .* as roots/);
	assert.match(mainPrompt, /agent_message\.force_send/);
	assert.match(subPrompt, /agent_message\.force_send/);
	assert.match(subPrompt, /Never search .* as roots/);
	assert.match(mainPrompt, /20 seconds by default/);
	assert.match(subPrompt, /20 seconds by default/);
	assert.match(mainPrompt, /60 seconds by default/);
	assert.match(subPrompt, /60 seconds by default/);
	assert.match(mainPrompt, /timeout_seconds=1800/);
	assert.doesNotMatch(subPrompt, /parent session keeps its full tool set/);
	assert.match(BOOTSTRAP, /rg_files/);
	assert.match(BOOTSTRAP, /rg_search/);
});

test("RLM appends its prompt and shuts down cleanly", async () => {
	const mock = mockPi();
	piRlmRuntime(mock.pi);
	const ctx = {
		cwd: "/tmp",
		hasUI: false,
		mode: "print",
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "prompt-test",
			getSessionFile: () => undefined,
		},
		ui: { setWidget() {}, notify() {} },
	};
	const result = await mock.events.get("before_agent_start")(
		{ systemPrompt: "BASE_SENTINEL", systemPromptOptions: { cwd: "/tmp" } },
		ctx,
	);
	assert.equal((result.systemPrompt.match(/BASE_SENTINEL/g) ?? []).length, 1);
	assert.match(result.systemPrompt, /Kernel environments: the first line of a cell may be `%%kernel`/);
	assert.match(result.systemPrompt, /`ipython` is your primary tool/);
	assert.match(result.systemPrompt, /rg_files/);
	const ipython = mock.tools.find((tool) => tool.name === "ipython");
	assert.equal(ipython.parameters.properties.timeout_seconds.minimum, 1);
	assert.equal(ipython.parameters.properties.timeout_seconds.maximum, 3600);
	await mock.events.get("session_shutdown")({}, ctx);
});

test("nested running command previews retain their live phase", () => {
	let widget: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget: (_id, value) => { widget = value; },
		},
	};
	showSubagents(ctx, {
		listActiveSubagents: () => [{
			name: "nested-agent",
			status: "running",
			startedAt: Date.now() - 65_000,
			activity: "running ipython 0ms",
			command: "$ task = await bg(\"work\")",
			subagents: [],
		}],
	}, true);
	assert.match(widget.join("\n"), /running ipython 1m 5s/);
});

test("running task previews refresh their duration from the start time", () => {
	let widget: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget: (_id, value) => { widget = value; },
		},
	};
	showSubagents(ctx, {
		listActiveSubagents: () => [{
			name: "long-running-process",
			status: "running",
			kind: "task",
			taskStatus: "running",
			startedAt: Date.now() - 65_000,
			activity: "running 0ms",
			command: "$ long-running-process",
			subagents: [],
		}],
	}, true);
	assert.match(widget.join("\n"), /running 1m 5s/);
});

test("background tasks are marked distinctly in the sub-agent tree", () => {
	let widget;
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget: (_id, value) => { widget = value; },
		},
	};
	showSubagents(ctx, {
		listActiveSubagents: () => [{
			name: "tests",
			status: "idle",
			taskStatus: "completed",
			kind: "task",
			command: "$ printf done",
			output: "done",
			activity: "completed",
			subagents: [],
		}],
	}, true);
	assert.match(widget.join("\n"), /tests.*◆ completed/);
	assert.match(widget.join("\n"), /\$ printf done/);
});

test("sub-agent previews stay within two single-line rows", () => {
	let widget: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget: (_id, value) => { widget = value; },
		},
	};
	showSubagents(ctx, {
		listActiveSubagents: () => [{
			name: `worker-${"name ".repeat(100)}`,
			status: "running",
			command: "$ line1\nline2\nline3",
			output: `first line\n${"output ".repeat(400)}`,
			activity: `running ${"activity ".repeat(100)}`,
			subagents: [],
		}],
	}, true);

	assert.equal(widget.length, 3);
	assert.ok(widget.slice(1).length <= 2);
	assert.ok(widget.every((line) => !line.includes("\n")));
	assert.ok(widget.slice(1).every((line) => line.length <= 180));
	assert.match(widget[2], /\$ line1 line2 line3/);
});

test("Shift+Up/Down selects a sub-agent and Enter opens its transcript", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-selection-"));
	const active = [
		{ name: "alpha", status: "running", subagents: [] },
		{ name: "beta", status: "running", subagents: [] },
	];
	const mock = mockPi();
	let widget: string[] = [];
	let terminalInput: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	let editorText = "";
	let customCalls = 0;
	const ctx = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		isProjectTrusted: () => true,
		model: undefined,
		thinkingLevel: "off",
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "selection-test",
			getSessionFile: () => undefined,
		},
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget: (_id, value) => { widget = value; },
			notify() {},
			onTerminalInput: (handler) => {
				terminalInput = handler;
				return () => { terminalInput = undefined; };
			},
			custom: async () => { customCalls++; },
			getEditorText: () => editorText,
		},
	};
	const originalActive = SessionRuntime.prototype.listActiveSubagents;
	const originalInspectable = SessionRuntime.prototype.listInspectable;
	SessionRuntime.prototype.listActiveSubagents = () => active;
	SessionRuntime.prototype.listInspectable = () => active.map((item) => ({ ...item, kind: "agent" }));
	try {
		piRlmRuntime(mock.pi);
		await mock.events.get("before_agent_start")(
			{ systemPrompt: "BASE", systemPromptOptions: { cwd: root } },
			ctx,
		);
		assert.equal(typeof terminalInput, "function");
		await mock.shortcuts.get("shift+down").handler(ctx);
		assert.match(widget.join("\n"), /▶ .*alpha/);
		editorText = "hello";
		assert.equal(terminalInput("\r"), undefined);
		assert.doesNotMatch(widget.join("\n"), /▶ /);
		editorText = "";
		await mock.shortcuts.get("shift+down").handler(ctx);
		await mock.shortcuts.get("shift+down").handler(ctx);
		assert.match(widget.join("\n"), /▶ .*beta/);
		assert.equal(terminalInput("\r")?.consume, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(customCalls, 1);
		assert.doesNotMatch(widget.join("\n"), /▶ /);
		assert.equal(terminalInput("\r"), undefined);
		await mock.events.get("session_shutdown")({}, ctx);
	} finally {
		SessionRuntime.prototype.listActiveSubagents = originalActive;
		SessionRuntime.prototype.listInspectable = originalInspectable;
		rmSync(root, { recursive: true, force: true });
	}
});

test("nested background tasks can be selected and inspected", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-nested-task-"));
	const logPath = join(root, "task.log");
	writeFileSync(logPath, "progress 42%\n");
	const nestedTask = {
		id: "task-1",
		name: "deeperfly-direct-run",
		status: "running",
		kind: "task",
		command: "$ time pixi run python infer.py",
		cwd: root,
		log_path: logPath,
		subagents: [],
	};
	const runtime = {
		listSubagents: () => [],
		listActiveSubagents: () => [{ name: "worker", status: "running", subagents: [nestedTask] }],
		tasks: { list: () => [], find: () => undefined },
		listInspectable() { return SessionRuntime.prototype.listInspectable.call(this); },
		subagentTranscript(target) { return SessionRuntime.prototype.subagentTranscript.call(this, target); },
	};
	let customCalls = 0;
	const notices: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message) => notices.push(message),
			custom: async () => { customCalls++; },
		},
	};
	try {
		await browseSubagent(ctx, runtime, nestedTask.name);
		assert.equal(customCalls, 1);
		assert.deepEqual(notices, []);
		assert.match(runtime.subagentTranscript(nestedTask.name), /progress 42%/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("subagent browser scrolls, preserves position, supports wheel, and cleans up", async () => {
	let component;
	let closed = false;
	let lines = Array.from({ length: 220 }, (_, index) => `line ${index}`);
	const runtime = {
		listSubagents: () => [{ name: "demo", status: "running" }],
		subagentTranscript: () => lines.join("\n"),
	};
	let terminalRows = 30;
	const tui = { terminal: { get rows() { return terminalRows; } }, requestRender() {} };
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			select: async () => undefined,
			notify() {},
			custom: async (factory) => {
				component = factory(tui, { fg: (_color, text) => text }, {}, () => {
					closed = true;
				});
			},
		},
	};

	try {
		await browseSubagent(ctx, runtime, "demo");
		let frame = renderLayoutFrame(component, 80, 20, () => {});
		assert.match(frame.lines.join("\n"), /line 219/);
		assert.match(component.render(80).join("\n"), /line 219/);

		component.handleInput("\x1b[5~");
		frame = renderLayoutFrame(component, 80, 20, () => {});
		assert.ok(frame.primaryScrollView.scrollTop > 0);
		assert.doesNotMatch(frame.lines.join("\n"), /line 219/);
		const pinned = frame.primaryScrollView.scrollTop;
		lines.push(...Array.from({ length: 40 }, (_, index) => `new ${index}`));
		component.refresh();
		component.render(40);
		assert.equal(component.scroll.scrollTop, pinned);
		assert.equal(component.scroll.isFollowingEnd, false);
		frame = renderLayoutFrame(component, 40, 20, () => {});
		assert.equal(frame.primaryScrollView.scrollTop, pinned);
		assert.equal(component.scroll.scrollTop, pinned);

		terminalRows = 400;
		component.refresh();
		component.render(40);
		assert.equal(component.scroll.scrollTop, 0);
		assert.equal(component.scroll.isFollowingEnd, false);
		terminalRows = 30;
		component.refresh();
		component.render(40);
		assert.equal(component.scroll.scrollTop, 0);
		assert.equal(component.scroll.isFollowingEnd, false);

		const beforeWheel = component.scroll.scrollTop;
		component.handleMouse({ type: "wheel", wheelDelta: 1 });
		frame = renderLayoutFrame(component, 80, 20, () => {});
		const afterWheel = frame.primaryScrollView.scrollTop;
		assert.ok(afterWheel > beforeWheel);
		component.handleInput("\x1b[4~");
		frame = renderLayoutFrame(component, 80, 20, () => {});
		assert.ok(frame.primaryScrollView.scrollTop > afterWheel);
		assert.match(frame.lines.join("\n"), /new 39/);

		lines = ["short transcript"];
		component.refresh();
		assert.equal(component.render(80).length > 0, true);
		assert.equal(component.scroll.scrollTop, 0);
		lines = Array.from({ length: 220 }, (_, index) => `resized ${index}`);
		component.refresh();
		assert.match(component.render(40).join("\n"), /resized 219/);
		assert.ok(component.scroll.scrollTop > 0);
	} finally {
		component?.dispose();
	}
	assert.equal(closed, true);
});

test("startSubagent restricts startup and later turns to ipython", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-child-"));
	const agentDir = getAgentDir();
	const cwd = process.cwd();
	const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
	try {
		const child = await startSubagent({
			cwd,
			agentDir,
			subagentDir: workspace,
			name: "tool-policy-child",
			task: "test tool policy",
			depth: 1,
			maxDepth: 4,
			model,
			parent: { name: "main", id: "main-id" },
			runtime: {},
			makeExtension: (subagent) => ({
				name: SUBAGENT_EXTENSION_NAME,
				hidden: true,
				factory: (pi) => {
					pi.registerTool({
						name: "ipython",
						label: "ipython",
						description: "test double",
						parameters: {},
						execute: async () => ({ content: [] }),
					});
					pi.on("turn_start", () => syncActiveTools(pi, subagent !== undefined));
				},
			}),
		});
		try {
			assert.deepEqual(child.session.agent.state.tools.map((tool) => tool.name), ["ipython"]);
			child.session.agent.state.tools.push({ name: "read" });
			await child.session.extensionRunner.emit({ type: "turn_start" });
			assert.deepEqual(child.session.agent.state.tools.map((tool) => tool.name), ["ipython"]);
		} finally {
			await child.close();
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

function makeBackgroundTasks() {
	const root = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-bg-"));
	const notifications = [];
	const tasks = new BackgroundTasks({
		cwd: root,
		logDir: join(root, "tasks"),
		notify: (message, task) => notifications.push({ message, task }),
	});
	return { root, tasks, notifications };
}

test("background tasks default to a 60-second process timeout", async () => {
	const { root, tasks } = makeBackgroundTasks();
	const originalSetTimeout = globalThis.setTimeout;
	let timeoutMs;
	globalThis.setTimeout = ((handler, delayMs, ...args) => {
		if (delayMs === 60_000)
			timeoutMs = delayMs;
		return originalSetTimeout(handler, delayMs, ...args);
	});
	try {
		const started = tasks.start({ command: "sleep 1", name: "default-timeout" });
		assert.equal(timeoutMs, 60_000);
		await tasks.wait(started.id);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		await tasks.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("background task output updates the live preview", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-bg-preview-"));
	const changes = [];
	const child = Object.assign(new EventEmitter(), {
		pid: 1234,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill() { this.emit("close", 0, null); },
	});
	const tasks = new BackgroundTasks({
		cwd: root,
		logDir: join(root, "tasks"),
		spawn: () => child,
		onChange: () => changes.push(true),
	});
	try {
		const started = tasks.start({ command: "long-running-process", name: "preview" });
		assert.equal(changes.length, 1);
		child.stdout.emit("data", "progress 42%\n");
		child.stdout.emit("data", "step 1\rstep 2");
		assert.equal(tasks.status(started.id).last_line, "step 2");
		await new Promise((resolve) => setTimeout(resolve, 125));
		assert.equal(changes.length, 2);
		child.emit("close", 0, null);
		assert.equal((await tasks.wait(started.id)).status, "completed");
	} finally {
		await tasks.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("background tasks return handles, capture logs, and notify on completion", async () => {
	const { root, tasks, notifications } = makeBackgroundTasks();
	try {
		const started = tasks.start({ command: "printf 'hello\\nworld\\n'", name: "hello" });
		assert.equal(started.status, "running");
		const finished = await tasks.wait(started.id);
		assert.equal(finished.status, "completed");
		assert.equal(finished.exit_code, 0);
		assert.match(tasks.logs(started.id).text, /hello\nworld/);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0].message, /Background task finished: hello/);
		assert.equal(notifications[0].task.id, started.id);
	} finally {
		await tasks.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("background tasks report failures, bound logs, and reject duplicate names", async () => {
	const { root, tasks, notifications } = makeBackgroundTasks();
	try {
		const failed = tasks.start({ command: "printf 1234567890; exit 3", name: "failure", notify: false });
		const result = await tasks.wait(failed.id);
		assert.equal(result.status, "failed");
		assert.equal(result.exit_code, 3);
		assert.equal(notifications.length, 0);
		assert.equal(tasks.logs(failed.id, { maxBytes: 4, tail: false }).text, "1234");
		assert.throws(() => tasks.start({ command: "true", name: "failure" }), /already exists/);
	} finally {
		await tasks.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("background tasks can be killed, disposed, and waited with abort", async () => {
	const { root, tasks } = makeBackgroundTasks();
	try {
		const killed = tasks.start({ command: "sleep 30", name: "killed" });
		assert.equal((await tasks.kill(killed.id)).status, "killed");

		const timedOut = tasks.start({ command: "sleep 30", name: "timed out", timeoutSeconds: 1 });
		assert.equal((await tasks.wait(timedOut.id)).status, "failed");
		assert.match(tasks.get(timedOut.id).error, /timed out/);

		const aborted = tasks.start({ command: "sleep 30", name: "aborted" });
		const controller = new AbortController();
		const waiting = tasks.wait(aborted.id, controller.signal);
		controller.abort();
		await assert.rejects(waiting, { name: "AbortError" });
		await tasks.dispose();
		assert.equal(tasks.get(aborted.id).status, "killed");
	} finally {
		await tasks.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("SessionRuntime delivers background completion like a sub-agent message", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-session-bg-"));
	const messages = [];
	const ctx = {
		cwd: root,
		hasUI: false,
		mode: "print",
		isIdle: () => true,
		isProjectTrusted: () => true,
		model: undefined,
		thinkingLevel: "off",
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "session-bg-test",
			getSessionFile: () => undefined,
			getSessionDir: () => root,
			getSessionName: () => "main",
		},
	};
	const runtime = new SessionRuntime({
		pi: {
			sendMessage: (message, options) => messages.push({ message, options }),
			appendEntry() {},
		},
		ctx,
		depth: 0,
		maxDepth: 4,
		agentDir: root,
		runtimeDir: join(root, "runtime"),
	});
	try {
		const started = await runtime.request({ type: "bg.run", command: "printf done", name: "session task" }, new AbortController().signal);
		assert.equal(started.status, "running");
		assert.equal(runtime.listActiveSubagents().find((item) => item.kind === "task").name, "session task");
		const finished = await runtime.request({ type: "bg.wait", task: started.id }, new AbortController().signal);
		assert.equal(finished.status, "completed");
		assert.equal(runtime.listActiveSubagents().find((item) => item.kind === "task"), undefined);
		assert.equal(runtime.listInspectable().find((item) => item.kind === "task").name, "session task");
		assert.equal(messages.length, 1);
		assert.equal(messages[0].message.customType, "pi-rlm-runtime.message");
		assert.equal(messages[0].options.triggerTurn, true);
		assert.match(messages[0].message.content, /Background task finished/);
		assert.match(runtime.subagentTranscript("session task"), /done/);
	} finally {
		await runtime.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

function clearKernelSelectionOverrides() {
	const previousPython = process.env.PI_RLM_RUNTIME_PYTHON;
	const previousPixi = process.env.PIXI_ENVIRONMENT_NAME;
	delete process.env.PI_RLM_RUNTIME_PYTHON;
	delete process.env.PIXI_ENVIRONMENT_NAME;
	return () => {
		if (previousPython === undefined) delete process.env.PI_RLM_RUNTIME_PYTHON;
		else process.env.PI_RLM_RUNTIME_PYTHON = previousPython;
		if (previousPixi === undefined) delete process.env.PIXI_ENVIRONMENT_NAME;
		else process.env.PIXI_ENVIRONMENT_NAME = previousPixi;
	};
}

function makeFakePixiProject(pixiExit = 0) {
	const project = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-pixi-"));
	const python = join(project, ".pixi", "envs", "default", "bin", "python");
	const bin = join(project, "bin");
	mkdirSync(join(project, ".pixi", "envs", "default", "bin"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(project, "pyproject.toml"), "[tool.pixi.workspace]\nname = 'demo'\n");
	writeFileSync(python, "#!/bin/sh\nexit 0\n");
	writeFileSync(join(bin, "pixi"), `#!/bin/sh\nexit ${pixiExit}\n`);
	chmodSync(python, 0o755);
	chmodSync(join(bin, "pixi"), 0o755);
	return { project, python, bin };
}

test("a healthy materialized pixi environment is the default kernel", () => {
	const { project, python, bin } = makeFakePixiProject();
	const restoreOverrides = clearKernelSelectionOverrides();
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	try {
		const runtime = createKernelRuntime({ cwd: project, runtimeDir: join(project, "python") });
		assert.deepEqual(runtime.names(), ["uv", "pixi"]);
		assert.equal(runtime.active, "pixi");
		assert.equal(runtime.startupNote, undefined);
		const pixi = runtime.find("pixi");
		assert.equal(pixi.python, python);
		assert.equal(pixi.command, "pixi");
		assert.deepEqual(pixi.commandArgs.slice(0, 4), ["run", "--manifest-path", project, "--environment"]);
		assert.equal(runtime.command, python);
		assert.deepEqual(runtime.commandArgs, []);
		assert.match(runtime.describe(pixi).join("\n"), /pixi.*active/);
		runtime.apply(runtime.find("uv"));
		assert.equal(runtime.active, "uv");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		restoreOverrides();
		rmSync(project, { recursive: true, force: true });
	}
});

test("kernel startup falls back to uv when pixi is absent or broken", () => {
	const restoreOverrides = clearKernelSelectionOverrides();
	const absent = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-no-pixi-"));
	try {
		const runtime = createKernelRuntime({ cwd: absent, runtimeDir: join(absent, "python") });
		assert.equal(runtime.active, "uv");
		assert.match(runtime.startupNote, /No materialized Pixi environment/);
		assert.match(runtime.describe(runtime.find("uv")).join("\n"), /startup:/);
	} finally {
		rmSync(absent, { recursive: true, force: true });
	}

	const { project, bin } = makeFakePixiProject(23);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	try {
		const runtime = createKernelRuntime({ cwd: project, runtimeDir: join(project, "python") });
		assert.equal(runtime.active, "uv");
		assert.match(runtime.startupNote, /Pixi was unavailable/);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(project, { recursive: true, force: true });
		restoreOverrides();
	}
});

test("an explicit interpreter overrides the automatic pixi default", () => {
	const { project, python, bin } = makeFakePixiProject();
	const previousPath = process.env.PATH;
	const previousPython = process.env.PI_RLM_RUNTIME_PYTHON;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.PI_RLM_RUNTIME_PYTHON = python;
	try {
		const runtime = createKernelRuntime({ cwd: project, runtimeDir: join(project, "python") });
		assert.equal(runtime.active, "python");
		assert.equal(runtime.activeSpec.python, python);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousPython === undefined) delete process.env.PI_RLM_RUNTIME_PYTHON;
		else process.env.PI_RLM_RUNTIME_PYTHON = previousPython;
		rmSync(project, { recursive: true, force: true });
	}
});

test("interrupting an awaited cell leaves the IPython kernel usable", async () => {
	const kernels = createKernelRuntime({ cwd: process.cwd(), runtimeDir: join(process.cwd(), "python") });
	const kernel = new SessionKernel(kernels);
	try {
		await kernel.execute("print('ready')", undefined, undefined);
		const controller = new AbortController();
		const interrupted = kernel.execute("import asyncio\nawait asyncio.sleep(180)", undefined, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		await assert.rejects(interrupted, { name: "AbortError" });

		const result = await kernel.execute("print('alive')", undefined, undefined);
		assert.equal(result.status, "ok");
		assert.match(result.stdout, /alive/);
	}
	finally {
		await kernel.dispose();
	}
});

function stubKernels(projectRoot = "/tmp") {
	const environments = [
		{ name: "uv", label: "isolated uv environment", detail: "uv run", kind: "uv", command: "uv", commandArgs: [], cwd: "/tmp" },
		{ name: "second", label: "second uv environment", detail: "uv run again", kind: "uv", command: "uv", commandArgs: [], cwd: "/tmp" },
		{ name: "pixi", label: "project environment default", detail: join(projectRoot, ".pixi", "envs", "default", "bin", "python"), kind: "pixi", command: "true", commandArgs: ["run", "--manifest-path", projectRoot, "--environment", "default", "python"], cwd: projectRoot, projectRoot, environment: "default", python: join(projectRoot, ".pixi", "envs", "default", "bin", "python") },
	];
	const kernels = {
		environments,
		cwd: "/tmp",
		command: "false",
		commandArgs: [],
		kernelEnv: process.env,
		active: "uv",
		activeSpec: environments[0],
		names: () => environments.map((environment) => environment.name),
		find: (name) => environments.find((environment) => environment.name === name),
		describe: (spec) => [`${spec.name} — ${spec.label}${spec.name === kernels.active ? " (active)" : ""}`],
		apply(spec) {
			this.active = spec.name;
			this.activeSpec = spec;
		},
	};
	return kernels;
}

function runtimeWith(kernels) {
	const ctx = {
		cwd: "/tmp",
		sessionManager: { getBranch: () => [], getSessionId: () => "directive-test", getSessionFile: () => undefined, getSessionName: () => "main" },
	};
	return new SessionRuntime({
		pi: {},
		ctx,
		depth: 0,
		maxDepth: 1,
		agentDir: "/tmp",
		runtimeDir: "/tmp",
		runtime: kernels,
		subagentsChanged() {},
		makeExtension: () => ({}),
	});
}

test("force_send aborts a running sub-agent before delivering its message", async () => {
	const runtime = runtimeWith(stubKernels());
	const calls = [];
	let sendMessage;
	let streaming = true;
	const oldRun = { replied: false };
	const child = {
		sessionId: "child-id",
		name: "child",
		run: oldRun,
		agent: {
			session: {
				get isStreaming() { return streaming; },
				abort: async () => { calls.push("abort"); streaming = false; },
				clearQueue: () => calls.push("clear"),
				sendCustomMessage: async (message, options) => {
					sendMessage = { message, options };
					return new Promise(() => {});
				},
			},
		},
	};
	runtime.subagents.set(child.sessionId, child);
	try {
		await runtime.request({
			type: "agent_message.force_send",
			message: "Stop and inspect this now.",
			receiver_role: "subagent",
			receiver_name: "child",
		}, new AbortController().signal);
		assert.deepEqual(calls, ["abort", "clear"]);
		assert.equal(oldRun.replied, true);
		assert.equal(sendMessage.options.triggerTurn, true);
		assert.match(sendMessage.message.content, /Force-stopped message from parent/);
		assert.equal(sendMessage.message.details.force, true);
	}
	finally {
		await runtime.dispose();
	}
});

test("list_running reports tool and thinking activity with elapsed time", () => {
	const running = SessionRuntime.prototype.listRunningSubagents.call({
		subagents: new Map([
			["thinking-id", {
				sessionId: "thinking-id",
				name: "thinker",
				model: "test/model",
				agent: { session: { isStreaming: true } },
				thinkingStartedAt: Date.now() - 1200,
			}],
			["tool-id", {
				sessionId: "tool-id",
				name: "worker",
				model: "test/model",
				agent: { session: { isStreaming: true } },
				toolName: "ipython",
				toolStartedAt: Date.now() - 2300,
			}],
		]),
	});
	assert.equal(running.length, 2);
	const thinker = running.find((item) => item.name === "thinker");
	assert.equal(thinker.phase, "thinking");
	assert.equal(thinker.tool, null);
	assert.ok(thinker.elapsed_ms >= 1200);
	assert.match(thinker.activity, /^thinking /);
	const worker = running.find((item) => item.name === "worker");
	assert.equal(worker.phase, "tool");
	assert.equal(worker.tool, "ipython");
	assert.ok(worker.elapsed_ms >= 2300);
	assert.match(worker.activity, /^running ipython /);
});

test("the %%kernel directive lists environments, switches, and rejects unknown names", async () => {
	const pixiProject = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-directive-pixi-"));
	mkdirSync(join(pixiProject, ".pixi", "envs", "dev", "bin"), { recursive: true });
	writeFileSync(join(pixiProject, ".pixi", "envs", "dev", "bin", "python"), "");
	const runtime = runtimeWith(stubKernels(pixiProject));
	try {
		const listed = await runtime.execute("%%kernel", undefined, undefined);
		assert.equal(listed.status, "ok");
		assert.match(listed.stdout, /uv — isolated uv environment \(active\)/);
		assert.match(listed.stdout, /second — second uv environment/);

		const switched = await runtime.execute("%%kernel second", undefined, undefined);
		assert.equal(switched.status, "ok");
		assert.match(switched.stdout, /environment 'second'/);
		assert.equal(runtime.kernels.active, "second");

		const selected = await runtime.execute("%%kernel pixi -e dev", undefined, undefined);
		assert.equal(selected.status, "ok");
		assert.match(selected.stdout, /environment 'pixi -e dev'/);
		assert.equal(runtime.kernels.active, "pixi");
		assert.equal(runtime.kernels.activeSpec.commandArgs.at(-2), "dev");

		let executedCode;
		const originalExecute = SessionKernel.prototype.execute;
		SessionKernel.prototype.execute = async function (code) {
			executedCode = code;
			return {
				status: "ok",
				durationMs: 1,
				executionCount: 1,
				stdout: "hello from pixi",
				stderr: "",
				result: "",
				display: "",
				attachments: [],
			};
		};
		try {
			const withBody = await runtime.execute("%%kernel pixi -e dev\nprint('hello')", undefined, undefined);
			assert.equal(withBody.status, "ok");
			assert.equal(executedCode, "print('hello')");
			assert.match(withBody.stdout, /environment 'pixi -e dev'/);
			assert.match(withBody.stdout, /hello from pixi/);
		}
		finally {
			SessionKernel.prototype.execute = originalExecute;
		}

		const unknown = await runtime.execute("%%kernel missing", undefined, undefined);
		assert.equal(unknown.status, "error");
		assert.match(unknown.error.evalue, /Unknown kernel environment 'missing'/);
		assert.equal(runtime.kernels.active, "pixi");

		const needsPath = await runtime.execute("%%kernel python relative/path", undefined, undefined);
		assert.equal(needsPath.status, "error");
		assert.match(needsPath.error.evalue, /must be absolute/);

		// A cell without the directive is not handled on the host: it reaches the
		// kernel, which the stub deliberately cannot start.
		await assert.rejects(runtime.execute("x = 1", undefined, undefined));
	}
	finally {
		await runtime.dispose();
		rmSync(pixiProject, { recursive: true, force: true });
	}
});

test("the %%kernel directive only applies on the first line", async () => {
	const runtime = runtimeWith(stubKernels());
	try {
		await assert.rejects(runtime.execute("print('hi')\n%%kernel second", undefined, undefined));
		assert.equal(runtime.kernels.active, "uv");
	}
	finally {
		await runtime.dispose();
	}
});

test("the sub-agent panel shows live elapsed time for a running command", () => {
	const active = SessionRuntime.prototype.listActiveSubagents.call({
		subagents: new Map([[
			"agent-1",
			{
				sessionId: "agent-1",
				name: "worker",
				model: "test/model",
				agent: { session: { isStreaming: true } },
				toolName: "ipython",
				toolStartedAt: Date.now() - 5000,
				command: "$ rg -n pattern src",
			},
		]]),
		tasks: { list: () => [] },
	});
	assert.match(active[0].activity, /^running ipython 5\.0s$/);
	assert.ok(active[0].startedAt <= Date.now() - 5000);
});

test("the ipython row renders like a shell command with elapsed and total time", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const renderers = createIpythonRenderers();
	const state: Record<string, any> = {};
	const context = {
		args: { code: "import time\ntime.sleep(1)" },
		toolCallId: "call-1",
		state,
		invalidate: () => {},
		isError: false,
		showImages: true,
		executionStarted: true,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		cwd: "/tmp",
	} as any;
	const call = renderers.renderCall(context.args, theme as any, context);
	assert.deepEqual(
		call.render(80).map((line) => line.trimEnd()),
		["$ import time", "  time.sleep(1)"],
	);
	assert.equal(typeof state.startedAt, "number");

	const partial = renderers.renderResult(
		{ content: [{ type: "text", text: "ignored wrapper" }], details: { output: "tick" } } as any,
		{ expanded: false, isPartial: true } as any,
		theme as any,
		context,
	);
	const partialLines = partial.render(80).join("\n");
	assert.match(partialLines, /^\ntick/);
	assert.match(partialLines, /Elapsed \d+\.\ds/);
	assert.doesNotMatch(partialLines, /ignored wrapper/);
	assert.ok(state.interval, "a running cell ticks so the elapsed time updates");

	const final = renderers.renderResult(
		{ content: [{ type: "text", text: "ignored wrapper" }], details: { output: "done\n" } } as any,
		{ expanded: false, isPartial: false } as any,
		theme as any,
		context,
	);
	const finalLines = final.render(80).join("\n");
	assert.match(finalLines, /^\ndone/);
	assert.match(finalLines, /Took \d+\.\ds/);
	assert.equal(state.interval, undefined);
});

test("child extension filter removes only the discovered root RLM extension", () => {
	const root = new URL("../dist/index.js", import.meta.url).pathname;
	const result = filterChildExtensions({
		extensions: [
			{ resolvedPath: root },
			{ resolvedPath: "/tmp/unrelated-extension.js" },
			{ resolvedPath: "<inline:1>" },
		],
		errors: [],
		runtime: {},
	});
	assert.deepEqual(result.extensions.map((extension) => extension.resolvedPath), [
		"/tmp/unrelated-extension.js",
		"<inline:1>",
	]);
});
