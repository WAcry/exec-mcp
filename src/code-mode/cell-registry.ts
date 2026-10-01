import { randomHandle } from "../util.js";
import { CancellableMutex } from "./admission.js";
import type { CodeModeSession } from "./session.js";
import type { SessionLease } from "./session-pool.js";
import type { CodeModeExecRequest } from "./types.js";

export const INVALIDATED_CELL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_INVALIDATED_CELLS = 4096;

export interface CellOwner {
  hostCellId: string;
  scope?: string;
  session: CodeModeSession;
  /** Serializes wait calls for this cell. */
  observer: CancellableMutex;
  /** Keeps the native session in use until the cell result is collected. */
  lease: SessionLease;
  takeAttachments?: CodeModeExecRequest["takeAttachments"];
}

interface InvalidatedCell {
  expiresAt: number;
  scope?: string;
  message: string;
}

/**
 * Maps public cell handles to their native session and host cell. A handle
 * outlives its exec request; it ends when wait collects a final result or when
 * its session is retired, which records a reason for later wait calls.
 */
export class CellRegistry {
  readonly #owners = new Map<string, CellOwner>();
  readonly #invalidated = new Map<string, InvalidatedCell>();
  readonly #stickyMessage: string;

  /** @param stickyMessage A recorded reason that a later reason must not replace. */
  constructor(stickyMessage: string) {
    this.#stickyMessage = stickyMessage;
  }

  /** Records the owner of a yielded cell and returns its public handle. */
  track(
    handle: string | undefined,
    owner: Omit<CellOwner, "observer">,
  ): string {
    const id = handle ?? randomHandle("cell");
    this.#owners.set(id, {
      ...owner,
      observer: this.#owners.get(id)?.observer ?? new CancellableMutex(),
    });
    return id;
  }

  /** Forgets a cell whose final result was returned. */
  finish(handle: string): void {
    this.#owners.delete(handle);
    this.#invalidated.delete(handle);
  }

  /** Removes an owner without recording a reason. The caller handles its lease. */
  take(handle: string): CellOwner | undefined {
    const owner = this.#owners.get(handle);
    this.#owners.delete(handle);
    return owner;
  }

  /** Returns the owner for a wait call, or throws the recorded reason. */
  owner(handle: string, requestedScope: string | undefined): CellOwner {
    this.cleanupExpired();
    const owner = this.#owners.get(handle);
    if (owner !== undefined) {
      assertMatchingScope(owner.scope, requestedScope);
      return owner;
    }
    const invalidated = this.#invalidated.get(handle);
    if (invalidated !== undefined) {
      assertMatchingScope(invalidated.scope, requestedScope);
      throw new Error(invalidated.message);
    }
    throw new Error(`未知或已结束的 exec cell：${handle}`);
  }

  /** Ends every cell of one native session and releases its leases. */
  retireSession(session: CodeModeSession, message: string): void {
    for (const [handle, owner] of this.#owners) {
      if (owner.session !== session) continue;
      this.#record(handle, owner.scope, message);
      this.#owners.delete(handle);
      owner.lease.release();
    }
  }

  /** Ends every cell, for example when the shared host is replaced. */
  retireAll(message: string): void {
    this.cleanupExpired();
    for (const [handle, owner] of this.#owners) {
      this.#record(handle, owner.scope, message);
      owner.lease.release();
    }
    this.#owners.clear();
  }

  cleanupExpired(now = Date.now()): void {
    for (const [handle, invalidated] of this.#invalidated) {
      if (invalidated.expiresAt <= now) this.#invalidated.delete(handle);
    }
  }

  clear(): void {
    this.#owners.clear();
    this.#invalidated.clear();
  }

  #record(handle: string, scope: string | undefined, message: string): void {
    if (this.#invalidated.get(handle)?.message === this.#stickyMessage) return;
    while (this.#invalidated.size >= MAX_INVALIDATED_CELLS)
      this.#invalidated.delete(this.#invalidated.keys().next().value!);
    this.#invalidated.set(handle, {
      message,
      expiresAt: Date.now() + INVALIDATED_CELL_RETENTION_MS,
      ...(scope === undefined ? {} : { scope }),
    });
  }
}

function assertMatchingScope(
  ownerScope: string | undefined,
  requestedScope: string | undefined,
): void {
  if (ownerScope !== undefined && ownerScope !== requestedScope) {
    throw new Error("exec cell 属于其他 ChatGPT 会话");
  }
}
