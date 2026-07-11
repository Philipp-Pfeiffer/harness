import { randomBytes } from "node:crypto";

export class RingBuffer {
  private buffer: Buffer;
  private head: number = 0;
  private count: number = 0;
  totalBytesEverWritten: number = 0;

  constructor(private readonly capacity: number = 200_000) {
    this.buffer = Buffer.alloc(capacity);
  }

  append(chunk: Buffer): void {
    const chunkSize = chunk.length;
    this.totalBytesEverWritten += chunkSize;

    if (chunkSize >= this.capacity) {
      const offset = chunkSize - this.capacity;
      chunk.copy(this.buffer, 0, offset, offset + this.capacity);
      this.head = 0;
      this.count = this.capacity;
      return;
    }

    if (chunkSize + this.count > this.capacity) {
      const discardCount = chunkSize + this.count - this.capacity;
      this.head = (this.head + discardCount) % this.capacity;
      this.count = this.capacity;
    }

    const writePos = (this.head + this.count) % this.capacity;
    if (writePos + chunkSize <= this.capacity) {
      chunk.copy(this.buffer, writePos);
    } else {
      const firstPart = this.capacity - writePos;
      chunk.copy(this.buffer, writePos, 0, firstPart);
      chunk.copy(this.buffer, 0, firstPart, chunkSize);
    }
    this.count = Math.min(this.capacity, this.count + chunkSize);
  }

  read(offset: number, limit: number): { data: string; totalBytes: number; truncated: boolean } {
    const totalBytes = this.totalBytesEverWritten;
    const droppedBytes = Math.max(0, totalBytes - this.capacity);

    if (this.count === 0) {
      return { data: "", totalBytes, truncated: false };
    }

    if (offset < droppedBytes) {
      return { data: "", totalBytes, truncated: true };
    }

    const localOffset = offset - droppedBytes;
    if (localOffset >= this.count) {
      return { data: "", totalBytes, truncated: false };
    }

    const available = Math.min(limit, this.count - localOffset);
    const startPos = (this.head + localOffset) % this.capacity;

    const result = Buffer.alloc(available);
    if (startPos + available <= this.capacity) {
      this.buffer.copy(result, 0, startPos, startPos + available);
    } else {
      const firstPart = this.capacity - startPos;
      this.buffer.copy(result, 0, startPos, startPos + firstPart);
      this.buffer.copy(result, firstPart, 0, available - firstPart);
    }

    return { data: result.toString("utf-8"), totalBytes, truncated: false };
  }

  getTotalBytes(): number {
    return this.totalBytesEverWritten;
  }
}

export function generateHandle(): string {
  return `bg_${randomBytes(4).toString("hex")}`;
}
