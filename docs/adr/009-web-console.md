# ADR-009 Optional local Web management console

English | [简体中文](009-web-console.zh.md)

Active, updated 2026-09-28.

## Observing and managing runtime state

exec-mcp serve can also start a Web console for call auditing, conversations, native memory, terminals, Skills, downstream MCP, and exports.
The interface is mainly observational, with actions such as clearing audit history and revoking exports.
Top-level calls show exec/wait; local and downstream operations use their actual method names in the nested-call view.

Operators come to see what ChatGPT is doing on the machine, so conversations are the primary object. Each opens as one chronological timeline
of its calls, the operator's messages, and the agent's questions and messages, with a message composer always at the bottom. Answers and agent messages render under the call that sent them,
waits link to the script they resume, and delivered messages link to the call whose response carried them.
The list puts conversations waiting for an answer first, then those with unread agent messages, then those inside a call, then recency.
All activity, processes, tools, files, and settings are secondary pages.
Routes live in the URL fragment so conversations and calls can be linked and back navigation works; the sign-in token fragment stays separate.

Timeline rows read as actions, such as ran a command, edited files, or asked a question, rather than raw script text.
Commands and patches have separate raw-text display and copying. Patches render as diffs, and terminal output keeps its ANSI colors.
Other arguments preserve explicit 0, false, and empty strings. The downstream page groups the current catalog by server,
expands contracts, and shows connection errors without a search probe.
Active call details refresh continuously. Nested calls are recorded when they start and completed in place, so the step in progress is visible;
a returned handle may still identify running work.

The console does not call a model, and exec/wait do not depend on Web execution. Web startup failure produces a warning while MCP continues.
Set [web].enabled=false to disable it. Disabling Web or failing to start it clears and stops audit collection.
Frontend assets are built into the npm package. Runtime pages fetch no third-party fonts, scripts, or analytics.
CI checks frontend types, production builds, and isolated tarball installation.

## Visual language

The console is an operational surface that people scan for long periods. Hierarchy comes from size, weight, and spacing.
Surfaces are flat with hairline borders and a small radius scale. Only floating layers, such as the docks above the composer, the composer, menus, and toasts, cast a restrained shadow.
Neutral grays and ink carry the interface, and color marks state: green for success or a live connection, blue for work in progress and unread agent messages,
amber for something that needs the operator, such as a pending question or memory pressure, and red for failures. Idle and terminated states stay neutral.
The operator's own messages are inverted ink bubbles, so they read as the operator's voice beside the agent's steps.
Diffs keep the conventional green and red line tints because that is how people read them.

Each conversation has a deterministic sigil of three orbits derived from its hash, with hues kept away from the state colors.
The same mark appears in the list, header, activity rows, and process owners, and it rotates only while that conversation is inside a tool call.
Agent messages take their conversation's hue, so a card or toast shows which conversation is speaking.
The brand mark, favicon, and MCP server icon share one geometry defined in code. The favicon gains an amber dot while a question waits
and a blue dot for an unread message, so a background tab still signals it.
Motion only describes a change: new rows rise in, details open to their real height, reordered conversations glide to their new position,
and a sent message rises from the composer into the timeline. prefers-reduced-motion turns these effects off.

Monospace is limited to code, identifiers, paths, URLs, and tokens; counts, times, and durations use the sans face with tabular figures.
Identifiers such as tool names and transports keep their original case. The system font stack satisfies the no-external-fonts rule
and covers Chinese without shipping font files. Destructive or disruptive actions arm on the first click and act on a second click within a few seconds,
instead of opening a modal dialog.

## Interface language

The interface offers English and Simplified Chinese. Automatic selection follows navigator.languages preference order,
using Simplified Chinese for Chinese variants and English when no supported language matches.
The browser describes the viewer's preference, so the server's OS language is not read and no instance language setting is added.
Language is a low-frequency preference placed under Settings, Interface, next to the theme.
The login page keeps an icon entry point. Both locations share options, and interface preferences are separate from execution configuration and restart.

A manual choice is saved in the site's localStorage and can be reset to Auto. Same-origin tabs synchronize it.
When storage is unavailable, the current page keeps the choice in memory. Switching changes wording and date/number formatting while retaining drafts,
filters, and the current page. Sign-in cookies and notification deduplication remain unchanged. Notifications use the interface language at send time.

A typed bilingual dictionary and React Context ship with the frontend, without a translation service or language-pack requests.
Only UI-owned labels and prompts are translated. Question choices, user notes, and logs retain their text.
Model contracts and answer payloads retain their protocol format; size validation uses the actual outgoing content.

## Local and LAN access

