import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const hasRg = spawnSync("rg", ["--version"]).status === 0;

test(
	"ripgrep helpers return native collection and string results",
	{ skip: !hasRg && "ripgrep not installed" },
	() => {
		const root = mkdtempSync(join(tmpdir(), "pi-rlm-runtime-rg-"));
		try {
			writeFileSync(join(root, "train.py"), "needle = True\n");
			writeFileSync(join(root, "metric.py"), "jaccard = 1\n");
			writeFileSync(join(root, "notes.txt"), "needle = excluded\n");
			const script = `
from pi_rlm_runtime import rg_files, rg_search

files = rg_files("*.py", ${JSON.stringify(root)})
assert sorted(path.rsplit("/", 1)[-1] for path in files) == ["metric.py", "train.py"]
assert files[0].rsplit("/", 1)[-1] in ("metric.py", "train.py")
assert sorted(path.rsplit("/", 1)[-1] for path in files.paths) == ["metric.py", "train.py"]

result = rg_search(r"needle|jaccard", ${JSON.stringify(root)}, glob="*.py")
assert isinstance(result, str)
assert "needle" in result
assert result[:1] == result[0]
assert bool(result)
empty = rg_search("does-not-exist", ${JSON.stringify(root)})
assert empty == ""
assert empty.matches == ()
assert str(empty) == "(no matches)"
`;
			const completed = spawnSync("python3", ["-c", script], {
				cwd: process.cwd(),
				env: { ...process.env, PYTHONPATH: join(process.cwd(), "python") },
				encoding: "utf8",
			});
			assert.equal(completed.status, 0, completed.stderr || completed.stdout);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
