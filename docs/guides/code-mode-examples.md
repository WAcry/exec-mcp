# Code Mode examples

English | [简体中文](code-mode-examples.zh.md)

These snippets are JavaScript for `exec.source`. Shell code belongs in `tools.exec_command({cmd})`.
Calls operate on the exec-mcp machine, which shares no files, processes, or network environment with separate containers.
Use examples as needed; tool descriptions define complete parameter and return contracts.

## Filter output in code

Final text returned to the model is capped at 36,000 UTF-8 bytes for the target host's output capacity. Token count still depends on the model.
Nested tools return their values first; the script chooses what to display through text.

```js
const result = await tools.exec_command({ cmd: "git status --short" });
text(result);
```

For larger logs, save the result, find errors, and output a summary.

```js
const result = await tools.exec_command({ cmd: "your-build-command" });
store("build-result", result);
text({
  exit_code: result.exit_code,
  session_id: result.session_id,
  truncated: result.truncated ?? false,
  stderr_bytes: result.stderr_bytes,
  matches: result.output.split(/\r?\n/).filter(line => /error|failed|exception/i.test(line)).slice(0, 40),
  tail: result.output.slice(-4000)
});
```

Later calls can retrieve sections through `load("build-result")`. Store is temporary memory associated with the current ChatGPT conversation.
The output guard retains only the final text's head and tail; wait does not recover omissions. Save data before the script ends if it will be reused.
Terminals return up to 4 MiB per read. Use write_stdin with the same session_id to collect more; each process defaults to a 16 MiB buffer.
Buffer overflow drops middle logs and returns truncated/omitted_bytes. Finding no error in retained output does not establish that the whole run was error-free.
Explicitly redirect to a file when complete logs are needed. The service does not automatically persist all tool results.

## Terminal collection and outer waits

With chars omitted or empty, `tools.write_stdin` collects unread output without writing and defaults to 5 seconds. Nonempty input defaults to 250 ms.
Both return at process exit or window expiry. Existing and new logs do not end the window early.
The respective nonzero ranges are 5000 to 300000 ms and 250 to 30000 ms; explicit `0` reads immediately.
Timeout does not terminate the process. Continue using session_id when it is returned.

A long task can wait longer inside one exec and filter the result before returning it.

```js
const result = await tools.write_stdin({ session_id: "之前的句柄", yield_time_ms: 300000 });
text(result);
```

exec may first return cell_id for continuation through outer wait. A terminal collection is not cut short by the outer 110-second window,
and an outer timeout does not restart or replay the nested call. Continue collecting from the handle instead of rerunning the original command.
Waiting does not enlarge log or model-output budgets. An exited process with more unread output than one read can hold also needs further reads.

## Interpret script and command results

`Script completed` means JavaScript ended. A nested command can still return `exit_code: 1`.
exit_code is the shell's exit code. For pipes, stderr_bytes counts cumulative received stderr, including bytes later dropped from the rolling buffer.
Stderr may contain progress or warnings. PTYs merge streams and have no separate stderr count.

This PowerShell command writes an error followed by a success message.

```js
text(await tools.exec_command({
  cmd: "Write-Error 'expected diagnostic'; Write-Output 'later success'"
}));
```

It may return `exit_code: 0` while retaining the error text and stderr_bytes.
Callers that need PowerShell to stop on an error can set an explicit policy.

```js
text(await tools.exec_command({
  cmd: "$ErrorActionPreference='Stop'; Write-Error 'stop here'; Write-Output 'should-not-run'"
}));
```

The service does not alter error policy automatically. Return a native program's exit code explicitly with `exit $LASTEXITCODE` when needed.

## Inspect downstream tools inside exec

The connection can have any name in ChatGPT. Run the discovery and invocation code below in the source argument of that connection's exec.
A host-side exec, when present, has its own tool catalog; discovering the connector there does not list the machine's downstream tools.

ALL_TOOLS is a `{name, description}[]` array. Each description includes full input and return contracts, and names match bindings on tools.
Filter by name or description and print matches, or print names only to narrow the selection.

```js
text(ALL_TOOLS.filter(t => /github|pull_request/i.test(t.name + " " + t.description)));
```

After reading an entry, call its exact name with `await tools[name](args)`. Known names and arguments need no prior discovery.
This is the bound snapshot for the current exec. Filtering does not connect to or execute a downstream and does not automatically add the catalog to model context.

Inside source, downstream methods return MCP CallToolResult values. When an outer host wraps exec/wait output,
code forwarding that output uses the host's actual return shape, which can differ from the nested method's result.

## MCP resources

Resources are data exposed by downstream services, such as document text, database schemas, or parameterized context. ALL_TOOLS lists callable methods.
Three resource helpers are available inside exec. A known URI can be read directly, or resources can be listed first.

```js
const result = await tools.list_mcp_resources({});
text(result);
```

Each entry includes server. These examples assume a configured docs server. Specifying a server returns one page;
pass nextCursor back unchanged to the same server and list method for the next page.

```js
const page = await tools.list_mcp_resources({ server: "docs" });
text(page);
```

Read a URI returned by a list or tool. Resource entries are in contents.
MCP tool results use the distinct content field; follow the structure of the result being read.

```js
const result = await tools.read_mcp_resource({
  server: "docs",
  uri: "memo://project/readme"
});
for (const item of result.contents) {
  if (item.text !== undefined) text(item.text);
}
```

