// Adapted from OpenAI Codex rust-v0.164.0 (Apache-2.0),
// code-mode-protocol/src/json_schema_types.rs and description.rs; see proto/LICENSE.

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);

/** Codex's display types complement, rather than replace, JSON Schema validation. */
export function schemaType(root: unknown): string {
  const active = new Map<string, number>();
  let remainingRefs = 32;
  let remainingBytes = 64_000;
  function render(schema: unknown, nestedResource = false): string {
    if (remainingBytes <= 0) return "unknown";
    const result = renderValue(schema, nestedResource);
    remainingBytes -= Buffer.byteLength(result);
    return remainingBytes < 0 ? "unknown" : result;
  }
  function renderValue(schema: unknown, nestedResource: boolean): string {
    if (schema === false) return "never";
    if (!object(schema)) return "unknown";
    nestedResource ||= schema !== root && "$id" in schema;
    if (typeof schema.$ref === "string") {
      let referenced = "unknown";
      const ref = schema.$ref;
      const count = active.get(ref) ?? 0;
      if (
        !nestedResource &&
        count < 2 &&
        remainingRefs > 0 &&
        (ref === "#" || ref.startsWith("#/"))
      ) {
        let target: unknown = root;
        try {
          for (const key of decodeURIComponent(ref.slice(2)).split("/")) {
            if (ref === "#") break;
            target =
              object(target) || Array.isArray(target)
                ? (target as Schema)[
                    key.replace(/~1/g, "/").replace(/~0/g, "~")
                  ]
                : undefined;
          }
          remainingRefs--;
          active.set(ref, count + 1);
          referenced = render(target);
          active.set(ref, count);
        } catch {
          // Unsupported URI fragments retain the upstream unknown fallback.
        }
      }
      const {
        $ref: _ref,
        $defs: _defs,
        definitions: _definitions,
        ...siblings
      } = schema;
      const sibling = render(siblings, nestedResource);
      return sibling === "unknown"
        ? referenced
        : referenced === "unknown"
          ? sibling
          : `(${referenced}) & (${sibling})`;
    }
    if ("const" in schema) return JSON.stringify(schema.const);
    if (Array.isArray(schema.enum) && schema.enum.length)
      return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const variants = schema[key];
      if (Array.isArray(variants) && variants.length) {
        const types = variants.map((value) => render(value, nestedResource));
        return key === "allOf"
          ? types
              .map((value) => (value.includes(" | ") ? `(${value})` : value))
              .join(" & ")
          : types.join(" | ");
      }
    }
    const typed = (type: unknown): string => {
      switch (type) {
        case "string":
        case "boolean":
        case "null":
          return type;
        case "integer":
        case "number":
          return "number";
        case "array": {
          if (Array.isArray(schema.items))
            return `[${schema.items.map((value) => render(value, nestedResource)).join(", ")}]`;
          if (schema.items !== undefined)
            return `Array<${render(schema.items, nestedResource)}>`;
          if (Array.isArray(schema.prefixItems))
            return `[${schema.prefixItems.map((value) => render(value, nestedResource)).join(", ")}]`;
          return "unknown[]";
        }
        case "object": {
          const properties = object(schema.properties) ? schema.properties : {};
          const required = new Set(
            Array.isArray(schema.required) ? schema.required : [],
          );
          const lines: string[] = [];
          for (const [key, value] of Object.entries(properties).sort(
            ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
          )) {
            if (remainingBytes <= 0) return "unknown";
            if (object(value) && typeof value.description === "string")
              lines.push(
                ...value.description
                  .split(/[\r\n\u2028\u2029]/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => `// ${line}`),
              );
            lines.push(
              `${identifier(key)}${required.has(key) ? "" : "?"}: ${render(value, nestedResource)};`,
            );
          }
          if (
            schema.additionalProperties !== false &&
            (schema.additionalProperties !== undefined || !lines.length)
          )
            lines.push(
              `[key: string]: ${render(schema.additionalProperties, nestedResource)};`,
            );
          if (!lines.length) return "{}";
          return Object.values(properties).some(
            (value) =>
              object(value) &&
              typeof value.description === "string" &&
              value.description.trim(),
          )
            ? `{\n${lines.map((line) => `  ${line}`).join("\n")}\n}`
            : `{ ${lines.join(" ")} }`;
        }
        default:
          return "unknown";
      }
    };
    if (Array.isArray(schema.type)) return schema.type.map(typed).join(" | ");
    if (schema.type !== undefined) return typed(schema.type);
    if (
      "properties" in schema ||
      "additionalProperties" in schema ||
      "required" in schema
    )
      return typed("object");
    if ("items" in schema || "prefixItems" in schema) return typed("array");
    return "unknown";
  }
  const result = render(root);
  return Buffer.byteLength(result) > 16_000 ? "unknown" : result;
}

export function toolDeclaration(
  name: string,
  input: string,
  output: string,
  inputName = "args",
): string {
  return `exec tool declaration:\n\`\`\`ts\ndeclare const tools: { ${identifier(name)}(${inputName}: ${input}): Promise<${output}>; };\n\`\`\``;
}

export const MCP_TYPESCRIPT_PREAMBLE = `type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};`;
