/** Names of nested capabilities; only exec/wait are registered at the MCP boundary. */
export const NATIVE_TOOL_TITLES = {
  list_skills: "列出 Skills",
  import_file: "导入文件",
  export_file: "导出文件",
  exec_command: "执行命令",
  write_stdin: "操作终端",
  apply_patch: "应用补丁",
  view_image: "查看图片",
  request_user_input_async: "异步询问用户",
  list_mcp_resources: "列出 MCP 资源",
  list_mcp_resource_templates: "列出 MCP 资源模板",
  read_mcp_resource: "读取 MCP 资源",
} as const;
export type NativeToolName = keyof typeof NATIVE_TOOL_TITLES;
export const TOP_LEVEL_TOOL_NAMES = ["exec", "wait"];

/** A compact preview, not a second copy of the request's full input. */
export function inputPreview(key: string, value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || (key === "patch" && trimmed === "*** Begin Patch"))
      continue;
    return trimmed.slice(0, 240);
  }
  return "";
}

export function callPreview(
  tool: string,
  args: Record<string, unknown>,
): string {
  if (typeof args.preview === "string") return args.preview;
  if (tool === "request_user_input_async" && Array.isArray(args.questions)) {
    const first = args.questions[0] as { title?: unknown } | undefined;
    if (typeof first?.title === "string")
      return inputPreview("title", first.title);
  }
  for (const key of [
    "source",
    "cmd",
    "patch",
    "query",
    "path",
    "destination",
    "workdir",
  ]) {
    if (typeof args[key] === "string") {
      const preview = inputPreview(key, args[key]);
      if (preview) return preview;
    }
  }
  const id = args.cell_id ?? args.session_id;
  return typeof id === "string" ? `${tool}(${id})` : tool;
}
