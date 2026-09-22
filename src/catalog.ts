import { z } from "zod/v4";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import { SESSION_IDLE_MS } from "./code-mode/session-pool.js";
import { shellDescription, type CommandShell } from "./host/shell.js";
import type { NativeToolName } from "./tool-names.js";
import { REQUEST_USER_INPUT_SCHEMA } from "./user-questions.js";
import {
  RESOURCE_LIST_SCHEMA,
  RESOURCE_READ_SCHEMA,
} from "./downstream/resources.js";
import {
  HOST_FILE_SCHEMA,
  IMPORT_FILE_SCHEMA,
  EXPORT_FILE_SCHEMA,
} from "./files/contracts.js";

const ms = (maximum: number, description: string) =>
  z.number().int().min(0).max(maximum).describe(description).optional();
const tokenBudget = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    "Approximate text token budget for this response; 0 omits text. Media, execution status and user notes are preserved. Subject to the final output limit.",
  )
  .optional();
export const EXEC_SCHEMA = z
  .object({
    max_output_tokens: tokenBudget,
    files: z
      .array(HOST_FILE_SCHEMA)
      .optional()
      .describe(
        "ChatGPT file references, passed unchanged in their original order. The host binds these to file objects; tools.import_file selects a file by zero-based index.",
      ),
    source: z
      .string()
      .min(1)
      .describe(
        "JavaScript source evaluated as an async module. Shell commands run through tools.exec_command({cmd: ...}).",
      ),
    workdir: z
      .string()
      .min(1)
      .describe(
        "Default working directory for this exec's local tools. Omitted or relative paths resolve from the service user's home directory; supports ~/.",
      )
      .optional(),
    yield_time_ms: ms(
      30_000,
      "Time before yielding a still-running script. Defaults to 10000 ms; range 0-30000. Does not set an execution deadline.",
    ),
  })
  .strict();
export const WAIT_SCHEMA = z
  .object({
    max_tokens: tokenBudget,
    cell_id: z
      .string()
      .min(1)
      .describe(
        "Running exec cell to resume, as returned by exec. Distinct from a terminal session_id.",
      ),
    yield_time_ms: ms(
      110_000,
      "Time before yielding again. Defaults to 110000 ms; range 0-110000. Completion or yield_control returns sooner.",
    ),
    terminate: z
      .boolean()
      .describe(
        "True stops the cell and requests cancellation of pending nested calls. Side effects and terminals already returned with a session_id are not rolled back or stopped.",
      )
      .optional(),
  })
  .strict();
export const COMMAND_SCHEMA = z
  .object({
    cmd: z.string().min(1).describe("Shell command to execute."),
    workdir: z
      .string()
      .min(1)
      .describe(
        "Working directory for the command. Defaults to exec.workdir; relative paths resolve there. Supports ~/.",
      )
      .optional(),
    shell: z
      .string()
      .min(1)
      .refine((value) => !!value.trim() && !value.includes("\0"))
      .describe(
        "Shell binary to launch for this command. Defaults to the instance's configured shell. Relative paths resolve from the command's working directory.",
      )
      .optional(),
    login: z
      .boolean()
      .describe(
        "Enable login shell semantics (profile loading for PowerShell) for this command. Defaults to the instance setting; does not change later commands.",
      )
      .optional(),
    tty: z
      .boolean()
      .describe(
        "True allocates a PTY for the command; false or omitted uses plain pipes.",
      )
      .optional(),
    yield_time_ms: ms(
      30_000,
      "Wait before yielding output. Defaults to 10000 ms; range 0-30000. Commands that finish sooner return immediately.",
    ),
  })
  .strict();
export const STDIN_SCHEMA = z
  .object({
    session_id: z
      .string()
      .min(1)
      .describe("Terminal session identifier returned by exec_command."),
    chars: z
      .string()
      .describe(
        "Characters to write to stdin. Defaults to empty, which collects output without writing.",
      )
      .optional(),
    close_stdin: z
      .boolean()
      .describe(
        "Close stdin after writing. Available for plain pipes, not PTYs.",
      )
      .optional(),
    yield_time_ms: ms(
      300_000,
      "Output collection window. Non-empty writes default to 250 ms and clamp to 250-30000; empty reads default to 5000 and clamp to 5000-300000. Process exit returns sooner; new output does not end the window. Explicit 0 reads immediately.",
    ),
    cols: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .describe("New PTY column count, supplied together with rows.")
      .optional(),
    rows: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .describe("New PTY row count, supplied together with cols.")
      .optional(),
    terminate: z
      .boolean()
      .describe(
        "True terminates this process tree and collects remaining output.",
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.cols === undefined) === (value.rows === undefined),
    "cols 和 rows 必须同时提供",
  );
export const IMAGE_SCHEMA = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Local filesystem path to an existing PNG, JPEG, WebP or GIF image. Relative to exec.workdir; supports ~/.",
      ),
    detail: z
      .enum(["high", "original"])
      .describe(
        "Image detail level. Defaults to high; original requests original detail.",
      )
      .optional(),
  })
  .strict();
