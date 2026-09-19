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
    throw new Error("输出缓冲索引无效。");
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
      throw new Error("终端缓冲必须至少为 64 字节的安全整数。");
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

  read(maximum: number): {
    output: string;
    truncated?: true;
    omitted_bytes?: number;
  } {
    if (!Number.isSafeInteger(maximum) || maximum < 4)
      throw new Error("终端读取预算至少需要 4 字节。");
    const head = this.#head.read(maximum);
    let output = head.toString("utf8");
    let omitted = 0;
    if (!this.#head.bytes && (maximum > head.length || !this.#tail.bytes)) {
      omitted = this.#omitted;
      this.#omitted = 0;
      if (omitted)
        output += `\n[中间已省略 ${omitted} 字节；输出已滚动截断，不能通过后续读取恢复]\n`;
      output += this.#tail.read(maximum - head.length).toString("utf8");
    }
    if (!this.pending) this.#prefixClosed = false;
    return {
      output,
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
