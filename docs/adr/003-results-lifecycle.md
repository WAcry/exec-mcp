# ADR-003 Results and execution lifecycle

English | [简体中文](003-results-lifecycle.zh.md)

Active, updated 2026-10-23.

## Deduplication and presentation

Keep one copy of structuredContent and its equivalent JSON text. For downstream results, remove text only when it is provably a lossless duplicate.
Preserve distinct explanations, isError, media, resources, and content-block metadata. Host-private top-level _meta does not enter model context.
Comparison preserves differences in large integers, duplicate keys, and numeric representations to avoid deletion caused by lossy parse/stringify operations.
Structured data still requires checking isError, and missing fields remain distinct from valid null, arrays, or scalar values.

Local methods return their values to JS; downstream methods retain CallToolResult. Scripts explicitly output through text/image/audio/generatedImage.
Export links are attached separately under [ADR-005](005-file-transfer.md). Explicit output is sent once, without compatibility mirrors that have no actual consumer.

as_settled and stream_settled use the native host implementation to process Promise outcomes as they settle.
They leave output selection to the script. text records output; yield_control or an observation deadline returns it through exec/wait.
This fits ordinary MCP responses without asynchronous model-message injection or changes to result budgets.

Agents filter large results in Code Mode or store them for later partial reads through load. Persistent content can be explicitly written to files.
The service does not spill generic results automatically, avoiding extra rereading, path resolution, and cleanup steps.
Final responses use a conservative UTF-8 byte limit measured on the target connection, retaining the head and tail with a marker when exceeded.
Later waits do not recover omitted text. Truncation may break JSON syntax, and the host's actual token limit can change.

exec.max_output_tokens and wait.max_tokens narrow their respective response text budgets. Outer arguments override first-line pragmas;
wait does not inherit exec's explicit budget. Token counting is approximate. Status, handles, and media are preserved within the relevant final payload limits.
The outer response budget leaves nested values intact for JS processing. Each tool still applies its own output and transport limits; oversized values can fail before reaching JS.
Oversized inputs fail before an operation, while oversized results may fail afterward and must not trigger automatic replay.

