import { errorMessage } from "../util.js";
import type { ProtoMessage } from "./protocol.js";
import type {
  CodeModeOutputItem,
  CodeModeToolDefinition,
  CodeModeToolName,
} from "./types.js";

/** Encoding and validation of Code Mode host messages. No session state. */

const MAX_IDENTIFIER_BYTES = 256;

export type RuntimeOutcome =
  | { cellId: string; items: CodeModeOutputItem[]; state: "yielded" }
  | { cellId: string; items: CodeModeOutputItem[]; state: "terminated" }
  | {
      cellId: string;
      errorText?: string;
      items: CodeModeOutputItem[];
      state: "completed";
    };

export function toolMap(
  tools: readonly CodeModeToolDefinition[],
): Map<string, CodeModeToolDefinition> {
  const result = new Map<string, CodeModeToolDefinition>();
  for (const tool of tools) {
    const name = tool.toolName ?? { name: tool.name };
    const key = toolKey(name);
    if (result.has(key))
      throw new Error(`duplicate Code Mode tool route ${key}`);
    result.set(key, tool);
  }
  return result;
}

export function encodeToolDefinition(
  tool: CodeModeToolDefinition,
): ProtoMessage {
  const toolName = tool.toolName ?? { name: tool.name };
  const result: ProtoMessage = {
    name: tool.name,
    toolName: {
      name: toolName.name,
      ...(toolName.namespace === undefined
        ? {}
        : { namespace: toolName.namespace }),
    },
    description: tool.description,
    kind:
      tool.kind === "freeform" ? "TOOL_KIND_FREEFORM" : "TOOL_KIND_FUNCTION",
  };
  if (tool.inputSchema !== undefined) {
    result.inputSchemaJson = Buffer.from(
      JSON.stringify(tool.inputSchema),
      "utf8",
    );
  }
  if (tool.outputSchema !== undefined) {
    result.outputSchemaJson = Buffer.from(
      JSON.stringify(tool.outputSchema),
      "utf8",
    );
  }
  return result;
}

export function decodeWaitResponse(
  response: ProtoMessage,
  expectedCellId: string,
): RuntimeOutcome {
  const state = response.state;
  if (state !== "liveCell" && state !== "missingCell") {
    throw new Error("host returned an empty wait response");
  }
  const outcome = decodeOutcome(recordField(response, state, "wait outcome"));
  if (outcome.cellId !== expectedCellId) {
    throw new Error(
      `host returned cell ${outcome.cellId} instead of ${expectedCellId}`,
    );
  }
  return outcome;
}

export function decodeOutcome(value: ProtoMessage): RuntimeOutcome {
  const cellId = stringField(value, "cellId", "cell ID");
  const rawItems = value.contentItems;
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new Error("host returned invalid content items");
  }
  const items = (rawItems ?? []).map((item) =>
    decodeOutputItem(asRecord(item, "content item")),
  );
  if (value.outcome === "yielded") return { cellId, items, state: "yielded" };
  if (value.outcome === "terminated")
    return { cellId, items, state: "terminated" };
  if (value.outcome === "completed") {
    const completed = recordField(value, "completed", "completed outcome");
    const errorText = optionalStringField(
      completed,
      "errorText",
      "script error",
    );
    return {
      cellId,
      ...(errorText === undefined ? {} : { errorText }),
      items,
      state: "completed",
    };
  }
  throw new Error("host returned an execution without an outcome");
}

function decodeOutputItem(value: ProtoMessage): CodeModeOutputItem {
  if (value.item === "text") {
    return {
      type: "text",
      text: stringField(
        recordField(value, "text", "text content"),
        "text",
        "text",
      ),
    };
  }
  if (value.item === "image") {
    const image = recordField(value, "image", "image content");
    const detail = decodeImageDetail(image.detail);
    return {
      type: "image",
      imageUrl: stringField(image, "imageUrl", "image URL"),
      ...(detail === undefined ? {} : { detail }),
    };
  }
  if (value.item === "audio") {
    return {
      type: "audio",
      audioUrl: stringField(
        recordField(value, "audio", "audio content"),
        "audioUrl",
        "audio URL",
      ),
    };
  }
  throw new Error("host returned an empty content item");
}

function decodeImageDetail(
  value: unknown,
): "auto" | "low" | "high" | "original" | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case "IMAGE_DETAIL_AUTO":
      return "auto";
    case "IMAGE_DETAIL_LOW":
      return "low";
    case "IMAGE_DETAIL_HIGH":
      return "high";
    case "IMAGE_DETAIL_ORIGINAL":
      return "original";
    default:
      throw new Error(`host returned invalid image detail ${String(value)}`);
  }
}

export function decodeToolName(value: ProtoMessage): CodeModeToolName {
  const name = stringField(value, "name", "tool name");
  const namespace = optionalStringField(value, "namespace", "tool namespace");
  return { name, ...(namespace === undefined ? {} : { namespace }) };
}

export function decodeOptionalJson(value: unknown, field: string): unknown {
  if (value === undefined) return undefined;
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`host returned invalid ${field}`);
  }
  try {
    return JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`host returned invalid ${field}: ${errorMessage(error)}`);
  }
}

export function toolKey(name: CodeModeToolName): string {
  return name.namespace === undefined
    ? name.name
    : `${name.namespace}/${name.name}`;
}

export function validateIdentifier(value: string, field: string): void {
  if (value === "") throw new Error(`host returned an empty ${field}`);
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `host returned ${field} exceeding ${MAX_IDENTIFIER_BYTES} bytes`,
    );
  }
}

export function recordField(
  value: ProtoMessage,
  key: string,
  field: string,
): ProtoMessage {
  return asRecord(value[key], field);
}

function asRecord(value: unknown, field: string): ProtoMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`host returned invalid ${field}`);
  }
  return value as ProtoMessage;
}

export function stringField(
  value: ProtoMessage,
  key: string,
  field: string,
): string {
  const result = value[key];
  if (typeof result !== "string")
    throw new Error(`host returned invalid ${field}`);
  return result;
}

export function optionalStringField(
  value: ProtoMessage,
  key: string,
  field: string,
): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string")
    throw new Error(`host returned invalid ${field}`);
  return result;
}

export function numberField(
  value: ProtoMessage,
  key: string,
  field: string,
): number {
  const result = value[key];
  if (!Number.isSafeInteger(result) || Number(result) < 0) {
    throw new Error(`host returned invalid ${field}`);
  }
  return Number(result);
}
