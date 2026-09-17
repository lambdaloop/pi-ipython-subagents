# pi-ipython-subagents

A recursive language-model runtime for [Pi](https://github.com/earendil-works/pi), based on the architecture behind [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

pi-ipython-subagents lets Pi work beyond a single conversation context. It can retain a large working set, delegate independent work to nested sub-agents, and bring the useful results back into the main conversation.

## Install

Requires Node.js 22.19 or newer, Pi 0.84.x, and [`uv`](https://docs.astral.sh/uv/).

```bash
pi install npm:@lambdaloop/pi-ipython-subagents
```

## Run Pi with @lambdaloop/pi-ipython-subagents

After installation, the runtime is enabled automatically for ordinary `pi` launches; no
`--rlm-runtime` flag is needed. The legacy flag remains accepted. To disable it for one launch,
use `pi --no-rlm-runtime`.

Then use Pi normally. Ask it to delegate when a task has independent parts:

```text
Review this codebase. Use sub-agents to inspect the architecture, runtime,
and tests in parallel, then reconcile their findings.
```

The runtime gives the main agent a persistent working environment and the ability to create, message, inspect, and stop sub-agents. The main agent keeps native Pi tools except the shell tools (`bash` and `powershell`) alongside `ipython`; use IPython for shell commands, file work, and project tools. RLM sub-agents receive only `ipython` directly. Each sub-agent has its own Pi conversation and state, shares the project directory, and inherits the parent model unless another is selected.

Sub-agents may create further sub-agents. Set the recursion limit when starting Pi:

```bash
pi --rlm-runtime-max-depth 6
```

The default depth is 4. The supported range is 0–16.

## View active sub-agents

Active sub-agents appear as a nested tree above the editor. Press `Ctrl+Alt+A` or run `/subagents` to expand or collapse it. When expanded, the tree also shows each RLM sub-agent's current tool, command, and latest output. Dormant sub-agents are hidden, and expanded trees are capped at 12 agents. Press `Shift+↑`/`Shift+↓` to select the previous or next active sub-agent or background task; press `Enter` to browse the selected transcript in a live scrolling overlay. Use `/subagent` (or `Ctrl+Alt+S`) to choose one interactively, or pass a name as `/subagent NAME` to open it directly.

## Agent API

The runtime preloads two Python objects for the agent:

```python
models = await rlm.find_models("sonnet")
reviewer = await rlm(
    "Review the authorization flow and report concrete findings.",
    name="auth-reviewer",
    model=models[0].selector,
)

agents = await agent_message.list_agents()
await agent_message.send(
    "Check the regression tests next.",
    receiver_role="subagent",
    receiver_name=reviewer.name,
)

await rlm.delete_subagent(reviewer)
```

`rlm()` returns when the sub-agent starts. Messages and shared files carry results back without copying the sub-agent's full context into its parent. If a sub-agent exits without sending a message, its final response or error is forwarded automatically.

`rlm.find_models()` searches the authenticated models available to Pi. Its selectors are exact; requesting an unavailable model fails instead of choosing a fallback.

For repository discovery, the runtime also preloads bounded ripgrep helpers. Use `rg_files('*.py')` to list files and `rg_search('pattern', 'src', glob='*.py')` to search contents; both are synchronous plain functions.

`agent_message.send()` accepts `parent`, `sibling`, or `subagent` as `receiver_role`. Messages to more distant agents are relayed through the tree. Use `agent_message.force_send()` for an urgent message to a sibling or sub-agent; it stops the target's current turn, clears queued messages, and then starts the message as a fresh turn.

## Background tasks

IPython exposes `bg` as a callable for long-running shell work. It is implemented by this runtime
rather than by `pi-background-tasks`, and behaves like a one-shot sub-agent: it returns immediately,
shows up in the sub-agent tree/browser, writes a session-owned log, and sends a completion message.
Tasks are not persisted across Pi restarts.

```python
task = await bg("pixi run pytest", name="test suite", timeout_seconds=1800)

# Deliberate inspection or cleanup:
current = await task.refresh()
logs = await task.logs(max_bytes=20_000)
await task.kill()

# Only wait in-cell when the result is needed immediately:
finished = await task.wait()
```

The task runs with the session's shell environment and working directory. It is killed after 60
seconds by default; pass `timeout_seconds` explicitly for a longer command. Use `pixi run ...` when
project dependencies are needed. `bg(...)` is available to the main agent and to ipython-only
sub-agents; completion notifications wake the owning session.

## Python environment

At startup, the runtime automatically prefers a materialized Pixi environment for the project when
one is available and can import `ipykernel`. If Pixi is absent or unavailable, it falls back to the
cached Python 3.11 environment managed by uv. `PI_RLM_RUNTIME_PYTHON` takes precedence over both.
To fix the interpreter for a whole launch:

```bash
export PI_RLM_RUNTIME_PYTHON=/absolute/path/to/python
pi
```

The interpreter must provide IPython and ipykernel.

## Tool display

The `ipython` row is rendered like a shell command: the cell heads the row with a `$` prompt, output
previews below it (expandable), and a footer counts `Elapsed 1.2s` while the cell runs and reports
`Took 3.2s` when it finishes. Cells are interrupted after 20 seconds by default; pass
`timeout_seconds` explicitly for a slower cell and use `bg(...)` for genuinely long-running work.

The active sub-agent panel refreshes running command durations continuously, including commands that
have not produced output yet.

## Kernel environments

The agent can move the IPython kernel between interpreters without restarting Pi. Put `%%kernel` on
the first line of a cell:

```text
%%kernel                 # list the available environments
%%kernel pixi            # restart inside the project's local pixi environment
%%kernel pixi -e dev     # select the Pixi 'dev' environment
%%kernel uv              # back to the isolated uv default
%%kernel python /abs/path/to/python

# Code after the directive executes in the selected environment:
%%kernel pixi -e dev
import project_package
```

`pixi` is offered automatically when the working directory is inside a pixi project with a
materialised `.pixi/envs/<name>` directory, so cells can import the project's dependencies directly.
When that environment does not ship `ipykernel`, the runtime supplies one from a cached uv
environment built for the same Python version, and reports that under `%%kernel`. If automatic Pixi
startup fails, the `%%kernel` listing explains the fallback to uv. A switch replaces the kernel, so kernel state is discarded, and sub-agents share the same environment choice. Code after the first-line directive runs after the switch in the selected environment.

The environment is verified before it is adopted; an environment that cannot import `ipykernel`
leaves the previous one active.

## Development

```bash
npm install
npm run check
```

## License

MIT