const PATCH_SCHEMA = z.string().min(1);
const SKILL_INVOCATION_RULE =
  "Skills can be selected by their trigger descriptions; explicit-only skills are read only when the user explicitly requests them.";
const SKILL_SCHEMA = z
  .object({
    workdir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Starting directory for project skills, relative to exec.workdir. Defaults to an explicitly supplied exec.workdir; if both are omitted, lists user-level skills only.",
      ),
  })
  .strict();
const TERMINAL_OUTPUT = {
  type: "object",
  properties: {
    output: {
      type: "string",
      description:
        "Unread terminal output, up to 4 MiB per call. Larger remaining output can be collected with the same session_id.",
    },
    wall_time_seconds: { type: "number" },
    session_id: {
      type: "string",
      description:
        "Present while the process is running or output remains unread; pass to write_stdin.",
    },
    exit_code: {
      type: "integer",
      description:
        "Shell exit code, present once the process has exited and all output has been collected.",
    },
    truncated: {
      type: "boolean",
      const: true,
      description:
        "The terminal buffer overflowed and discarded middle output.",
    },
    omitted_bytes: {
      type: "integer",
      minimum: 0,
      description: "Discarded output bytes; not recoverable by later reads.",
    },
    stderr_bytes: {
      type: "integer",
      minimum: 0,
      description:
        "Cumulative stderr bytes for plain pipes, including discarded output. Not by itself a failure indicator; PTYs merge streams.",
    },
  },
  required: ["output", "wall_time_seconds"],
  additionalProperties: false,
};
const PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;
export interface NativeContract {
  name: NativeToolName;
  description: string;
  schema: z.ZodType;
  output?: Record<string, unknown>;
  freeform?: boolean;
}
const NATIVE_CONTRACTS: readonly NativeContract[] = [
  {
    name: "list_skills",
    schema: SKILL_SCHEMA,
    output: { type: "string" },
    description: `Lists available skill names, descriptions and resolved SKILL.md paths. Includes user-level skills and applicable project skills when a workdir is supplied. The full SKILL.md contains the workflow instructions. ${SKILL_INVOCATION_RULE}`,
  },
  {
    name: "import_file",
    schema: IMPORT_FILE_SCHEMA,
    description:
      "Saves exec.files[index] to a local destination. Returns {path,size,sha256}; path is the local file for subsequent operations. Existing destinations are preserved unless overwrite=true; replacement follows a successful download and validation.",
  },
  {
    name: "export_file",
    schema: EXPORT_FILE_SCHEMA,
    description:
      "Exports an independent file snapshot for the user. Returns {id,name,mime_type,size,sha256,expires_at,uri}; exec/wait automatically attaches a resource_link. Default resource delivery supports up to 32 MiB via resources/read. URL delivery requires a configured HTTPS download endpoint; anyone with the link can download until expiry. The host determines attachment display or mounting.",
  },
  {
    name: "exec_command",
    schema: COMMAND_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "Runs a shell command, returning output or a session ID for ongoing interaction. write_stdin continues the same terminal. A shell exit code does not describe the success of every command in a script.",
  },
  {
    name: "write_stdin",
    schema: STDIN_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "Writes characters to an existing exec_command session and returns recent output. Can also resize a PTY, close pipe stdin or terminate the process. A collection timeout leaves the process running; the returned session_id remains usable.",
  },
  {
    name: "apply_patch",
    schema: PATCH_SCHEMA,
    freeform: true,
    output: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        exit_code: { type: "integer" },
        output: { type: "string" },
      },
      required: ["success", "exit_code", "output"],
      additionalProperties: false,
    },
    description: `The apply_patch tool can be used to edit files. Takes a complete patch string; relative paths resolve from exec.workdir. The patch is sent through stdin, avoiding command-line argument limits. Returns success, exit_code and output; a failure may leave partial changes. Lark grammar:\n${PATCH_GRAMMAR}`,
  },
  {
    name: "view_image",
    schema: IMAGE_SCHEMA,
    description:
      "View a local image file from the filesystem when visual inspection is needed. Returns a CallToolResult containing an ImageContent block; image(result.content[0]) displays it.",
  },
  {
    name: "request_user_input_async",
    schema: REQUEST_USER_INPUT_SCHEMA,
    output: {
      type: "object",
      properties: {
        accepted: { const: true, type: "boolean" },
        request_id: { type: "string" },
      },
      required: ["accepted", "request_id"],
      additionalProperties: false,
    },
    description:
      "Ask the user one or more questions during ongoing work. Submits questions to this conversation's Web UI and immediately returns accepted, without waiting for answers. Answers include the question, choice and optional note, delivered as user notes with subsequent exec/wait responses. Requires a running Web server and a host-provided conversation ID.",
  },
  {
    name: "list_mcp_resources",
    schema: RESOURCE_LIST_SCHEMA,
    description:
      "Lists resources provided by MCP servers, such as files, database schemas or application-specific information. Returns {resources:[{server,uri,name,...}],server?,nextCursor?,errors?}. A specified server returns one page; omitting server aggregates enabled servers with failures in errors. Servers without resource support contribute an empty list. Resources are separate from the ALL_TOOLS method catalog.",
  },
  {
    name: "list_mcp_resource_templates",
    schema: RESOURCE_LIST_SCHEMA,
    description:
      "Lists resource templates provided by MCP servers. Returns {resourceTemplates:[{server,uriTemplate,name,...}],server?,nextCursor?,errors?}. Expanding a uriTemplate produces a concrete URI for read_mcp_resource. Pagination, aggregation and errors follow list_mcp_resources.",
  },
  {
    name: "read_mcp_resource",
    schema: RESOURCE_READ_SCHEMA,
    description:
      "Read a specific resource from an MCP server given the server name and resource URI. Known URIs can be read directly. Returns {server,uri,contents:[{uri,mimeType?,text?,blob?}]}: text is plain text; blob is Base64. The URI is resolved by that server, not as a local path or a generic download URL. Failures throw an error.",
  },
];
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...value } = z.toJSONSchema(schema, {
    unrepresentable: "throw",
  });
  return value;
}
export function describeContract(contract: NativeContract): string {
  return `${contract.description}\nCall: await tools.${contract.name}(${contract.freeform ? "patch" : "args"})\nInput JSON Schema: ${JSON.stringify(jsonSchema(contract.schema))}${contract.output ? `\nOutput JSON Schema: ${JSON.stringify(contract.output)}` : ""}`;
}
export function nativeDefinition(
  contract: NativeContract,
): Omit<CodeModeToolDefinition, "call"> {
  return {
    name: contract.name,
    description: describeContract(contract),
    kind: contract.freeform ? "freeform" : "function",
    ...(!contract.freeform ? { inputSchema: jsonSchema(contract.schema) } : {}),
    ...(contract.output ? { outputSchema: contract.output } : {}),
  };
}
export function bindNative(
  contract: NativeContract,
  call: CodeModeToolDefinition["call"],
): CodeModeToolDefinition {
  return {
    ...nativeDefinition(contract),
    call: async (raw, context) => {
      const parsed = contract.schema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          `工具 ${contract.name} 参数无效：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "/"} ${issue.code}`).join(", ")}；尚未执行。`,
        );
      return call(parsed.data, context);
    },
  };
}
export function nativeContracts(
  shell: CommandShell,
): readonly NativeContract[] {
  return NATIVE_CONTRACTS.map((contract) =>
    contract.name === "exec_command"
      ? {
          ...contract,
          description: contract.description + "\n" + shellDescription(shell),
        }
      : contract,
  );
}

export function execDescription(
  contracts: readonly NativeContract[],
  idleHours = SESSION_IDLE_MS / 3_600_000,
): string {
  return `Run JavaScript code to orchestrate/compose tool calls on this connection's specific remote machine.
- Work independently; do not invoke other agent CLIs on this machine (e.g. Codex or Claude Code) unless the user explicitly requests it.
- Evaluates source in a fresh V8 isolate as an async module. The MCP argument is an object whose source field contains JavaScript.
- All nested tools are available on the global tools object, for example await tools.exec_command(...). apply_patch takes a string; other local tools take an object. Tool return types are described below. Independent calls can run concurrently with Promise.all.
- Only the orchestration JS isolate lacks Node.js, filesystem, network, console and module imports. Tools access the remote machine's filesystem and network; separate ChatGPT containers do not share that environment.
- When the code is fully evaluated, the isolate's lifetime ends and unawaited promises are discarded. Ordinary JS variables do not persist across exec calls.
- workdir supplies the local tools' default directory. A shell's cd affects only that process. Nested JS, shell and other languages each interpret quoting, interpolation, escapes, argument boundaries and whitespace.
- Optional first-line pragma: // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}. Explicit MCP arguments take precedence.

## Tool discovery
Local tool contracts are included below. Downstream MCP tools are already bound to tools; their contracts are available in ALL_TOOLS, an array of {name, description} entries for all enabled nested tools.
To find one, filter ALL_TOOLS by name and description: text(ALL_TOOLS.filter(t => /keyword/i.test(t.name + " " + t.description))). A known name and argument shape can be called directly with await tools[name](args).
The catalog is not automatically printed; changes appear in the next exec. list_skills provides local skill metadata; a selected SKILL.md provides the full workflow.

## Global helpers
- text(value): Appends a text item. Non-string values are stringified with JSON.stringify when possible.
- image(imageUrlOrItem, detail?): Appends an image from a base64 data URL, {image_url, detail?}, or an individual MCP ImageContent block such as result.content[0]. detail is auto/low/high/original or null; the second argument overrides an embedded detail hint.
- audio(audioUrlOrItem): Appends audio from a base64 data URL, {audio_url}, or an individual MCP AudioContent block.
- generatedImage({image_url, output_hint?}): Appends an image-generation result from a base64 data URL and its optional output hint.
- store(key, value): Stores a serializable value under a string key for later exec calls in the same ChatGPT conversation; requires a host-provided conversation ID. load(key) returns a copy, or undefined if missing. Cells read a starting snapshot and merge writes when they finish, including on script error; concurrent same-key writes are not transactional. Changes to a loaded copy require another store. Storage may be cleared after ${idleHours} idle hours, memory recovery or restart.
- exit(): Immediately ends the current script successfully.
- yield_control(): Yields accumulated output to the model immediately while the script keeps running.
- setTimeout(callback, delayMs?) / clearTimeout(id?): Schedules/cancels a callback. Pending timeouts do not keep exec alive by themselves; an awaited promise can wait for one.

## Results and execution
Tool return values reach the model through explicit text/image/audio/generatedImage calls; exported resource links are attached automatically. Local methods return the values in their contracts. Downstream MCP methods return CallToolResult: {content, structuredContent?, isError?}; isError indicates failure. structuredContent holds structured data; content may add distinct text, media or resources.
Final response text is limited to 36,000 UTF-8 bytes, retaining the beginning and end on overflow. Omitted text is not returned by later waits. Nested results and store are not pre-truncated by this limit, so JS can filter or retain them before output. max_output_tokens narrows this response's text budget; wait.max_tokens is separate. Media and execution status are preserved. With user notes attached, the combined response text ceiling is 37,000 UTF-8 bytes.
exec waits 10000 ms by default, at most 30000. A still-running script returns Script running and cell_id; wait returns new output or the final result for that cell. Script completed means JavaScript finished, not that every command succeeded.
cell_id identifies a script. session_id identifies a terminal that remains usable across exec calls through tools.write_stdin. A nested terminal collection may span several outer exec/wait calls. wait({cell_id, terminate:true}) stops the cell and requests cancellation of pending calls; terminals already returned with session_id remain independent. Failures and cancellation do not undo side effects.

## Local tools
${contracts.map((contract) => `### ${contract.name}\n${describeContract(contract)}`).join("\n\n")}`;
}
export const WAIT_DESCRIPTION =
  "Returns only the new output since the last yield, or the final completion or termination result for an exec cell. A running cell may yield again with the same cell_id. Defaults to 110000 ms (also the maximum); longer waits reduce polling, while completion or yield_control returns sooner. terminate=true stops the cell; cancelling this wait only cancels observation. max_tokens limits this response independently of exec. Final text remains bounded to 36,000 UTF-8 bytes, or 37,000 with user notes; media and status are preserved. Terminal session_id handles are used with tools.write_stdin inside exec.";
