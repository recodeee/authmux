import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import {
  getLoginHookStatus,
  LOGIN_HOOK_MARK_END,
  LOGIN_HOOK_MARK_START,
  installLoginHook,
  renderLoginHookBlock,
  removeLoginHook,
} from "../lib/config/login-hook";

async function withTempRcFile(
  t: TestContext,
  fn: (rcPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "authmux-hook-"));
  const rcPath = path.join(tempDir, ".bashrc");
  await fsp.writeFile(rcPath, "# test bashrc\n", "utf8");

  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await fn(rcPath);
}

test("installLoginHook writes marker block when missing", async (t) => {
  await withTempRcFile(t, async (rcPath) => {
    const result = await installLoginHook(rcPath);
    assert.equal(result, "installed");

    const contents = await fsp.readFile(rcPath, "utf8");
    assert.ok(contents.includes(LOGIN_HOOK_MARK_START));
    assert.ok(contents.includes(LOGIN_HOOK_MARK_END));
  });
});

test("installLoginHook is idempotent", async (t) => {
  await withTempRcFile(t, async (rcPath) => {
    const first = await installLoginHook(rcPath);
    const second = await installLoginHook(rcPath);
    assert.equal(first, "installed");
    assert.equal(second, "already-installed");

    const contents = await fsp.readFile(rcPath, "utf8");
    const startCount = contents.split(LOGIN_HOOK_MARK_START).length - 1;
    assert.equal(startCount, 1);
  });
});

test("installLoginHook refreshes an existing legacy hook block", async (t) => {
  await withTempRcFile(t, async (rcPath) => {
    const legacyBlock = [
      LOGIN_HOOK_MARK_START,
      "# legacy",
      LOGIN_HOOK_MARK_END,
    ].join("\n");
    await fsp.writeFile(rcPath, `# test bashrc\n\n${legacyBlock}\n`, "utf8");

    const result = await installLoginHook(rcPath);
    assert.equal(result, "updated");

    const contents = await fsp.readFile(rcPath, "utf8");
    assert.ok(contents.includes("command authmux restore-session"));
    assert.ok(contents.includes("command authmux skills activate-current --agent codex"));
    assert.ok(contents.includes("CODEX_AUTH_FORCE_EXTERNAL_SYNC=1 command authmux status"));
    assert.ok(!contents.includes("# legacy"));
    const startCount = contents.split(LOGIN_HOOK_MARK_START).length - 1;
    assert.equal(startCount, 1);
  });
});

test("removeLoginHook removes installed marker block", async (t) => {
  await withTempRcFile(t, async (rcPath) => {
    await installLoginHook(rcPath);
    const result = await removeLoginHook(rcPath);
    assert.equal(result, "removed");

    const contents = await fsp.readFile(rcPath, "utf8");
    assert.ok(!contents.includes(LOGIN_HOOK_MARK_START));
    assert.ok(!contents.includes(LOGIN_HOOK_MARK_END));
  });
});

test("removeLoginHook returns not-installed when hook is absent", async (t) => {
  await withTempRcFile(t, async (rcPath) => {
    const result = await removeLoginHook(rcPath);
    assert.equal(result, "not-installed");
  });
});

test("getLoginHookStatus reflects installed state", async (t) => {
  await withTempRcFile(t, async (rcPath) => {
    const before = await getLoginHookStatus(rcPath);
    assert.equal(before.installed, false);
    assert.equal(before.rcPath, rcPath);

    await installLoginHook(rcPath);
    const after = await getLoginHookStatus(rcPath);
    assert.equal(after.installed, true);
    assert.equal(after.rcPath, rcPath);
  });
});

test("renderLoginHookBlock includes terminal-mode restore guard", () => {
  const hook = renderLoginHookBlock();
  assert.ok(hook.includes("__codex_auth_restore_tty"));
  assert.ok(hook.includes("codex() {"));
  assert.ok(hook.includes("command authmux restore-session"));
  assert.ok(hook.includes("command authmux skills activate-current --agent codex"));
  assert.ok(hook.includes("CODEX_AUTH_FORCE_EXTERNAL_SYNC=1 command authmux status"));
  assert.ok(!hook.includes("__first_non_flag"));
  assert.ok(!hook.includes("if ! typeset -f codex"));
  assert.ok(hook.includes("\\033[>4m"));
  assert.ok(hook.includes("\\033[<u"));
  assert.ok(hook.includes("\\033[?2026l"));
  assert.ok(hook.includes("\\033[?1004l"));
  assert.ok(hook.includes("\\033[?2004l"));
  assert.ok(hook.includes("\\033[0m"));
  assert.ok(hook.includes("\\033[?25h"));
  assert.ok(hook.includes("CODEX_AUTH_SKIP_TTY_RESTORE"));
});
