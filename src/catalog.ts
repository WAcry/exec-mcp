// Tool descriptions adapted from OpenAI Codex (Apache-2.0),
// rust-v0.164.0; see proto/LICENSE.
import { z } from "zod/v4";
import {
  schemaType,
  toolDeclaration,
  MCP_TYPESCRIPT_PREAMBLE,
} from "./tool-descriptions.js";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import { SESSION_IDLE_MS } from "./code-mode/session-pool.js";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_WAIT_YIELD_TIME_MS,
  MAX_EXEC_YIELD_TIME_MS,
  MAX_WAIT_YIELD_TIME_MS,
} from "./code-mode/exec-source.js";
import { MODEL_TEXT_BYTES } from "./code-mode/model-output.js";
import {
  COMMAND_YIELD_TIME_MS,
  STDIN_YIELD_TIME_MS,
  TERMINAL_READ_BYTES,
} from "./limits.js";
import { MiB } from "./memory.js";
import { NOTES_RESPONSE_BYTES } from "./session-notes-types.js";
import { shellDescription, type CommandShell } from "./host/shell.js";
import type { NativeToolName } from "./tool-names.js";
import { REQUEST_USER_INPUT_SCHEMA } from "./user-questions.js";
import { SEND_MESSAGE_TO_USER_SCHEMA } from "./agent-messages.js";
import {
  RESOURCE_LIST_SCHEMA,
  RESOURCE_READ_SCHEMA,
} from "./downstream/resources.js";
import {
  HOST_FILE_SCHEMA,
  IMPORT_FILE_SCHEMA,
  EXPORT_FILE_SCHEMA,
  RESOURCE_FILE_BYTES,
} from "./files/contracts.js";

const bytes = (value: number) => value.toLocaleString("en-US");
const mib = (value: number) => `${value / MiB} MiB`;
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
      MAX_EXEC_YIELD_TIME_MS,
      `Time before yielding a still-running script. Defaults to ${DEFAULT_EXEC_YIELD_TIME_MS} ms; range 0-${MAX_EXEC_YIELD_TIME_MS}. Does not set an execution deadline.`,
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
      MAX_WAIT_YIELD_TIME_MS,
      `Time before yielding again. Defaults to ${DEFAULT_WAIT_YIELD_TIME_MS} ms; range 0-${MAX_WAIT_YIELD_TIME_MS}. Completion, yield_control or new Web user input can return sooner.`,
    ),
    terminate: z
      .boolean()
      .describe(
        "True stops the cell and requests cancellation of pending nested calls. Side effects and terminals already returned with a session_id are not rolled back or stopped.",
      )
      .optional(),
  })
  .strict();
const commandTokenBudget = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
  )
  .optional();
export const COMMAND_SCHEMA = z
  .object({
    cmd: z.string().min(1).describe("Shell command to execute."),
    max_output_tokens: commandTokenBudget,
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
      .refine(
        (value) => !!value.trim() && !value.includes("\0"),
        "shell must not be blank or contain a NUL character",
      )
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
      COMMAND_YIELD_TIME_MS.max,
      `Wait before yielding output. Defaults to ${COMMAND_YIELD_TIME_MS.default} ms; range 0-${COMMAND_YIELD_TIME_MS.max}. Commands that finish sooner return immediately.`,
    ),
  })
  .strict();
