import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigEditor, setTomlBoolean } from "../src/web/config-edit.js";
import { CONFIG_TEMPLATE } from "../src/config.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(extra = "") {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-config-edit-")),
  );
  dirs.push(dir);
  const filename = path.join(dir, "config.toml");
  await writeFile(filename, CONFIG_TEMPLATE + extra);
  await chmod(filename, 0o600);
  return { dir, filename, editor: new ConfigEditor(filename) };
}

describe("targeted TOML switches", () => {
  it.each([
    [
      '[mcp_servers."a.b"] # heading\ncommand="node"\nenabled = true # keep comment\n',
      ["mcp_servers", "a.b", "enabled"],
    ],
    [
      'mcp_servers = { "a.b" = { command="node", enabled=true } }\n',
      ["mcp_servers", "a.b", "enabled"],
    ],
    [
      '[mcp_servers."a.b"]\ncommand="node"\n',
      ["mcp_servers", "a.b", "enabled"],
    ],
    [
      '[mcp_servers."a.b"]\r\ncommand="node"\r\n',
      ["mcp_servers", "a.b", "enabled"],
    ],
    [
      '[[skills.config]]\nname="one"\nenabled=true\n',
      ["skills", "config", 0, "enabled"],
    ],
    [
      'skills = { config = [{ name="one", enabled=true }] }\n',
      ["skills", "config", 0, "enabled"],
    ],
  ] as [string, (string | number)[]][])(
    "edits only a boolean within %s",
    (source, target) => {
      const before = TOML.parse(source);
      const changed = setTomlBoolean(source, target, false);
      const after = TOML.parse(changed);
      let expected: Record<string | number, unknown> = before;
      for (const name of target.slice(0, -1))
        expected = expected[name] as Record<string | number, unknown>;
      expected[target.at(-1)!] = false;
      expect(after).toEqual(before);
      if (source.includes("# keep comment"))
        expect(changed).toContain("# keep comment");
      if (source.includes("\r\n"))
        expect(changed.replaceAll("\r\n", "")).not.toContain("\n");
    },
  );
  it("preserves the full file, comments and secret-like values; serializes revisions and rejects stale writes", async () => {
    const f = await fixture(
      '\n[mcp_servers.existing]\ncommand="node"\nenabled=false # operator note\n[mcp_servers.existing.env]\nPRIVATE_TOKEN="fixture-token"\n',
    );
    const first = await f.editor.read();
    const second = await f.editor.toggle(
      { kind: "mcp", name: "existing", enabled: true },
      first.revision,
    );
    expect(second.source).toBe(
      first.source.replace(
        "enabled=false # operator note",
        "enabled=true # operator note",
      ),
    );
    expect(second.source).toContain('PRIVATE_TOKEN="fixture-token"');
    await expect(
      f.editor.toggle(
        { kind: "setting", name: "execution.login", enabled: true },
        first.revision,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.editor.toggle(
        { kind: "mcp", name: "unknown", enabled: true },
        second.revision,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const results = await Promise.allSettled([
      f.editor.toggle(
        { kind: "setting", name: "execution.login", enabled: true },
        second.revision,
      ),
      f.editor.toggle(
        { kind: "setting", name: "web.enabled", enabled: false },
        second.revision,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    if (process.platform !== "win32")
      expect((await stat(f.filename)).mode & 0o777).toBe(0o600);
  });
  it("preserves config symlinks and rejects invalid config before replacing the file", async () => {
    const f = await fixture();
    const alias = path.join(f.dir, "alias");
    await mkdir(alias);
    await symlink(
      f.dir,
      path.join(alias, "directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const editor = new ConfigEditor(
      path.join(alias, "directory", "config.toml"),
    );
    const before = await editor.read();
    await editor.toggle(
      { kind: "setting", name: "execution.login", enabled: true },
      before.revision,
    );
    expect(await readFile(f.filename, "utf8")).toContain('"login" = true');
    await writeFile(f.filename, "broken = [");
    await expect(
      editor.toggle(
        { kind: "setting", name: "execution.login", enabled: false },
        before.revision,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await readFile(f.filename, "utf8")).toBe("broken = [");
  });
  it("toggles only a discovered Skill with a final path rule and exposes disabled metadata only to management", async () => {
    const f = await fixture(
      '\n[[skills.config]]\nname="review"\nenabled=false\n',
    );
    const bundle = path.join(f.dir, ".agents", "skills", "review");
    await mkdir(bundle, { recursive: true });
    const skill = path.join(bundle, "SKILL.md");
    await writeFile(
      skill,
      "---\nname: review\ndescription: review code\n---\nbody\n",
    );
    const first = await f.editor.read();
    const enabled = await f.editor.toggle(
      { kind: "skill", path: skill, workdir: f.dir, enabled: true },
      first.revision,
    );
    expect(enabled.config.skills!.config!.at(-1)).toEqual({
      path: skill,
      enabled: true,
    });
    const disabled = await f.editor.toggle(
      { kind: "skill", path: skill, workdir: f.dir, enabled: false },
      enabled.revision,
    );
    expect(disabled.config.skills!.config).toHaveLength(2);
    expect(disabled.config.skills!.config!.at(-1)).toEqual({
      path: skill,
      enabled: false,
    });
    await expect(
      f.editor.toggle(
        {
          kind: "skill",
          path: path.join(f.dir, "absent"),
          workdir: f.dir,
          enabled: true,
        },
        disabled.revision,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("appends path rules inside an existing inline array without losing comments or other settings", async () => {
    const f = await fixture(
      '\n[skills]\nmax_chars=40000\nconfig = [ {name="review", enabled=false}, # keep\n]\n',
    );
    const bundle = path.join(f.dir, ".agents", "skills", "review");
    await mkdir(bundle, { recursive: true });
    const file = path.join(bundle, "SKILL.md");
    await writeFile(file, "---\nname: review\ndescription: sample\n---\n");
    const first = await f.editor.read();
    const next = await f.editor.toggle(
      { kind: "skill", path: file, workdir: f.dir, enabled: true },
      first.revision,
    );
    expect(next.source).toContain("# keep");
    expect(next.config.skills!.max_chars).toBe(40000);
    expect(next.config.skills!.config!.at(-1)).toEqual({
      path: file,
      enabled: true,
    });
  });
});
