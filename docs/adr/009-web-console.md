# ADR-009 Optional local Web management console

English | [简体中文](009-web-console.zh.md)

Active, updated 2026-09-22.

## Observing and managing runtime state

exec-mcp serve can also start a Web console for call auditing, conversations, native memory, terminals, Skills, downstream MCP, and exports.
The interface is mainly observational, with actions such as clearing audit history and revoking exports.
Top-level calls show exec/wait; local and downstream operations use their actual method names in the nested-call view.

Commands and patches have separate raw-text display and copying. Other arguments preserve explicit 0, false, and empty strings.
The downstream page filters the current catalog, expands contracts, and shows connection errors without a search probe.
Active call details refresh continuously. Empty nested-call lists disappear after completion; a returned handle may still identify running work.

The console does not call a model, and exec/wait do not depend on Web execution. Web startup failure produces a warning while MCP continues.
Set [web].enabled=false to disable it. Disabling Web or failing to start it clears and stops audit collection.
Frontend assets are built into the npm package. Runtime pages fetch no third-party fonts, scripts, or analytics.
CI checks frontend types, production builds, and isolated tarball installation.

## Interface language

The interface offers English and Simplified Chinese. Automatic selection follows navigator.languages preference order,
using Simplified Chinese for Chinese variants and English when no supported language matches.
The browser describes the viewer's preference, so the server's OS language is not read and no instance language setting is added.
Language is a low-frequency preference placed in a collapsed settings section, leaving the header free.
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
Lists return summaries and details are read on demand. SSE broadcasts change types and IDs instead of complete arguments and results.
Response details record the prepared MCP result, then apply audit bounds, so some content can be omitted.
Details show truncation notices. Attachment metadata includes name, type, and size only, without signed URLs or opaque credentials.

Record count, text, and nested calls are bounded. Large text keeps its head and tail; nested calls retain the earliest and rolling latest records.
These rules affect only the Web copy. MCP results, terminal output, and file operations keep their semantics.
The configuration page hides credentials, header/env values, and command arguments. Explicit commands and results may still contain sensitive information,
so treat the console as a high-privilege page. Dashboard counts cover retained records only.

## Management actions

Authenticated endpoints revoke exports by ID while retaining MCP resource conversation checks.
There is no arbitrary command prompt, store editor, or session kill button. New destructive actions require review of authentication, races, and side-effect disclosure.

The configuration page can toggle existing MCP servers, discovered Skills, default login, and Web enabled.
It edits only the relevant TOML booleans, preserving comments and other fields. Full validation, revision checks, and atomic replacement protect concurrent edits.
Saving and applying are separate. Restart reads valid configuration before closing the old runtime, then rebuilds connections, native memory, and terminals without backing up temporary execution state.
On failure, the Web management entry point stays available for repair and retry. Repeated clicks share one restart; shutdown never reopens a listener.
Questions and answers use the same Web authentication. Answers are communication, not execution approval.

Conversation groups show current execution state without permanent alarms from historical failures.
Audit truncation is marked in details, without a separate dashboard counter. Script completion and nested-command results are shown separately.
Conversation labels, notes, and answers follow [ADR-010](010-session-notes.md).
Questions and notes are independent of audit retention and survive rolling or clearing audit history.
