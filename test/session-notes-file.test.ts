import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { SessionNotes } from "../src/session-notes.js";
import {
  NOTES_FILE_VERSION,
  sessionNotesPath,
} from "../src/session-notes-file.js";
import { NOTE_RETENTION_MS } from "../src/session-notes-types.js";

const result = (): CallToolResult => ({
  content: [{ type: "text", text: "normal" }],
});

let root: string;
let file: string;
const stores: SessionNotes[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "exec-notes-file-"));
  file = sessionNotesPath(path.join(root, "config.toml"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await rm(root, { recursive: true, force: true });
});

function open(now: () => number, logs: string[] = []) {
  const store = new SessionNotes(undefined, now, {
    file,
    log: (line) => logs.push(line),
  });
  stores.push(store);
  const close = store.openWeb(() => {});
  return { store, logs, close };
}

describe("saved session notes", () => {
  it("keeps notes, questions, messages and titles across a restart and delivers each note once", async () => {
    const now = Date.UTC(2026, 8, 20);
    const first = open(() => now);
    first.store.observe("a");
    first.store.setTitle("a", "Fix the build");
    first.store.enqueue("a", "note-1", "use the staging config");
    const asked = first.store.ask("a", {
      questions: [{ title: "Which branch?", options: ["main", "dev"] }],
    });
    first.store.sendMessage("a", { message: "Build started" });
    await first.store.close();

    expect(file).toBe(path.join(root, ".exec-mcp", "config.toml.notes.json"));
    // Windows does not report POSIX permission bits.
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.version).toBe(NOTES_FILE_VERSION);
    expect(await readdir(path.dirname(file))).toEqual([
      "config.toml.notes.json",
    ]);

    const second = open(() => now + 1000);
    const page = second.store.page("a");
    expect(page.label).toBe("Fix the build");
    expect(page.items.map((n) => [n.id, n.status])).toEqual([
      ["note-1", "pending"],
    ]);
    expect(page.agentMessages.map((m) => m.text)).toEqual(["Build started"]);
    const questions = second.store.questions("a");
    expect(questions.items).toMatchObject([
      { requestId: asked.request_id, title: "Which branch?", pending: true },
    ]);
    const delivered = second.store.attach(result(), "a", "call-1");
    expect(JSON.stringify(delivered.content)).toContain(
      "use the staging config",
    );
    // Delivery is saved at once; a crash right after it must not repeat the note.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await second.store.flush();

    const third = open(() => now + 2000);
    expect(third.store.page("a").items[0]).toMatchObject({
      status: "attached",
      callId: "call-1",
    });
    expect(third.store.attach(result(), "a", "call-2")).toEqual(result());
    expect(first.logs.concat(second.logs, third.logs)).toEqual([]);
  });

  it("keeps free-text and existing choice questions together across restarts", async () => {
    const now = Date.UTC(2026, 8, 20);
    const first = open(() => now);
    first.store.ask("a", {
      questions: [{ title: "Which branch?", options: ["main", "dev"] }],
    });
    const input = {
      questions: [{ title: "What needs to change?" }],
      request_key: "change",
    };
    const asked = first.store.ask("a", input);
    await first.store.close();

    const second = open(() => now + 1000);
    expect(second.store.ask("a", input)).toEqual(asked);
    const questions = second.store.questions("a").items;
    expect(questions.map((q) => q.options)).toEqual([[], ["main", "dev"]]);
    const q = questions[0]!;
    second.store.answer("a", q.id, {
      id: "text",
      option_index: null,
      note: "Keep the current behavior.",
    });
    await second.store.close();

    const third = open(() => now + 2000);
    expect(
      third.store.questions("a").items.find((item) => item.id === q.id),
    ).toMatchObject({
      options: [],
      pending: false,
      answer: { option_index: null, note: "Keep the current behavior." },
    });
    expect(
      JSON.stringify(third.store.attach(result(), "a", "answer").content),
    ).toContain("Answer: Keep the current behavior.");
    expect(third.store.attach(result(), "a", "again")).toEqual(result());
  });

  it("drops expired records when it loads a file", async () => {
    const now = Date.UTC(2026, 8, 20);
    const first = open(() => now);
    first.store.observe("a");
    first.store.enqueue("a", "note-1", "old");
    await first.store.close();

    const later = open(() => now + NOTE_RETENTION_MS + 1);
    expect(() => later.store.page("a")).toThrow("not known");
  });

  it.each([
    ["not JSON", "{not json", "it is not valid JSON"],
    [
      "another version",
      JSON.stringify({ version: 99, conversations: [] }),
      "not a valid version 1 notes file",
    ],
  ])(
    "moves a file that is %s aside, logs one line and starts empty",
    async (_name, body, reason) => {
      const first = open(() => 0);
      first.store.observe("seed");
      first.store.enqueue("seed", "x", "seed");
      await first.store.close();
      await writeFile(file, body);

      const logs: string[] = [];
      const now = Date.UTC(2026, 8, 20);
      const { store } = open(() => now, logs);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(reason);
      expect(logs[0]).toContain("Moved the file to");
      const files = await readdir(path.dirname(file));
      const moved = files.find((name) => name.includes(".unreadable-"));
      expect(moved).toBeDefined();
      expect(
        await readFile(path.join(path.dirname(file), moved!), "utf8"),
      ).toBe(body);
      expect(() => store.page("seed")).toThrow("not known");

      store.observe("fresh");
      store.enqueue("fresh", "y", "after recovery");
      await store.close();
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(saved.conversations.map((c: { id: string }) => c.id)).toEqual([
        "fresh",
      ]);
    },
  );

  it("keeps a session-only store when no file is configured", async () => {
    const store = new SessionNotes();
    store.openWeb(() => {});
    store.observe("a");
    store.enqueue("a", "note-1", "memory only");
    await store.close();
    expect(await readdir(root)).toEqual([]);
  });
});
