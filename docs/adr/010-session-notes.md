# ADR-010 Web conversation notes and asynchronous questions

English | [简体中文](010-session-notes.zh.md)

Active, updated 2026-10-01.

## Conversation ownership and delivery

Operators can send text from a conversation's composer or answer questions submitted by the agent.
Both use the User Note queue and attach to the same conversation's next naturally returning tool response.
Inside exec, the model can inform the operator with tools.send_message_to_user_async, ask with choices through tools.request_user_input_async, and title the conversation once with tools.set_conversation_title. It has no answer-query or send-user-note tool.
The service does not wait synchronously for a person and adds no acknowledgment parameters or question database.

The composer sits at the bottom of every conversation, shaped like a chat input, so first-time operators find it without a separate entry point.
Its hint follows the conversation's state: while ChatGPT is inside a call or was active moments ago, the message should arrive with the next response;
when it is idle, the hint says the message waits for the next tool call and offers to copy the text into ChatGPT instead.
Unlabeled conversations show Untitled conversation, a short hash prefix, and their sigil. Operators rename them inline for Web identification only; [conversation titles](#conversation-titles) cover names set by the model.
Ownership uses the SHA-256 digest of `_meta["openai/session"]`, independently of MCP connections, native sessions, cells, terminals, and working directories.
Actual calls carrying that identifier establish recipients. Unidentified groups cannot receive messages.

Successful, running, and ordinary execution-error responses from exec/wait can all carry notes.
Nested tool values remain unchanged. MCP tools/list, resources/read, and Web reads do not consume messages.
Messages are selected at return time, so a note submitted during a wait can accompany that response.
Notes do not wake waits or modify running scripts. Stopping an operation still requires its termination method.

## Agent messages

The [Codex message tool](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/send_message_to_user_async.rs) takes a single message and returns accepted immediately.
We keep its shape and most of its description. Messages only inform: a blocker or finding the operator must know now, or a brief answer to a question the operator sent while work continues.
Questions go through request_user_input_async, which offers choices and returns answers. The destination is the current conversation's Web UI.

The description drops three upstream phrases. Codex promises that a reply arrives as a new user message; exec-mcp cannot start a ChatGPT turn,
and the promise led ChatGPT to wait for replies that never came. The Codex parameter mentions questions, and its description suggests bolding questions;
both invite asking through a channel that has no answer path. The description instead says messages inform, expect no reply, and route questions to the question tool.
It keeps the upstream split between messages that need immediate attention and commentary for routine progress, because every message interrupts the operator.

Agent messages are stored separately from user input so they never echo back as user-authored instructions or create pending-question counts.
They share the existing 72-hour retention and bounded store, and survive audit clearing, execution-service restart, and a full process restart.
Messages are limited to 30,000 UTF-8 bytes. A missing Web listener or conversation identity fails explicitly. Acceptance confirms storage, not that the operator has read it.

A message can arrive while the operator watches another conversation or is away, and a timeline entry alone scrolls out of sight as calls continue.
Unread messages therefore stay pinned above the composer, newest first, until the operator dismisses them. The pinned panel collapses to one line while a question is pending.
Conversations with unread messages rank after those with questions and show a preview and count. The tab badge counts them, and a toast appears elsewhere in the console.
The toast's timer only runs while the page is visible, so a message that arrives in a background tab is still there on return.
Read state lives on the server, so it follows the operator across tabs and devices; it is Web-only state and never reaches the model.
The first notes page carries every unread message, so paging cannot hide one. The timeline shows each message under the call that sent it, in the conversation's color.
It renders bold, inline code, code blocks, and links without interpreting HTML. There is no reply button, because messages do not ask; the composer stays available for anything the operator wants to add.

## Conversation titles

ChatGPT sends no conversation title in `_meta`, and the service never sees the user's message. Pinned Codex titles a thread in its TUI with a hidden model call on the first user message
([thread_title.rs](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/tui/src/app/thread_title.rs)); exec-mcp has no such input,
so the model sets a title with tools.set_conversation_title in its first exec, next to its real work. The description keeps only what ChatGPT needs to use it well:
the purpose, calling once in the first exec, 3 to 8 words summarizing the user's task, the user's language, and that only the first title is kept.
It suggests words instead of Codex's 36 characters and under five words, because Codex constrains a structured output while this model writes the string by hand and cannot count characters reliably.
Codex's imperative-verb and punctuation rules, the Web UI, and the meaning of set are omitted; they do not change the call. The schema accepts 120 characters;
storage collapses whitespace and keeps at most the 256-byte label limit.

Each conversation record accepts one model title, only while it has no label. Later calls return set: false, so the name stays stable,
and an operator's label always wins, as a saved name does in Codex; clearing a model title does not invite another.
A missing Web listener, conversation identity, or capacity also returns set: false instead of failing, because an exception would stop the rest of the first script for a cosmetic result.
The result carries no label, which stays Web-only.

Labels are lost when a record expires, and a model may skip the call. When a response delivers notes to a conversation that can still be titled,
a text block after the notes suggests setting one in the next exec. It is not a user note, uses only space left in the notes budget, and never appears without notes, so ordinary responses stay unchanged.
exec/wait results are textual; a structured envelope keeps only its result and notes.

## Asynchronous questions and answers

The design follows [request_user_input_async](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/request_user_input_async.rs)
in pinned Codex rust-v0.155.1, retaining questions/title/options string arrays and the accepted response shape.
await waits for submission only, allowing the agent to continue other work. Codex can inject a new user message;
exec-mcp returns the answer through a subsequent ordinary tool response.

Every question offers several options. The first is marked recommended but is neither preselected nor submitted automatically.
The UI adds a custom-answer choice. Every choice allows a note, and custom answers require text.
Questions appear in their conversation's timeline under the call that asked them, with the answer and its delivery state once answered.
Pending questions are also pinned in a dock above the composer, oldest first. Number keys select options, and the dock can be minimized while reading.
Conversations with pending questions sort first in the list, and the tab title and favicon show that something is waiting.

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
New agent messages use the same notification preference and deduplication mechanism, sending only a message ID in the event. Their alerts omit message content and open the conversation.
The event omits question and answer text. Repeated request_key submissions, answers, withdrawals, labels, and ordinary notes do not trigger new alerts.
Clicking a notification focuses the page and opens the conversation, where the question waits in the dock. Notifications contain only a short hash and count;
full questions and labels stay in the authenticated page.

Permission is requested when the operator enables notifications, from Settings, the sidebar bell, or the prompt shown with a pending question.
Existing permission can be used directly, and notifications can be paused or tested.
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
The UI's delivered status names the call whose response carried the message, and that call links back to it.
This records server handling only. If the connector loses that response, the user can copy and resend it.
There is no acknowledgment protocol for these low-frequency notes.

## Retention and Web permissions

Questions, notes, agent messages, and labels use a separate bounded store and survive audit eviction, clearing history, and native-host reclamation.
Restarting the execution service reuses the store. serve also saves it to one versioned JSON file beside the Web access key, so a full process restart keeps it.
Records older than 72 hours are cleaned up on access and at load, within an approximately 16 MiB accounting budget.
Insufficient capacity rejects new submissions without overwriting pending messages. Bodies allow at most 30,000 UTF-8 bytes.
Changed content creates a new message, and only pending messages may be withdrawn.

Saves replace the file atomically with mode 0600, about one second after a content change or 30 seconds after an activity-only change.
Delivering a note saves at once, and a normal stop writes pending changes last. Execution state, terminals, store data, and audit records stay in memory only.
An unreadable or invalid file is moved aside with one log line and the store starts empty; if the move fails, that run saves nothing.
A crash between delivering a note and saving that fact can deliver the note again after the restart. This rare duplicate is accepted to keep writes simple, without a delivery log.

Recipients are observed while Web is listening. After Web closes, existing messages may still accompany later calls from their original conversations.
APIs retain same-origin authentication and the write-request marker. SSE sends only change notifications and conversation summaries.
Drafts are isolated by recipient and cleared only after successful submission. Labels and bodies render as plain text.
This channel trusts one operator. Any local process can reach the loopback Web API without signing in, whatever its OS account; a single-operator machine needs no extra authentication for it.
Answer records therefore cannot prove human authorization.

See [OpenAI conversation metadata and visible tool results](https://developers.openai.com/plugins/reference)
and [MCP content blocks](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