export const STDIN_SCHEMA = z
  .object({
    max_output_tokens: commandTokenBudget,
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
      STDIN_YIELD_TIME_MS.read.max,
      `Output collection window. Non-empty writes default to ${STDIN_YIELD_TIME_MS.default} ms and clamp to ${STDIN_YIELD_TIME_MS.write.min}-${STDIN_YIELD_TIME_MS.write.max}; empty reads default to ${STDIN_YIELD_TIME_MS.read.min} and clamp to ${STDIN_YIELD_TIME_MS.read.min}-${STDIN_YIELD_TIME_MS.read.max}. Process exit returns sooner; new output does not end the window. Explicit 0 reads immediately.`,
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
    "cols and rows must be supplied together",
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
const TITLE_SCHEMA = z
  .object({ title: z.string().trim().min(1).max(120) })
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
      description: `Command output text, possibly truncated. Each call reads up to ${mib(TERMINAL_READ_BYTES)}; unread output remains available through session_id. Text omitted by the token budget cannot be recovered by later reads.`,
    },
    wall_time_seconds: {
      type: "number",
      description: "Elapsed wall time spent waiting for output in seconds.",
    },
    original_token_count: {
      type: "integer",
      description: "Approximate token count before output truncation.",
    },
    session_id: {
      type: "string",
      description:
        "Present while the process is running or output remains unread; pass to write_stdin.",
    },
    exit_code: {
      type: "integer",
      description:
        "Shell exit code, present once the process has exited and all output has been collected. A process stopped by signal N reports 128+N.",
    },
    truncated: {
      type: "boolean",
      const: true,
      description:
        "The terminal buffer or output token budget discarded middle output.",
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
export interface NativeContract<S extends z.ZodType = z.ZodType> {
  name: NativeToolName;
  description: string;
  schema: S;
  output?: Record<string, unknown>;
  freeform?: boolean;
}
/** Keeps each contract's schema type, so handlers receive typed input. */
function contract<N extends NativeToolName, S extends z.ZodType>(
  value: NativeContract<S> & { name: N },
): NativeContract<S> & { name: N } {
  return value;
}
const NATIVE_CONTRACTS = {
  list_skills: contract({
    name: "list_skills",
    schema: SKILL_SCHEMA,
    output: { type: "string" },
    description: `Lists available skill names, descriptions and resolved SKILL.md paths. Includes user-level skills and applicable project skills when a workdir is supplied. The full SKILL.md contains the workflow instructions. ${SKILL_INVOCATION_RULE}`,
  }),
  import_file: contract({
    name: "import_file",
    schema: IMPORT_FILE_SCHEMA,
    description:
      "Saves exec.files[index] to a local destination. Returns {path,size,sha256}; path is the local file for subsequent operations. Existing destinations are preserved unless overwrite=true; replacement follows a successful download and validation.",
  }),
  export_file: contract({
    name: "export_file",
    schema: EXPORT_FILE_SCHEMA,
    description: `Exports an independent file snapshot for the user. Returns {id,name,mime_type,size,sha256,expires_at,uri}; exec/wait automatically attaches a resource_link. Default resource delivery supports up to ${mib(RESOURCE_FILE_BYTES)} via resources/read. URL delivery requires a configured HTTPS download endpoint; anyone with the link can download until expiry. The host determines attachment display or mounting.`,
  }),
  exec_command: contract({
    name: "exec_command",
    schema: COMMAND_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "Runs a command in a shell, returning output or a session ID for ongoing interaction.",
  }),
  write_stdin: contract({
    name: "write_stdin",
    schema: STDIN_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "Writes characters to an existing exec_command session and returns recent output. Can also resize a PTY, close pipe stdin or terminate the process.",
  }),
  apply_patch: contract({
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
    description:
      "The `apply_patch` tool can be used to edit files. Pass the complete patch as a string.",
  }),
  view_image: contract({
    name: "view_image",
    schema: IMAGE_SCHEMA,
    output: {
      type: "object",
      properties: {
        image_url: {
          type: "string",
          description: "Data URL for the loaded image.",
        },
        detail: {
          type: "string",
          enum: ["high", "original"],
          description: "Image detail hint passed to the host.",
        },
      },
      required: ["image_url", "detail"],
      additionalProperties: false,
    },
    description:
      "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
  }),
  request_user_input_async: contract({
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
      "Ask the user one or more questions during ongoing work. Use this tool only to request missing information, preferences, constraints, clarification, or approval. The tool returns immediately without ending the turn or waiting for a reply; answers arrive as user notes with subsequent exec/wait responses. Keep questions concise, self-contained, and easy to understand, using a level of detail appropriate to the user and task. The UI always allows a free-text answer, including when suggested options are provided. A preselected option is not submitted automatically. Requires a running Web server and a host-provided conversation ID.",
  }),
  send_message_to_user_async: contract({
    name: "send_message_to_user_async",
    schema: SEND_MESSAGE_TO_USER_SCHEMA,
    output: {
      type: "object",
      properties: { accepted: { const: true, type: "boolean" } },
      required: ["accepted"],
      additionalProperties: false,
    },
    description:
      "Send a concise message that needs the user's attention during ongoing work. The message appears in this conversation's Web UI, and the tool returns immediately without ending the turn or waiting for a reply. Use this tool to report a critical blocker or a finding that may change the task's direction, or to answer a user question or status request received while work is still in progress. Use this tool when a message needs the user's immediate attention; use commentary for routine progress and intermediate context. It informs rather than asks: do not expect a reply, and use request_user_input_async when you need an answer. Requires a running Web server and a host-provided conversation ID.",
  }),
  set_conversation_title: contract({
    name: "set_conversation_title",
    schema: TITLE_SCHEMA,
    output: {
      type: "object",
      properties: { set: { type: "boolean" } },
      required: ["set"],
      additionalProperties: false,
    },
    description:
      "Sets a title for this conversation so the user can easily find and manage it. Call once in your first exec with 3 to 8 words summarizing the user's task, in the user's language. Only the first title is kept.",
  }),
  list_mcp_resources: contract({
    name: "list_mcp_resources",
    schema: RESOURCE_LIST_SCHEMA,
    description:
      "Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible. Returns {resources:[{server,uri,name,...}],server?,nextCursor?,errors?}. A specified server returns one page; omitting server aggregates enabled servers with failures in errors. Servers without resource support contribute an empty list. Resources are separate from the ALL_TOOLS method catalog.",
  }),
  list_mcp_resource_templates: contract({
    name: "list_mcp_resource_templates",
    schema: RESOURCE_LIST_SCHEMA,
    description:
      "Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible. Returns {resourceTemplates:[{server,uriTemplate,name,...}],server?,nextCursor?,errors?}. Expanding a uriTemplate produces a concrete URI for read_mcp_resource. Pagination, aggregation and errors follow list_mcp_resources.",
  }),
  read_mcp_resource: contract({
    name: "read_mcp_resource",
    schema: RESOURCE_READ_SCHEMA,
    description:
      "Read a specific resource from an MCP server given the server name and resource URI. Known URIs can be read directly. Returns {server,uri,contents:[{uri,mimeType?,text?,blob?}]}: text is plain text; blob is Base64. The URI is resolved by that server, not as a local path or a generic download URL. Failures throw an error.",
  }),
} satisfies { [K in NativeToolName]: NativeContract & { name: K } };
export type NativeContracts = typeof NATIVE_CONTRACTS;

const jsonSchemas = new WeakMap<z.ZodType, Record<string, unknown>>();
const descriptions = new WeakMap<NativeContract, string>();
const definitions = new WeakMap<
  NativeContract,
  Omit<CodeModeToolDefinition, "call">
>();

/** JSON Schema for a zod schema, computed once per schema object. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  let value = jsonSchemas.get(schema);
  if (value === undefined) {
    const { $schema: _dialect, ...converted } = z.toJSONSchema(schema, {
      unrepresentable: "throw",
    });
    value = converted;
    jsonSchemas.set(schema, value);
  }
  return value;
}
export function describeContract(contract: NativeContract): string {
  let value = descriptions.get(contract);
  if (value === undefined) {
    value = `${contract.description}\n\n${toolDeclaration(contract.name, contract.freeform ? "string" : schemaType(jsonSchema(contract.schema)), contract.output ? schemaType(contract.output) : "unknown", contract.freeform ? "input" : "args")}`;
    descriptions.set(contract, value);
  }
  return value;
}
/** The Code Mode definition of a contract, computed once per contract object. */
export function nativeDefinition(
  contract: NativeContract,
): Omit<CodeModeToolDefinition, "call"> {
  let value = definitions.get(contract);
  if (value === undefined) {
    value = {
      name: contract.name,
      description: describeContract(contract),
      kind: contract.freeform ? "freeform" : "function",
      ...(!contract.freeform
        ? { inputSchema: jsonSchema(contract.schema) }
        : {}),
      ...(contract.output ? { outputSchema: contract.output } : {}),
    };
    definitions.set(contract, value);
  }
  return value;
}
/** Validates nested tool input against its contract before any side effect. */
export function parseNativeInput<S extends z.ZodType>(
  contract: NativeContract<S>,
  raw: unknown,
): z.output<S> {
  const parsed = contract.schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new Error(nativeInputError(contract, parsed.error.issues));
}
/**
 * Names each wrong field with what was expected, so the next call can be fixed.
 * zod messages describe types, allowed values and unknown key names; they do
 * not repeat input values.
 */
function nativeInputError(
  contract: NativeContract,
  issues: readonly z.core.$ZodIssue[],
): string {
  const problems = issues.map((issue) => {
    const field = fieldPath(issue.path);
    if (
      issue.code === "invalid_type" &&
      issue.message.endsWith("received undefined")
    )
      return `${field}: required field is missing (expected ${issue.expected})`;
    if (issue.code === "unrecognized_keys") {
      const allowed = allowedFields(jsonSchema(contract.schema), issue.path);
      return `${field}: ${issue.message}${allowed.length > 0 ? `. Allowed fields: ${allowed.join(", ")}` : ""}`;
    }
    return `${field}: ${issue.message}`;
  });
  const shape = contract.freeform
    ? ` Pass the complete patch text as one string: await tools.${contract.name}(patch).`
    : "";
  return `tools.${contract.name} did not run because its input is invalid. ${problems.join("; ")}.${shape}`;
}
function fieldPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "input";
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}
/** Property names of the object schema at path, read from the JSON Schema. */
function allowedFields(
  schema: Record<string, unknown>,
  path: readonly PropertyKey[],
): string[] {
  let node: unknown = schema;
  for (const segment of path) {
    const current = node as Record<string, unknown> | undefined;
    node =
      typeof segment === "number"
        ? current?.items
        : (current?.properties as Record<string, unknown> | undefined)?.[
            String(segment)
          ];
  }
  const properties = (node as { properties?: Record<string, unknown> })
    ?.properties;
  return properties === undefined ? [] : Object.keys(properties);
}
/** Contracts by name for one instance; exec_command describes the resolved shell. */
export function nativeContractsByName(shell: CommandShell): NativeContracts {
  return {
    ...NATIVE_CONTRACTS,
    exec_command: {
      ...NATIVE_CONTRACTS.exec_command,
      description:
        NATIVE_CONTRACTS.exec_command.description +
        "\n" +
        shellDescription(shell),
    },
  };
}
/** Contracts in catalog order. */
export function nativeContracts(
  shell: CommandShell,
): readonly NativeContract[] {
  return Object.values(nativeContractsByName(shell));
}

export function execDescription(
  contracts: readonly NativeContract[],
  idleHours = SESSION_IDLE_MS / 3_600_000,
): string {
  return `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module on this connection's specific remote machine.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`. Tool names are exposed as normalized JavaScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`. Independent calls can run concurrently with Promise.all.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Only the orchestration JS isolate lacks Node.js, filesystem, network, console and module imports. Tools access the remote machine's filesystem and network; separate ChatGPT containers do not share that environment.
- The MCP argument is an object whose source field contains JavaScript. workdir supplies the local tools' default directory. A shell's cd affects only that process.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}\`.
- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running. Defaults to ${DEFAULT_EXEC_YIELD_TIME_MS} ms.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results, subject to the final response limit below.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool image, pass an individual \`ImageContent\` block from \`result.content\`, for example \`image(result.content[0])\`. MCP image blocks may request detail with \`_meta: { "codex/imageDetail": "original" }\`. When provided, the second \`detail\` argument overrides any detail embedded in the first argument.
- \`audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)\`: Appends an audio item. \`audio_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool audio block, pass an individual \`AudioContent\` block from \`result.content\`, for example \`audio(result.content[0])\`.
- \`generatedImage(result: { image_url: string; output_hint?: string })\`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same ChatGPT conversation; requires a host-provided conversation ID.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`yield_control()\`: yields the accumulated output to the model immediately while the script keeps running.
- as_settled(promises): Async iterator yielding {index, status: "fulfilled", value} or {index, status: "rejected", reason} in settlement order. Accepts an iterable or Map; index is the input position or Map key. Breaking iteration does not cancel inputs.
- stream_settled(promises, emit): Awaits emit(result) sequentially for each settlement. Neither settlement helper outputs or yields by itself; output helpers and yield_control control delivery.

## Host calling conventions
- Work independently; do not invoke other agent CLIs on this machine (e.g. Codex or Claude Code) unless the user explicitly requests it.
- For destructive deletion commands (e.g. rm or rm -rf), use only explicit, fully resolved absolute path literals. Do not use shell variables, command substitution, wildcards, dynamic path concatenation or other path interpolation. Before deleting, verify that the final target paths and scope exactly match the intended deletion.
- Explicit MCP arguments take precedence over the first-line pragma. Nested JS, shell and other languages each interpret quoting, interpolation, escapes, argument boundaries and whitespace.
- load returns a copy. Cells read a starting snapshot and merge store writes when they finish, including on script error; concurrent same-key writes are not transactional. Changes to a loaded copy require another store. Storage may be cleared after ${idleHours} idle hours, memory recovery or restart.

## Tool discovery
Within this connector's exec source, ALL_TOOLS lists all enabled local and downstream tools as {name, description} entries with full declarations; tools already contains their callable methods. These globals are separate from any outer host's tool catalog and tools object, regardless of the connector's name in ChatGPT. Local contracts are included below.
Some deferred nested tools may be omitted from this description. They are still available on the global \`tools\` object and listed in \`ALL_TOOLS\`.
To find one, filter \`ALL_TOOLS\` by \`name\` and \`description\`: text(ALL_TOOLS.filter(t => /keyword/i.test(t.name + " " + t.description))). A known name and argument shape can be called directly with await tools[name](args).
Tool availability can change between calls. list_skills provides local skill metadata; a selected SKILL.md provides the full workflow.

## Results and execution
Tool return values reach the model through explicit text/image/audio/generatedImage calls; exported resource links are attached automatically. Local methods return the values in their contracts. Downstream MCP methods return CallToolResult: {content, structuredContent?, isError?}; isError indicates failure. structuredContent holds structured data; content may add distinct text, media or resources. A nested call that fails rejects with its error message as a string; use String(error) in catch blocks.
An outer host may wrap exec/wait results in its own shape; the nested return types above describe values inside source.
Final response text is limited to ${bytes(MODEL_TEXT_BYTES)} UTF-8 bytes, retaining the beginning and end on overflow. Omitted text is not returned by later waits. Nested results and store are not pre-truncated by this limit, so JS can filter or retain them before output. max_output_tokens narrows this response's text budget; wait.max_tokens is separate. Media and execution status are preserved. With user notes attached, the combined response text ceiling is ${bytes(NOTES_RESPONSE_BYTES)} UTF-8 bytes.
exec waits ${DEFAULT_EXEC_YIELD_TIME_MS} ms by default, at most ${MAX_EXEC_YIELD_TIME_MS}. A still-running script returns Script running and cell_id; wait returns new output or the final result for that cell. Script completed means JavaScript finished, not that every command succeeded.
cell_id identifies a script. session_id identifies a terminal that remains usable across exec calls through tools.write_stdin. A nested terminal collection may span several outer exec/wait calls. wait({cell_id, terminate:true}) stops the cell and requests cancellation of pending calls; terminals already returned with session_id remain independent. Failures and cancellation do not undo side effects.
New Web user notes or answers can yield an in-flight exec/wait early. The cell and nested calls continue; wait collects their later output.

Shared MCP Types:
\`\`\`ts
${MCP_TYPESCRIPT_PREAMBLE}
\`\`\`

## Local tools
${contracts.map((contract) => `### ${contract.name}\n${describeContract(contract)}`).join("\n\n")}`;
}
function waitDefault(defaultMs: number, maxMs: number): string {
  return defaultMs === maxMs
    ? `${defaultMs} ms (also the maximum)`
    : `${defaultMs} ms, at most ${maxMs}`;
}
const WAIT_DEFAULT = waitDefault(
  DEFAULT_WAIT_YIELD_TIME_MS,
  MAX_WAIT_YIELD_TIME_MS,
);
export const WAIT_DESCRIPTION = `Waits on a yielded exec cell and returns new output or completion.
- Use wait only after exec returns Script running with cell ID.
- cell_id identifies the running exec cell to resume.
- yield_time_ms controls how long to wait for more output before yielding again. Defaults to ${WAIT_DEFAULT}.
- max_tokens limits how much new output this wait call returns, subject to the final response limit.
- terminate: true stops the running cell; false or omitted waits for output.
- wait returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, wait may yield again with the same cell_id.
- If the cell has already finished, wait returns the completed result and closes the cell.
- Completion, yield_control or new Web user input can return sooner. Early yields leave the cell and nested calls running. Cancelling this wait only cancels observation.
- max_tokens limits this response independently of exec. Final text remains bounded to ${bytes(MODEL_TEXT_BYTES)} UTF-8 bytes, or ${bytes(NOTES_RESPONSE_BYTES)} with user notes; media and status are preserved. Terminal session_id handles are used with tools.write_stdin inside exec.`;