The default listener is `127.0.0.1:8893`. Port 8891 serves MCP; 8892 may serve separate file downloads.
Port conflicts fail rather than selecting another port. LAN access requires [web].host set explicitly to `0.0.0.0` or `::`.
Web is intended for trusted networks. Cloudflare/Tailscale MCP tunnels do not publish it automatically.

Passwordless local access requires both the TCP peer and HTTP Host to be loopback, protecting against DNS rebinding.
Browser APIs accept only same-origin requests. Responses set CSP, deny framing, and suppress Referrer; management writes also require the UI header.
CLI/curl requests may omit Origin but still pass the same identity checks.

## Remembering browser sign-in

Each configuration file has its own persisted Web access key using lightweight token-file protection. Ordinary restarts reuse that key.
Initialization is atomic. Explicit rotation persists the new key before replacing the active value.
Read or write failure is an error; it does not create a temporary key or borrow another instance's or tunnel's credentials.

CLI login links carry the key in the URL fragment, which is removed from the address bar after use.
Keys are not stored in localStorage, and query parameters do not authenticate.
Sign-in issues an HMAC cookie with a 30-day lifetime, Max-Age, and `HttpOnly; SameSite=Strict; Path=/api`.
It contains a signed credential; the server checks signature and expiry while the access key stays on the machine.

Existing console status requests renew the 30-day window, allowing long-lived sign-in during normal use.
An unexpired cookie survives closing the browser and restarting the service. Sign-out clears this browser's cookie only.
There is no fixed maximum sign-in lifetime, extra refresh polling, or user-session database.

Static assets, failed authentication, and cross-origin requests do not renew sign-in. Long-lived SSE alone does not renew it either.
SSE checks credentials at its existing heartbeat or send points and disconnects on expiry. A normal page can reconnect with a renewed cookie.
The server does not track per-browser last activity. An old cookie copy remains valid until its signed expiry or global key rotation.

Rotating the key and revealing the configuration file are restricted to trusted loopback requests.
Rotation invalidates old cookies and disconnects existing SSE clients immediately; LAN clients must sign in again. Browsers may also clear cookies early.
Persistent sign-in reduces repeated token entry and keeps credentials valid longer, so users must manage browser access.
The current LAN UI uses HTTP. Remote or untrusted networks need separately protected HTTPS access.

## Bounded audit records

Audit records live in the current process and disappear on restart. Conversations show a digest of host identity; the raw openai/session value never reaches the browser.
Lists return summaries and details are read on demand. A call summary adds the first input line of up to eight nested calls, the first five and last three,
with their status, returned terminal or question handle, and exit code, plus a yielded cell ID and the first failure line. It never includes nested outputs.
Conversation summaries carry the latest nested call's first line. Terminal listings report the first command line, directory, and owning conversation digest,
exports report their owning conversation digest, and status includes the machine's hostname.
SSE broadcasts change types and IDs instead of complete arguments and results.
Response details record the prepared MCP result, then apply audit bounds, so some content can be omitted.
Details show truncation notices. Attachment metadata includes name, type, and size only, without signed URLs or opaque credentials.

Record count, text, and nested calls are bounded. Large text keeps its head and tail; nested calls retain the earliest and rolling latest records.
These rules affect only the Web copy. MCP results, terminal output, and file operations keep their semantics.
The configuration page hides credentials, header/env values, and command arguments. Explicit commands and results may still contain sensitive information,
so treat the console as a high-privilege page. Dashboard counts cover retained records only.

## Management actions

Authenticated endpoints revoke exports by ID while retaining MCP resource conversation checks.
There is no arbitrary command prompt, store editor, or session kill button. New destructive actions require review of authentication, races, and side-effect disclosure.

The Tools and Settings pages can toggle existing MCP servers, discovered Skills, default login, and Web enabled.
It edits only the relevant TOML booleans, preserving comments and other fields. Full validation, revision checks, and atomic replacement protect concurrent edits.
Saving and applying are separate. Restart reads valid configuration before closing the old runtime, then rebuilds connections, native memory, and terminals without backing up temporary execution state.
On failure, the Web management entry point stays available for repair and retry. Repeated clicks share one restart; shutdown never reopens a listener.
Questions and answers use the same Web authentication. Answers are communication, not execution approval.

Conversations show their current execution state without permanent alarms from historical failures.
Audit truncation is marked in details, without a separate dashboard counter. Script completion and nested-command results are shown separately.
A restart banner appears only while a saved configuration waits to be applied, a restart runs, or one failed.
Conversation labels, notes, and answers follow [ADR-010](010-session-notes.md).
Questions and notes are independent of audit retention and survive rolling or clearing audit history.