`list_mcp_resource_templates({ server: "docs" })` returns uriTemplate. Expand its parameters into a concrete URI and read it with read_mcp_resource.
A server with an empty resource list may still expose templates or links in tool results.
The specified downstream resolves each URI; it is not read as a local path or arbitrary network address.
A binary entry's blob is Base64. A known image can be explicitly displayed through `image("data:" + item.mimeType + ";base64," + item.blob)`.
Filter or store large resources in JS. Nested transport limits and the final model budget still apply, without automatic disk spill.

## Build multiline patches containing Markdown inside exec

`tools.apply_patch(patch)` accepts a complete patch string, which the service sends to the patch engine through stdin.
This call does not pass through a shell, regardless of the JavaScript string construction, so it needs no heredoc wrapper.

```text
JS source → patch string → tools.apply_patch(patch) → stdin → patch engine
```

Quoted strings, template literals, and String.raw can all construct a patch. Choose according to the content; file type and patch size do not prescribe a method.

| Construction | Syntax to consider |
| --- | --- |
| Quoted strings, optionally collected into an array and joined with `.join("\n")` | Backticks and template placeholders are plain text; the quote delimiter and backslashes still follow JS escape rules. |
| Template literals | Allow real newlines. Backticks, interpolation, and backslashes have JS meaning; indentation is retained. |
| String.raw templates | Preserve backslashes in literal segments but still parse delimiters and interpolation; escape backslashes added for those can also reach the patch. |

This example uses an array of lines for a patch containing Markdown fences. JS joins the array before calling the tool.

```js
const patch = [
  "*** Begin Patch",
  "*** Add File: patch-example.md",
  "+# Review notes",
  "+Use `review` mode.",
  "+```console",
  "+uv run demo.py",
  "+```",
  "+Literal placeholder: ${name}",
  "+Windows path: C:\\work\\new\\file.txt",
  "+Regex: Sig\\[\\d+\\]",
  "+Literal escape: \\uXXXX",
  "+Quotes: \"double\" and 'single'.",
  "+\tTabbed",
  "+    indented",
  "+",
  "*** End Patch",
  "",
].join("\n");
text(await tools.apply_patch(patch));
```

`.join("\n")` inserts real LF characters; `.join("\\n")` inserts a literal backslash and n.
An ordinary template can also express a multiline body directly.

```js
const patch = `*** Begin Patch
*** Add File: template-example.md
+# Notes
+Keep the existing interface.
*** End Patch
`;
text(await tools.apply_patch(patch));
```

The same approaches work for updates and multi-file patches. Use real newlines, begin with `*** Begin Patch`,
keep patch markers at column zero, and retain the intended indentation, tabs, and trailing whitespace after each added line's +.

Pass an existing patch string directly to the tool. When generating JavaScript source, JSON.stringify can encode an existing string,
provided the correct text value already exists. Shell quoting, here-strings, and other languages' comments take effect only in their own parser.
The service receives the constructed patch without additional escaping or guessed repairs.
See [template literals](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-template-literals),
[String.raw](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.raw), and
[Array.prototype.join](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.join).

## Windows paths, regexes, and multiline scripts

Ordinary JavaScript strings interpret backslashes first. String.raw can preserve that layer's backslashes in a multiline shell script;
PowerShell still applies its own quoting and regex rules. The MCP source field is a string, with JSON encoding handled by the client.

```js
const cmd = String.raw`
$literalPath = 'C:\Windows\System32'
$pattern = 'Sig\['
$matched = 'Sig[42]' | Select-String -Pattern $pattern
[pscustomobject]@{ path = $literalPath; pattern = $pattern; matched = [bool]$matched } | ConvertTo-Json -Compress
`;
text(await tools.exec_command({ cmd }));
```

Backticks and interpolation inside String.raw still follow JavaScript syntax.
A complex script can also be created as a file through apply_patch and then executed, reducing nested language parsing.

When PowerShell objects with different fields are output consecutively, default table formatting may show only the first object's columns.
Serialize each object to JSON separately when its fields need to be read programmatically.

```js
text(await tools.exec_command({ cmd: String.raw`
[pscustomobject]@{ Id = 42 } | ConvertTo-Json -Compress
[pscustomobject]@{ OS = 'Windows'; Arch = 'x64' } | ConvertTo-Json -Compress
` }));
```

## Syntax diagnostics and retries

After the native host reports SyntaxError, the service parses the received source for diagnostics, including the request ID, source SHA-256,
and line/column plus an excerpt where available. This auxiliary check locates errors; V8 still determines executable syntax, and modified source is not run in advance.
Code Mode's prelude does not change the reported original-source locations. If only the host rejected a complex request and non-execution is confirmed,
inspect it and simplify or split as appropriate. Combining independent operations reduces outer round trips; the task determines the tradeoff.

## Asynchronous questions

```js
text(await tools.request_user_input_async({
  questions: [{
    title: "这个新模块使用哪种存储？",
    options: ["SQLite：本机持久化", "仅内存：重启清空"]
  }]
}));
```

await waits only for successful submission, not for a person to answer. Web must be running, and the host must supply a conversation identifier.
The question, user selection, and note arrive with a normal exec/wait response in the same path as unsolicited notes. There is no answer-polling tool.
After submission, the agent can continue work that does not depend on the answer. Answers do not undo completed operations.
