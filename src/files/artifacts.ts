import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResourceLink } from "@modelcontextprotocol/server";
import { WeightedAdmissionQueue } from "../code-mode/admission.js";
import { resolveUserPath } from "../util.js";
import {
  FILE_CONFIG_SCHEMA,
  FILE_TRANSFER_TIMEOUT_MS,
  RESOURCE_FILE_BYTES,
  type FileConfig,
  type HostFile,
} from "./contracts.js";
import { openDownload, type OpenDownload } from "./download.js";
import { importBoundFile, READ_FLAGS, writeStream } from "./transfer.js";

export const ARTIFACT_URI_PREFIX = "exec-artifact://export/";
export interface ExportInfo {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  expires_at: string;
  uri: string;
}
interface RecordEntry {
  info: ExportInfo;
  file: string;
  scope: string | undefined;
  token?: string;
  expiresAt: number;
  charge: number;
  readers: number;
  retired: boolean;
  removing?: Promise<void>;
}
export interface ArtifactOptions {
  download?: OpenDownload;
  temporaryDirectory?: string;
  now?: () => number;
}

/** Explicit file transfer. Snapshots are independent of cells; bytes never pass through V8 or model text. */
export class ArtifactStore {
  readonly config: FileConfig;
  readonly #records = new Map<string, RecordEntry>();
  readonly #tokens = new Map<string, RecordEntry>();
  readonly #all = new Set<RecordEntry>();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #lifetime = new AbortController();
  readonly #readBudget = new WeightedAdmissionQueue(128 * 1024 * 1024);
  readonly #timer: NodeJS.Timeout;
  readonly #now: () => number;
  #root: Promise<string> | undefined;
  #usedBytes = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    config?: Partial<FileConfig>,
    private readonly options: ArtifactOptions = {},
  ) {
    this.config = FILE_CONFIG_SCHEMA.parse(config ?? {});
    this.#now = options.now ?? Date.now;
    this.#timer = setInterval(
      () => this.#sweep(),
      Math.min(this.config.ttl_seconds * 1000, 60_000),
    );
    this.#timer.unref();
  }

  /** conversation uses the same base64url digest as audit conversation IDs. */
  getActiveArtifacts(): (ExportInfo & { conversation?: string })[] {
    return [...this.#records.values()].map((r) => ({
      ...r.info,
      ...(r.scope
        ? { conversation: Buffer.from(r.scope, "hex").toString("base64url") }
        : {}),
    }));
  }

  importFile(
    file: HostFile,
    destination: string,
    cwd: string,
    overwrite = false,
    signal?: AbortSignal,
  ) {
    return this.#run(
      (active) =>
        importBoundFile(
          file,
          resolveUserPath(destination, cwd),
          overwrite,
          this.config.max_file_bytes,
          this.options.download ?? openDownload,
          active,
        ),
      signal,
    );
  }

  exportFile(
    file: string,
    cwd: string,
    scope?: string,
    delivery: "resource" | "url" = "resource",
    name?: string,
    signal?: AbortSignal,
  ): Promise<{ info: ExportInfo; content: ResourceLink }> {
    return this.#run(async (active) => {
      if (delivery === "url" && !this.config.download)
        throw new Error(
          'No download endpoint is configured (files.download), so delivery "url" is not available. Use delivery "resource". The file was not shared.',
        );
      const sourcePath = resolveUserPath(file, cwd);
      const leaf = name ?? path.basename(sourcePath);
      if (
        !leaf ||
        leaf === "." ||
        leaf === ".." ||
        leaf.length > 255 ||
        // eslint-disable-next-line no-control-regex -- file names must not contain control characters
        /[\x00-\x1f\x7f/\\]/u.test(leaf)
      )
        throw new Error(
          "The file name is not valid. Use 1 to 255 characters without /, \\, or control characters, and do not use . or ...",
        );
      const selected = await lstat(sourcePath, { bigint: true });
      if (!selected.isFile())
        throw new Error(
          "Only a regular file can be exported. Symlinks, directories, pipes, and devices are not supported.",
        );
      const source = await open(sourcePath, READ_FLAGS);
      let snapshot: FileHandle | undefined;
      let saved: string | undefined;
      let charge = 0;
      let committed = false;
      try {
        const before = await source.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.ino !== selected.ino ||
          before.dev !== selected.dev
        )
          throw new Error(
            "The source file was replaced while it was opened, or it is not a regular file. It was not exported.",
          );
        const limit =
          delivery === "resource"
            ? Math.min(this.config.max_file_bytes, RESOURCE_FILE_BYTES)
            : this.config.max_file_bytes;
        if (before.size > BigInt(limit))
          throw new Error(
            delivery === "resource"
              ? 'The file is larger than the limit for delivery "resource" (32 MiB at most). For a larger file, configure files.download and use delivery "url".'
              : "The file is larger than the configured transfer limit (files.max_file_bytes).",
          );
        this.#sweep();
        // Let removals in progress return their space before the quota check.
        await Promise.all(
          [...this.#all].flatMap((record) => record.removing ?? []),
        );
        charge = Number(before.size) + 4096;
        if (charge > this.config.max_export_bytes - this.#usedBytes) {
          charge = 0;
          throw new Error(
            "There is not enough space for export snapshots (files.max_export_bytes). Wait for earlier exports to expire, or revoke exports you no longer need.",
          );
        }
        this.#usedBytes += charge;
        const id = `file_${randomBytes(24).toString("base64url")}`;
        const root = await (this.#root ??= mkdtemp(
          path.join(
            this.options.temporaryDirectory ?? tmpdir(),
            "exec-mcp-files-",
          ),
        ));
        saved = path.join(root, id);
        snapshot = await open(saved, "wx", 0o600);
        const copied = await writeStream(
          source.createReadStream({ autoClose: false, start: 0 }),
          snapshot,
          Number(before.size),
          active,
        );
        const after = await source.stat({ bigint: true });
        if (
          copied.size !== Number(before.size) ||
          ["size", "ino", "dev", "mtimeNs", "ctimeNs"].some(
            (key) =>
              before[key as keyof typeof before] !==
              after[key as keyof typeof after],
          )
        )
          throw new Error(
            "The source file changed during the export, so no snapshot was published. Check the file, then export it again.",
          );
        await snapshot.chmod(0o400);
        await snapshot.close();
        snapshot = undefined;
        active.throwIfAborted();
        const token =
          delivery === "url"
            ? randomBytes(32).toString("base64url")
            : undefined;
        const uri = token
          ? `${this.config.download!.base_url.replace(/\/+$/, "")}/${token}/${encodeURIComponent(leaf)}`
          : `${ARTIFACT_URI_PREFIX}${id}`;
        const expiresAt = this.#now() + this.config.ttl_seconds * 1000;
        const info: ExportInfo = {
          id,
          name: leaf,
          mime_type: mimeForName(leaf),
          ...copied,
          expires_at: new Date(expiresAt).toISOString(),
          uri,
        };
        const record: RecordEntry = {
          info,
          file: saved,
          scope: scopeKey(scope),
          expiresAt,
          charge,
          readers: 0,
          retired: false,
          ...(token ? { token } : {}),
        };
        this.#records.set(id, record);
        this.#all.add(record);
        if (token) this.#tokens.set(token, record);
        committed = true;
        return {
          info,
          content: {
            type: "resource_link",
            uri,
            name: leaf,
            mimeType: info.mime_type,
            size: info.size,
            description: `File snapshot expires at ${info.expires_at}. ${token ? "Anyone with this shareable link can download while the machine and download endpoint are online." : "Read through resources/read on the same authorized MCP connection; not a public URL."}`,
          },
        };
      } finally {
        await source.close();
        await snapshot?.close();
        if (!committed) {
          if (saved) await rm(saved, { force: true });
          this.#usedBytes -= charge;
        }
      }
    }, signal);
  }

  async revoke(id: string, scope?: string): Promise<{ revoked: boolean }> {
    const record = this.#lookup(id, scope);
    this.#retire(record);
    await record.removing;
    return { revoked: true };
  }

  /** Instance-management UI already sits behind the Web console boundary; it
   * revokes by opaque export id without pretending to be a ChatGPT conversation. */
  async revokeFromInstance(id: string): Promise<{ revoked: boolean }> {
    const record = this.#records.get(id);
    if (!record || !this.#valid(record))
      throw new Error("The file resource does not exist or has expired.");
    this.#retire(record);
    await record.removing;
    return { revoked: true };
  }

  available(id: string, scope?: string): boolean {
    try {
      this.#lookup(id, scope);
      return true;
    } catch {
      return false;
    }
  }

  async readResource(uri: string, scope?: string, signal?: AbortSignal) {
    if (!uri.startsWith(ARTIFACT_URI_PREFIX))
      throw new Error("The file resource does not exist or has expired.");
    // resources/read may omit conversation metadata. The private, single-operator
    // MCP ingress remains the authorization boundary, not this optional hint.
    const record = this.#lookup(
      uri.slice(ARTIFACT_URI_PREFIX.length),
      scope,
      true,
    );
    if (record.token || record.info.size > RESOURCE_FILE_BYTES)
      throw new Error(
        "This export is available only through its download URL.",
      );
    return this.#use(
      record,
      async (handle, info, active) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const hash = createHash("sha256");
        const stream = handle.createReadStream({
          autoClose: false,
          start: 0,
          signal: active,
        });
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > info.size)
            throw new Error("The export snapshot changed.");
          hash.update(buffer);
          chunks.push(buffer);
        }
        if (bytes !== info.size || hash.digest("hex") !== info.sha256)
          throw new Error("The export snapshot failed its integrity check.");
        return {
          contents: [
            {
              uri,
              mimeType: info.mime_type,
              blob: Buffer.concat(chunks).toString("base64"),
            },
          ],
        };
      },
      signal,
      record.info.size * 3 + 4096,
    );
  }

  withDownload<T>(
    token: string,
    name: string,
    fn: (file: FileHandle, info: ExportInfo, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const record = this.#tokens.get(token);
    if (!record || record.info.name !== name || !this.#valid(record))
      return Promise.reject(
        new Error("The download does not exist or has expired."),
      );
    return this.#use(record, fn, signal);
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#lifetime.abort();
    clearInterval(this.#timer);
    this.#readBudget.close();
    this.#closing ??= (async () => {
      while (this.#operations.size)
        await Promise.allSettled([...this.#operations]);
      for (const record of this.#all) this.#retire(record);
      try {
        await Promise.all(
          [...this.#all].flatMap((record) => record.removing ?? []),
        );
      } finally {
        if (this.#root)
          await rm(await this.#root, { recursive: true, force: true });
      }
    })();
    return this.#closing;
  }

  #run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.#closed)
      return Promise.reject(new Error("The file transfer service is closed."));
    const active = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => {
      active.throwIfAborted();
      return fn(active);
    });
    this.#operations.add(task);
    void task.then(
      () => this.#operations.delete(task),
      () => this.#operations.delete(task),
    );
    return task;
  }
  #use<T>(
    record: RecordEntry,
    fn: (file: FileHandle, info: ExportInfo, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    reservation = 256 * 1024,
  ): Promise<T> {
    return this.#run(async (active) => {
      if (!this.#valid(record))
        throw new Error("The file resource does not exist or has expired.");
      const release = await this.#readBudget.acquire(reservation, active);
      let admitted = false;
      let handle: FileHandle | undefined;
      try {
        if (!this.#valid(record))
          throw new Error("The file resource does not exist or has expired.");
        record.readers++;
        admitted = true;
        handle = await open(record.file, READ_FLAGS);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== record.info.size)
          throw new Error("The export snapshot changed.");
        return await fn(handle, record.info, active);
      } finally {
        try {
          await handle?.close();
        } finally {
          if (admitted) record.readers--;
          release();
          if (record.retired) this.#remove(record);
        }
      }
    }, signal);
  }
  #lookup(id: string, scope?: string, instanceRead = false): RecordEntry {
    const record = this.#records.get(id);
    const requested = scopeKey(scope);
    if (
      !record ||
      (record.scope !== requested &&
        !(
          instanceRead &&
          (record.scope === undefined || requested === undefined)
        )) ||
      !this.#valid(record)
    )
      throw new Error(
        "The file resource does not exist, has expired, or belongs to another conversation.",
      );
    return record;
  }
  #valid(record: RecordEntry): boolean {
    if (record.expiresAt <= this.#now()) this.#retire(record);
    return !record.retired && !this.#closed;
  }
  #sweep(): void {
    for (const record of this.#records.values())
      if (record.expiresAt <= this.#now()) this.#retire(record);
    // Try again to remove snapshots whose earlier removal failed.
    for (const record of this.#all)
      if (record.retired && !record.removing) this.#remove(record);
  }
  #retire(record: RecordEntry): void {
    record.retired = true;
    this.#records.delete(record.info.id);
    if (record.token) this.#tokens.delete(record.token);
    this.#remove(record);
  }
  #remove(record: RecordEntry): void {
    if (record.readers || record.removing) return;
    // The charge stays while the file can still use disk space. A failed
    // removal is tried again by the next sweep, and close() removes the root.
    record.removing = rm(record.file, { force: true }).then(
      () => {
        this.#usedBytes -= record.charge;
        this.#all.delete(record);
      },
      () => {
        delete record.removing;
      },
    );
  }
}

function scopeKey(scope: string | undefined): string | undefined {
  return scope ? createHash("sha256").update(scope).digest("hex") : undefined;
}
function mimeForName(name: string): string {
  return (
    (
      {
        ".txt": "text/plain",
        ".csv": "text/csv",
        ".json": "application/json",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".zip": "application/zip",
        ".html": "text/html",
        ".md": "text/markdown",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      } as Record<string, string>
    )[path.extname(name).toLowerCase()] ?? "application/octet-stream"
  );
}
