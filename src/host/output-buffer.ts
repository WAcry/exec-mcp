const BLOCK_BYTES = 16 * 1024;
const EMPTY = Buffer.alloc(0);
const continuation = (byte: number) => (byte & 0xc0) === 0x80;

/** Coalesce tiny writes; retained views never keep an unbounded original chunk alive. */
class ByteQueue {
  readonly blocks: { data: Buffer; start: number; end: number }[] = [];
  bytes = 0;
  constructor(private readonly blockSize: number) {}
  get allocatedBytes(): number {
    return this.blocks.reduce((total, block) => total + block.data.length, 0);
  }
  byteAt(offset: number): number {
    for (const block of this.blocks) {
      const size = block.end - block.start;
      if (offset < size) return block.data[block.start + offset]!;
      offset -= size;
    }
    throw new Error("The output buffer index is not valid.");
  }
  push(input: Buffer): void {
    let offset = 0;
    while (offset < input.length) {
      let block = this.blocks.at(-1);
      if (!block || block.end === block.data.length) {
        block = {
          data: Buffer.allocUnsafeSlow(this.blockSize),
          start: 0,
          end: 0,
        };
        this.blocks.push(block);
      }
      const count = Math.min(
        input.length - offset,
        block.data.length - block.end,
      );
      input.copy(block.data, block.end, offset, offset + count);
      block.end += count;
      offset += count;
      this.bytes += count;
    }
  }
  drop(count: number): void {
    while (count > 0) {
      const block = this.blocks[0]!;
      const length = Math.min(count, block.end - block.start);
      block.start += length;
      this.bytes -= length;
      count -= length;
      if (block.start === block.end) this.blocks.shift();
    }
  }
  read(maximum: number): Buffer {
    let count = Math.min(maximum, this.bytes);
    while (count && count < this.bytes && continuation(this.byteAt(count)))
      count--;
    if (!count) return EMPTY;
    const result = Buffer.allocUnsafeSlow(count);
    let offset = 0;
    for (const block of this.blocks) {
      const length = Math.min(count - offset, block.end - block.start);
      block.data.copy(result, offset, block.start, block.start + length);
      offset += length;
      if (offset === count) break;
    }
    this.drop(count);
    return result;
  }
  clear(): void {
    this.blocks.length = 0;
    this.bytes = 0;
  }
}