User notes share the normal result's text channel and use only spare capacity. Complete messages that do not fit remain queued;
normal output is not reduced for them. See [ADR-010](010-session-notes.md).
Defaults and settings are in the [configuration guide](../guides/configuration.md#capacity-and-temporary-state); schemas and implementation define exact limits.
Encoded payload size and process memory are checked separately. SDK buffering, concurrent requests, and temporary copies consume additional memory.

## Terminal logs

Each terminal retains its unread head and a rolling tail. Overflow discards the middle and reports its position and byte count.
Byte accounting also bounds very long individual lines. Already-read prefixes are not returned again.
Buffers are bounded at receipt, independently for each session, so a noisy terminal cannot pause another terminal.
exec_command and write_stdin apply max_output_tokens to each collected batch, defaulting to 10,000, with an estimate of four UTF-8 bytes per token.
Each read consumes at most 4 MiB. The budget retains the batch's head and tail; omitted middle text is consumed and cannot return on a later read.
Unread bytes beyond the batch remain available through session_id. This keeps the caller's chosen output size separate from the buffer's memory limit.
Callers explicitly redirect to files when they need complete logs or data. Users manage generated file sizes and disk quotas.

Exited terminals that remain unread can expire. Running processes remain retained.
Two shared limits bound all terminals together: a session count and a total budget for unread output.
When a limit is reached, finished sessions that nobody is reading are released first, oldest first.
If unread output still exceeds the budget, the oldest unread tail of running sessions is dropped, starting with the session that produced the new output,
and the omission is reported like any other. A limit never stops a running process: Codex caps its processes at 64 too,
but stopping a user's process could interrupt work that has side effects. When only running sessions fill a limit,
exec_command fails with an error that names the setting and tells the caller to read or terminate sessions.
OS pipes, PTYs, and in-flight copies use additional memory, so the terminal capacity applies only to logs retained by this service.

## Cells, terminals, and waiting

Each exec creates an independent V8 isolate. A running script is resumed or terminated with cell_id.
After a command returns session_id, the terminal manager owns that process. It remains usable across exec calls and after the outer cell ends.
Handles are valid only during the current run; ingress authentication controls access.
Normal shutdown cleans up owned processes. Files and external operations may survive abnormal exits.

write_stdin follows the pinned Codex collection window. Nonempty input defaults to a short wait; empty input allows a longer collection.
The [upstream collector](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/unified_exec/process_manager.rs)
collects logs until the deadline or process exit. Its window starts after acquiring the terminal and completing writes or resizing.
Queueing and stdin backpressure do not consume that window, and new logs do not reset the deadline. Explicit 0 retains immediate reads.
Longer waits do not increase buffer or output capacity.
After the main shell exits, a short bounded drain collects remaining output and reports its exit code once the retained output is consumed.
Descendants may keep inherited pipes open; they do not keep the terminal observation alive, and this drain does not send them a termination signal.

Nested tools may outlast an outer wait window. exec returns cell_id first, and wait retrieves subsequent output.
Outer wait deliberately defaults to and is capped at 110 seconds. Long observations reduce repeated ChatGPT round trips and token use,
while leaving transport margin under the engineering assumption that the target connector timeout is at least 120 seconds.
Completion, an explicit yield, or termination returns sooner; new user input can also end an observation early under [ADR-010](010-session-notes.md).
There is no standalone sleep tool, background model polling, or persistent task scheduler.

Cancelling one wait stops observation only. Terminating a cell requests cancellation of unfinished nested calls.
Cancelling an exec request terminates its cell. If the host has not yet reported the cell, the cancellation returns at once,
and the service terminates the cell when its ID arrives; tool calls from a cancelled exec do not run.
A completion that loses a race with a cancellation counts as cancelled and does not fail the native session.
Terminals whose session_id has already been returned require explicit termination. Removing an observer detaches its listeners and leaves undelivered output for later collection.
Cancellation, disconnection, host failure, or failed result delivery can leave effective side effects. Reconnection never replays scripts or downstream calls automatically.
Scripts must await promises that need to finish; unawaited work may be discarded. Host message injection through notify is not connected.

A yielded cell keeps its native session in use until wait returns its final result, so its store and memory stay allocated.
A cell that no wait call observes for the idle retention period is terminated and releases its session,
which then follows normal idle retention. A wait in progress counts as observation, including one queued behind another wait.
A later wait for that cell_id returns the reason. Unread output is lost, side effects remain, and terminals it started stay independent.
The alternative, keeping unobserved cells until memory pressure, held conversations past their idle retention without a reader.

## Native store/load

The same ChatGPT conversation reuses a native session that stores serializable data in the host. Ordinary JS variables end with the isolate,
and store data is not automatically persisted. Use the pinned host's synchronous store/load without changing the binary or adding per-key protocols,
small per-conversation quotas, or custom delete/clear/stats methods. Transport limits apply independently.
The pinned version ignores some heap settings, so those fields cannot count as effective memory protection.

Each cell reads a starting snapshot, and load returns a copy. Writes merge when the cell finishes, including writes before a script error.
Terminating an uncommitted cell discards its writes. Concurrent writes to the same key have no transaction guarantee, and store/load is not real-time communication between active cells.
Finishing one cell leaves other cells in the conversation intact. Completed results can still be retrieved by their original cell_id within the idle retention period.

Conversations are grouped by a digest of the host's openai/session value. Connections, turns, and working directories can change without changing that association.
Without an identifier, ordinary execution still works and store/load fails instead of creating global shared storage. The connection layer handles authentication.

## Memory reclamation and recovery

Host conversation identity and native-session generations are separate. After runtime failure or memory reclamation, recovery prepares a new session
and reports that the previous state was lost before executing more source. The recovering exec and calls already queued for the old generation do not run their scripts;
a fresh exec can use the new session. This lets the agent inspect actual state before deciding how to continue, since prior side effects may remain.
Old close callbacks, late results, and leases affect their own generation only. Old cells are neither moved nor replayed.
Normal idle expiry creates a fresh session on the next exec and returns the existing new-session/store-empty notice. Failure markers follow the same idle retention.

Only the owned Code Mode host's approximate RSS/working set is sampled. Users manage browsers, compilers, and other child process trees they start.
Sampling failures produce diagnostics, and stale samples cannot judge a new host. Normally, idle sessions remain after all cells finish.
Above the high-water mark, reclaim by time of entering idle state, in FIFO order, then measure again.
If no idle candidate remains and memory is still high, reclaim the least recently used active session; its cells and store may be lost together.
Stop reclaiming active sessions below the high-water mark. A pass considers only generations present at its start, leaving new instances for the next pass.

If closing fails while memory stays high, or freeing all state leaves it high, the shared host may be restarted.
That affects other native sessions. The service writes the restart and its reason to stderr, and later waits for lost cells return the reclamation message.
An unexpected host exit is also written to stderr with the host's recent stderr output.
If the old host's termination cannot be confirmed, do not start another beside it; later recovery can retry.
Sampling and reclamation lag behind allocation, so bursts may still exhaust memory. Independent terminals are retained, and callers explicitly write persistent data to files.

## Execution status and diagnostics

Script completed records the end of JS; each nested command's result determines its success. Shell exit codes retain native semantics.
Stderr byte counts are supporting evidence only, and PTY merged output has no separate stderr count. Conversation groups show current state;
historical nested-call failures do not mark them permanently unhealthy.

Only after the native host reports SyntaxError does the service parse the received source for a fingerprint and a locatable excerpt.
This auxiliary parse provides diagnostics; it neither gates V8 syntax nor executes altered source.
view_image reads a local image and returns {image_url, detail}; image_url is a data URL, and detail is a host hint. Scripts display it through image(await tools.view_image(...)).
generatedImage outputs an existing data URL and hint. Image generation, URL download, and saving files require the relevant separate capability.
Media follows the pinned host's rules without an additional audio or image filter for text budgets.
