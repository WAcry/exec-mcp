# ADR-005 File transfer and delivery boundaries

English | [简体中文](005-file-transfer.zh.md)

Active, updated 2026-09-22.

## File binding and orchestration

import_file and export_file are called only inside exec. ChatGPT binds attachments through exec.files, marked with openai/fileParams.
The machine streams imports, and a separate resource channel delivers exports.
Bytes bypass V8, model text, and store; the agent does not need to move Base64 data.

File references are bound at the top MCP level. The service does not inspect source text to guess references.
The machine holds temporary download credentials, while the script uses a zero-based index into the current file array.
Only selected attachments are downloaded. The Web audit omits signed download URLs.
Execution without attachments remains supported. Missing files or mismatched indices fail without looking for attachments in other messages.
Inputs are validated against the host binding contract; see [OpenAI file parameters](https://developers.openai.com/plugins/reference#define-file-inputs).
Code-generated schemas define the exact fields.

## Export and revocation

The model needs import and export methods only. revoke_file and hidden aliases have been removed.
Snapshots expire automatically, and users can revoke one early in the Web console. This keeps the permanent tool set smaller.
Failure, expiry, and normal shutdown still clean up resources. Revocation blocks new downloads; downloads already started or completed cannot be recalled.

## Import validation and replacement

Downloads use HTTPS without redirects. Direct connections pin validated public DNS addresses. An explicit proxy resolves the target and controls routing
under [ADR-008](008-environment-and-proxy.md). Signed URLs are used for downloading only and never enter JS, the tool catalog, persistent logs, or echoed results.

Files stream first into a sibling temporary file, with length checking and a digest, then move into place. Existing files are preserved by default.
Overwrite, cancellation, or replacement failures may occur after some effects and require inspection of the actual state.
Sources are limited to host-bound attachments. MCP ingress authentication authorizes calls; URL shape itself grants no authority.

## Private resources and public URLs

Default delivery uses native ResourceLink blocks, and the host retrieves bytes through resources/read, following the
[WebCodex file bridge](https://github.com/yyjeqhc/webcodex/blob/main/docs/MCP.md#chatgpt-file-bridge).
Each cell's independent queue attaches links to exec/wait. The pinned host continues handling JS, text, and media.
Text budgets preserve file references; queued links revoked before delivery are omitted. Native content blocks avoid protocol changes and special text markers.

Exports create independent, short-lived snapshots. A source change during copying aborts the export; changes after copying do not alter the snapshot.
Snapshots cover explicitly exported files only. Generic large results keep their existing handling.
Resources outlive cells and allow repeated reads. Expiry or revocation blocks new requests; normal shutdown cleans up, and restarts do not restore old links.

Resource endpoints read registered exports only, with no directory browsing or arbitrary-path reads.
Snapshots use a private system temporary directory. Abnormal exits may leave files for system temporary cleanup, but old links cannot access those leftovers.

resources/read uses this instance's trusted single-operator MCP ingress. A request may omit conversation identity.
If both sides have identity, cross-conversation reads are rejected; otherwise ingress authentication still applies.
Private resource URIs cannot be used on the public download port. Public MCP ingress also authorizes only the designated operator.
Multi-user support would require a separate caller-identity and resource-ownership design.

Public URL delivery requires a configured HTTPS base URL and an explicit delivery=url selection.
A separate loopback port offers GET, HEAD, and single-range reads for registered exports, using an independent high-entropy, expiring bearer token.
It exposes no execution, directory browsing, upload, or arbitrary local-path reads. Never forward unauthenticated MCP execution alongside it.

Downloads use attachment, nosniff, and execution-blocking CSP headers. Link holders can download or forward the link; tool descriptions disclose that access.
Users configure a download tunnel or object storage. A failed private-resource delivery never silently becomes a public URL.

## Capacity and validation

MCP binary resources use Base64, and the SDK may buffer entire responses. Resource mode therefore has its own size limit
and a total concurrent-read byte limit. URL mode streams bytes for larger files.
Snapshot quotas include management overhead to bound records from many empty files. Code and the configuration guide define numeric values.
Transfers have independent cancellation and total deadlines that may exceed one 110-second wait window.

Validate the resource protocol, browser downloads, ChatGPT attachment presentation, and sandbox mounting separately.
Server tests establish only what they exercise. Host attachment binding and display require testing through that host connection; sandbox mounting is not guaranteed.