/** Per-process unread output: oldest prefix + rolling newest tail. No spill files. */
export class RollingOutputBuffer {
  readonly #head: ByteQueue;
  readonly #tail: ByteQueue;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #prefixClosed = false;
  #omitted = 0;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 64)
      throw new Error(
        "The terminal buffer must be a safe integer of at least 64 bytes.",
      );
    this.#headLimit = Math.max(4, Math.floor(capacity / 16));
    this.#tailLimit = capacity - this.#headLimit;
    this.#head = new ByteQueue(Math.min(BLOCK_BYTES, this.#headLimit));
    this.#tail = new ByteQueue(Math.min(BLOCK_BYTES, this.#tailLimit));
  }
  get bytes(): number {
    return this.#head.bytes + this.#tail.bytes;
  }
  get pending(): boolean {
    return this.bytes > 0 || this.#omitted > 0;
  }
  get omittedBytes(): number {
    return this.#omitted;
  }
  get allocatedBytes(): number {
    return this.#head.allocatedBytes + this.#tail.allocatedBytes;
  }

  append(input: string): void {
    const data = Buffer.from(input);
    let offset = 0;
    if (!this.#prefixClosed) {
      let count = Math.min(data.length, this.#headLimit - this.#head.bytes);
      while (count && count < data.length && continuation(data[count]!))
        count--;
      this.#head.push(data.subarray(0, count));
      offset = count;
      if (offset < data.length || this.#head.bytes === this.#headLimit)
        this.#prefixClosed = true;
    }
    if (offset === data.length) return;

    let dropped = 0;
    if (data.length - offset >= this.#tailLimit) {
      dropped = this.#tail.bytes;
      this.#tail.clear();
      let start = data.length - this.#tailLimit;
      while (start < data.length && continuation(data[start]!)) start++;
      dropped += start - offset;
      offset = start;
    } else {
      const excess = Math.max(
        0,
        this.#tail.bytes + data.length - offset - this.#tailLimit,
      );
      if (excess) {
        dropped = excess;
        while (
          dropped < this.#tail.bytes &&
          continuation(this.#tail.byteAt(dropped))
        )
          dropped++;
        this.#tail.drop(dropped);
      }
    }
    this.#omitted = Math.min(Number.MAX_SAFE_INTEGER, this.#omitted + dropped);
    this.#tail.push(data.subarray(offset));
  }

  /**
   * Drop up to `maximum` of the oldest unread tail bytes to honor a shared
   * budget. The first output and the newest output stay; dropped bytes are
   * reported like any other omission. Returns the number of dropped bytes.
   */
  shed(maximum: number): number {
    let count = Math.min(Math.max(0, Math.floor(maximum)), this.#tail.bytes);
    while (count < this.#tail.bytes && continuation(this.#tail.byteAt(count)))
      count++;
    if (!count) return 0;
    this.#tail.drop(count);
    this.#omitted = Math.min(Number.MAX_SAFE_INTEGER, this.#omitted + count);
    return count;
  }

  read(
    maximum: number,
    maxOutputTokens?: number,
  ): {
    output: string;
    truncated?: true;
    omitted_bytes?: number;
    original_token_count?: number;
  } {
    if (!Number.isSafeInteger(maximum) || maximum < 4)
      throw new Error("The terminal read budget must be at least 4 bytes.");
    const head = this.#head.read(maximum);
    let tail: Buffer = EMPTY;
    let omitted = 0;
    if (!this.#head.bytes && (maximum > head.length || !this.#tail.bytes)) {
      omitted = this.#omitted;
      this.#omitted = 0;
      tail = this.#tail.read(maximum - head.length);
    }
    if (!this.pending) this.#prefixClosed = false;
    const marker = (bytes: number, reason: string) =>
      `\n[${bytes} bytes omitted from the middle; ${reason} and later reads cannot recover them]\n`;
    const rollover = omitted
      ? marker(omitted, "the output buffer rolled over")
      : "";
    const data = Buffer.concat([head, tail]);
    const budget =
      maxOutputTokens === undefined
        ? data.length
        : Math.min(Number.MAX_SAFE_INTEGER, maxOutputTokens * 4);
    if (data.length > budget) {
      // Codex estimates four UTF-8 bytes per token and preserves the head/tail.
      // Consume the original batch once; a later poll cannot replay its middle.
      let headEnd = Math.ceil(budget / 2);
      let tailStart = data.length - Math.floor(budget / 2);
      while (headEnd && continuation(data[headEnd]!)) headEnd--;
      while (tailStart < data.length && continuation(data[tailStart]!))
        tailStart++;
      const dropped = tailStart - headEnd;
      const originalTokenCount = Math.ceil((data.length + omitted) / 4);
      const gapInHead = omitted > 0 && head.length <= headEnd;
      const gapInTail = omitted > 0 && !gapInHead && head.length >= tailStart;
      const prefix = gapInHead
        ? data.toString("utf8", 0, head.length) +
          rollover +
          data.toString("utf8", head.length, headEnd)
        : data.toString("utf8", 0, headEnd);
      const suffix = gapInTail
        ? data.toString("utf8", tailStart, head.length) +
          rollover +
          data.toString("utf8", head.length)
        : data.toString("utf8", tailStart);
      return {
        output:
          prefix +
          marker(
            dropped + (gapInHead || gapInTail ? 0 : omitted),
            "max_output_tokens was exceeded",
          ) +
          suffix,
        truncated: true,
        omitted_bytes: omitted + dropped,
        original_token_count: originalTokenCount,
      };
    }
    return {
      output: head.toString("utf8") + rollover + tail.toString("utf8"),
      ...(omitted ? { truncated: true as const, omitted_bytes: omitted } : {}),
    };
  }
  clear(): void {
    this.#head.clear();
    this.#tail.clear();
    this.#omitted = 0;
    this.#prefixClosed = false;
  }
}
