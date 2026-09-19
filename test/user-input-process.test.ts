import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { UserInputStore } from "../src/user-input/store.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("recovers committed questions and exact user notes after the writer exits without closing SQLite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-answer-crash-"));
  directories.push(dir);
  const filename = path.join(dir, "private", "questions.sqlite3");
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
 import {UserInputStore} from './src/user-input/store.ts';
 const store=new UserInputStore(${JSON.stringify(filename)});
 const request=store.create('scope',{request_key:'durable',questions:[{title:'Question',options:['A','B']}]});
 store.answer(request.request_id,{question_id:'q1',expected_revision:0,selected_option_id:'o2',notes:'B, but keep the existing files.\\nSecond line.'});
 process.stdout.write(JSON.stringify(request),()=>process.exit(0));
 `,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 },
  );
  const request = JSON.parse(result.stdout) as { request_id: string };
  const recovered = new UserInputStore(filename);
  try {
    expect(
      recovered.getForScope("scope", request.request_id).questions[0]!.answer,
    ).toMatchObject({
      selected_option_label: "B",
      notes: "B, but keep the existing files.\nSecond line.",
      delivery: "saved",
    });
    expect(recovered.delivery("scope").content[0]!.text).toContain(
      "B, but keep",
    );
    if (process.platform !== "win32")
      expect((await stat(filename)).mode & 0o077).toBe(0);
  } finally {
    recovered.close();
  }
});
