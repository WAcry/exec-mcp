# ADR-010 Web conversation notes and asynchronous questions

English | [简体中文](010-session-notes.zh.md)

Active, updated 2026-09-22.

## Conversation ownership and delivery

Operators can send text from Web conversation groups or answer questions submitted by the agent.
Both use the User Note queue and attach to the same conversation's next naturally returning tool response.
The model has only tools.request_user_input_async inside exec for asking questions. It has no answer-query, send-user-note, or conversation-naming tool.
The service does not wait synchronously for a person and adds no acknowledgment parameters or question database.

Conversation names default to hashes. Operators may add labels for Web identification only.
Ownership uses the SHA-256 digest of `_meta["openai/session"]`, independently of MCP connections, native sessions, cells, terminals, and working directories.
Actual calls carrying that identifier establish recipients. Unidentified groups cannot receive messages.

Successful, running, and ordinary execution-error responses from exec/wait can all carry notes.
Nested tool values remain unchanged. MCP tools/list, resources/read, and Web reads do not consume messages.
Messages are selected at return time, so a note submitted during a wait can accompany that response.
Notes do not wake waits or modify running scripts. Stopping an operation still requires its termination method.

## Asynchronous questions and answers

The design follows [request_user_input_async](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/request_user_input_async.rs)
in pinned Codex rust-v0.155.1, retaining questions/title/options string arrays and the accepted response shape.
await waits for submission only, allowing the agent to continue other work. Codex can inject a new user message;
exec-mcp returns the answer through a subsequent ordinary tool response.

Every question offers several options. The first is marked recommended but is neither preselected nor submitted automatically.
The UI adds a custom-answer choice. Every choice allows a note, and custom answers require text.
Questions are grouped by conversation hash and display the operator's label. The global prompt navigates to conversation groups;
the side panel separates questions and note history, puts unanswered questions first, and paginates older records.

Questions can be answered individually. If two pages answer concurrently, the first saved response wins and the other page keeps its draft.
The same submission ID deduplicates an uncertain retry. Pending answers can be withdrawn and replaced; an attached answer is corrected through a subsequent note.
Optional request_key deduplicates identical requests within a conversation and rejects changed content under the same key.
The service assigns question and option identity; the agent does not need to supply it.

The browser submits the option index and note only. The stored record supplies the original question and choices.
A successful answer synchronously updates the question and enters the FIFO. Capacity or validation failure leaves the question pending and the draft intact.
The message contains the question, actual selection, and note. Unselected choices, request IDs, and audit timestamps are omitted from model delivery.
Answers and unsolicited notes queue by submission time. Unanswered questions occupy no position in that queue.

Question submission requires a listening Web server and host conversation identity; missing prerequisites fail explicitly.
Questions and answers use bounded instance memory without modifying the native host or resuming tasks automatically.
Before accepting an answer, validate the encoded question, selection, and note together so the complete reply can fit into a note.

## Browser notifications

After a new request is saved, the Web SSE event includes its request ID and question count. The browser uses native Notification for a system alert.
The event omits question and answer text. Repeated request_key submissions, answers, withdrawals, labels, and ordinary notes do not trigger new alerts.
Clicking a notification focuses the page and opens the conversation's questions tab. Notifications contain only a short hash and count;
full questions and labels stay in the authenticated page.

Permission is requested when the operator enables notifications. Existing permission can be used directly, and notifications can be paused or tested.
Browser denial, an insecure context, unsupported mobile behavior, or OS notification settings do not prevent questions and answers.
Web manages permission without changing tool schemas. Notification delivery does not prove that a person or model has read the content.

One multi-question request produces one alert. Same-origin pages use Web Locks and bounded local ID history to deduplicate it.
Without locks or storage, fall back to page-local deduplication and native tags; multiple tabs may then notify twice.
Local preferences and ID history contain no question text, labels, or credentials. Sign-out and page closure dispose notifications and listeners.
Refresh and reconnection do not replay old alerts. Missed questions remain in the pending list.

There is no service worker, Web Push, or periodic question polling. Closed pages and disconnected event streams cannot produce alerts.
Desktop notifications and mobile Web answering are separate capabilities; some mobile browsers cannot issue this type of notification.
See [browser notification permission, clicks, and lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)
and [Notification constructor support](https://developer.mozilla.org/en-US/docs/Web/API/Notification/Notification).

## Notes share the result channel

When the normal result has structuredContent, attached messages use `{result: originalValue, user_notes: [noteText]}`.
A consumer reading only structured data still receives the notes, while result retains the original tool fields.
Distinct TextContent moves into optional result_content with block metadata preserved. Only proven duplicate JSON mirrors are removed.
Images, audio, and native resources remain in content. isError and other metadata remain unchanged.

Without structuredContent, append the protocol marker `用户额外补充：` and body to content.
With no attachable messages, keep the original response shape. Nested tool values are never affected by wrapping.
Native exec/wait results currently use content, so ordinary delivery stays textual without creating a structured duplicate.

Official documentation treats content and structuredContent as model-visible. Using one channel reduces the risk of a consumer missing notes by reading only one field.
Whether the model understands and acts on a note still requires observing later behavior. Messages follow array or content-block order;
sequence numbers, IDs, times, and labels remain in the internal queue and Web audit only.

## Output capacity and delivery state

Ordinary results are limited to 36,000 UTF-8 bytes, with a combined 37,000-byte ceiling when notes are attached.
Count the actual wrapping, escapes, separators, and text headers, then append complete messages in FIFO order.
Do not shorten normal output for a note or split the note. If the head does not fit, the entire queue waits for a later response.
Long messages may stay queued indefinitely; this is an accepted cost of simple handling.

These values are conservative service budgets, and host token limits may change. Native media and file blocks are retained,
with the final encoded payload checked separately. Selection, validation, and marking attachment happen synchronously to prevent duplicate consumption by concurrent responses.
A batch is ordered; network arrival order across separate responses cannot be guaranteed.

Cancellation or encoding failure before attachment keeps messages pending. After attachment, do not redeliver or require model acknowledgment.
The UI's Attached to a tool response status records server handling only. If the connector loses that response, the user can copy and resend it.
There is no acknowledgment protocol for these low-frequency notes.

## Retention and Web permissions

Questions, notes, and labels use separate bounded instance memory and survive audit eviction, clearing history, and native-host reclamation.
Restarting the execution service reuses them; stopping the whole process loses them. Records older than 72 hours are cleaned up on access, within an approximately 16 MiB accounting budget.
Insufficient capacity rejects new submissions without overwriting pending messages. Bodies allow at most 30,000 UTF-8 bytes.
Changed content creates a new message, and only pending messages may be withdrawn.

Recipients are observed while Web is listening. After Web closes, existing messages may still accompany later calls from their original conversations.
APIs retain same-origin authentication and the write-request marker. SSE sends only change notifications and conversation summaries.
Drafts are isolated by recipient and cleared only after successful submission. Labels and bodies render as plain text.
This channel trusts one operator. Same-account processes may also access the Web API, so answer records cannot prove human authorization.

See [OpenAI conversation metadata and visible tool results](https://developers.openai.com/plugins/reference)
and [MCP content blocks](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
