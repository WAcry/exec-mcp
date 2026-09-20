/** Lightweight shared names for the MCP boundary and Web audit filters. */
export const NATIVE_TOOL_TITLES = {
  list_skills: "列出 Skills",
  import_file: "导入文件",
  export_file: "导出文件",
  exec_command: "执行命令",
  write_stdin: "操作终端",
  apply_patch: "应用补丁",
  view_image: "查看图片",
  tool_search: "搜索工具",
} as const;
export type NativeToolName = keyof typeof NATIVE_TOOL_TITLES;
export const TOP_LEVEL_TOOL_NAMES = [
  "exec",
  "wait",
  ...Object.keys(NATIVE_TOOL_TITLES),
];

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
