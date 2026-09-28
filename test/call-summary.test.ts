import { describe, expect, it } from "vitest";
import { ActivityStore } from "../src/web/activity.js";
import {
  callListItem,
  compactSteps,
  errorPreview,
  nestedPreview,
} from "../src/web/call-summary.js";
import type { CallRecord, SubCallRecord } from "../src/web/types.js";

function subcall(
  name: string,
  input: unknown,
  output?: unknown,
  status: SubCallRecord["status"] = "success",
): SubCallRecord {
  return {
    id: `sub_${name}`,
    name,
    timestamp: "2026-09-28T00:00:00.000Z",
    durationMs: 5,
    input,
    ...(output === undefined ? {} : { output }),
    status,
  };
}

function call(overrides: Partial<CallRecord>): CallRecord {
  return {
    id: "call_1",
    sessionId: "scope",
    tool: "exec",
    status: "completed",
    startedAt: "2026-09-28T00:00:00.000Z",
    args: {},
    subcalls: [],
    ...overrides,
  };
}

describe("compact call listings", () => {
  it("previews nested inputs by kind without copying their outputs", () => {
    expect(
      nestedPreview("exec_command", { cmd: "\n  npm test\nrm -rf x" }),
    ).toBe("npm test");
    expect(
      nestedPreview(
        "apply_patch",
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: docs/b.md\n+hi\n*** Update File: src/a.ts\n*** End Patch",
      ),
    ).toBe("src/a.ts, docs/b.md");
    expect(
      nestedPreview("write_stdin", { session_id: "term_1", chars: "" }),
    ).toBe("");
    expect(
      nestedPreview("write_stdin", { session_id: "term_1", chars: "q\n" }),
    ).toBe("q\n");
    expect(
      nestedPreview("request_user_input_async", {
        questions: [{ title: "Pick a mode", options: ["a", "b"] }],
      }),
    ).toBe("Pick a mode");
    expect(nestedPreview("mcp__jira__get_issue", { issue_key: "ABC-12" })).toBe(
      "issue_key: ABC-12",
    );
    expect(nestedPreview("list_skills", {})).toBe("");
    expect(
      nestedPreview("exec_command", { cmd: "x".repeat(500) }),
    ).toHaveLength(120);
  });

  it("keeps the first five and last three nested calls with their handles and exit codes", () => {
    const subcalls = Array.from({ length: 12 }, (_, index) =>
      subcall("exec_command", { cmd: `step ${index}` }, { exit_code: index }),
    );
    subcalls[0] = subcall(
      "exec_command",
      { cmd: "npm run dev" },
      { session_id: "term_dev", output: "PRIVATE_OUTPUT" },
    );
    subcalls[11] = subcall(
      "request_user_input_async",
      { questions: [{ title: "Continue?", options: ["yes", "no"] }] },
      { accepted: true, request_id: "ask_1" },
    );
    const steps = compactSteps(subcalls);
    expect(steps.map((step) => step.preview)).toEqual([
      "npm run dev",
      "step 1",
      "step 2",
      "step 3",
      "step 4",
      "step 9",
      "step 10",
      "Continue?",
    ]);
    expect(steps[0]).toMatchObject({ handle: "term_dev" });
    expect(steps[0]).not.toHaveProperty("exitCode");
    expect(steps[1]).toMatchObject({ exitCode: 1 });
    expect(steps[7]).toMatchObject({ handle: "ask_1" });
    expect(JSON.stringify(steps)).not.toContain("PRIVATE_OUTPUT");
  });

  it("links yielded cells and explains failures on the listing row", () => {
    expect(
      callListItem(
        call({
          status: "yielding",
          output: {
            content: [
              {
                type: "text",
                text: "Script running with cell ID 42\nWall time 10.0 seconds\nOutput:\n",
              },
            ],
          },
        }),
      ).cellId,
    ).toBe("42");
    expect(
      errorPreview(
        call({
          status: "error",
          output: {
            content: [
              {
                type: "text",
                text: "Script failed\nWall time 0.0 seconds\nOutput:\n",
              },
              { type: "text", text: "printed first\n" },
              {
                type: "text",
                text: "Script error:\nSyntaxError: Unexpected identifier 'x'\nmore",
              },
            ],
            isError: true,
          },
        }),
      ),
    ).toBe("SyntaxError: Unexpected identifier 'x'");
    expect(
      errorPreview(call({ status: "error", error: "\nhost failed\ndetail" })),
    ).toBe("host failed");
    expect(errorPreview(call({ status: "completed", error: "x" }))).toBe(
      undefined,
    );
  });

  it("reports the latest nested call on the conversation summary", () => {
    const activity = new ActivityStore();
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "scope",
      args: { source: "const a = await tools.exec_command({" },
    });
    tracker.recordSubcall({
      name: "exec_command",
      durationMs: 1,
      input: { cmd: "git status\nsecond line" },
      status: "success",
    });
    tracker.recordSubcall({
      name: "apply_patch",
      durationMs: 1,
      input: "*** Begin Patch\n*** Update File: README.md\n*** End Patch",
      status: "success",
    });
    expect(activity.getSessions().items[0]?.lastCall?.step).toEqual({
      name: "apply_patch",
      preview: "README.md",
      status: "success",
    });
  });

  it("shows a nested call while it runs and completes the same record", () => {
    const activity = new ActivityStore();
    const events: unknown[] = [];
    activity.subscribe((event) => events.push(event));
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "scope",
      args: { source: "await tools.exec_command({cmd: 'npm test'})" },
    });
    const nested = tracker.startSubcall("exec_command", {
      cmd: "npm test\nsecond",
    });
    const running = callListItem(activity.getCall(tracker.id)!);
    expect(running.steps).toEqual([
      expect.objectContaining({
        name: "exec_command",
        status: "running",
        preview: "npm test",
      }),
    ]);
    expect(activity.getSessions().items[0]?.lastCall?.step).toMatchObject({
      preview: "npm test",
      status: "running",
    });
    nested.finish({
      durationMs: 42,
      output: { output: "PASS", exit_code: 0 },
      status: "success",
    });
    nested.finish({ durationMs: 1, status: "error" });
    const [subcall] = activity.getCall(tracker.id)!.subcalls;
    expect(subcall).toMatchObject({
      status: "success",
      durationMs: 42,
      output: { output: "PASS", exit_code: 0 },
    });
    expect(activity.getSessions().items[0]?.lastCall?.step?.status).toBe(
      "success",
    );
    expect(
      events.filter(
        (event) => (event as { type: string }).type === "call:subcall",
      ),
    ).toHaveLength(2);
  });
});
