import { describe, it, expect, beforeEach } from "vitest";
import { RingBuffer, generateHandle } from "../../src/tools/ringBuffer.ts";

describe("RingBuffer", () => {
  describe("basic append and read", () => {
    it("appends data and reads it back", () => {
      const rb = new RingBuffer(100);
      rb.append(Buffer.from("hello"));
      const result = rb.read(0, 100);
      expect(result.data).toBe("hello");
      expect(result.totalBytes).toBe(5);
      expect(result.truncated).toBe(false);
    });

    it("returns empty for empty buffer", () => {
      const rb = new RingBuffer(100);
      const result = rb.read(0, 100);
      expect(result.data).toBe("");
      expect(result.totalBytes).toBe(0);
      expect(result.truncated).toBe(false);
    });
  });

  describe("overflow behavior", () => {
    it("overwrites oldest data when capacity is exceeded", () => {
      const rb = new RingBuffer(10);
      rb.append(Buffer.from("0123456789ABCDEF"));
      const result = rb.read(7, 20);
      expect(result.totalBytes).toBe(16);
      expect(result.data).toBe("789ABCDEF");
      expect(result.truncated).toBe(false);
    });

    it("reading before dropped bytes returns truncated", () => {
      const rb = new RingBuffer(10);
      rb.append(Buffer.from("0123456789ABCDEF"));
      const result = rb.read(0, 20);
      expect(result.truncated).toBe(true);
    });

    it("tracks totalBytesEverWritten correctly", () => {
      const rb = new RingBuffer(10);
      rb.append(Buffer.from("0123456789"));
      rb.append(Buffer.from("ABCDEF"));
      expect(rb.getTotalBytes()).toBe(16);
    });
  });

  describe("read with offset", () => {
    it("reads from offset correctly", () => {
      const rb = new RingBuffer(100);
      rb.append(Buffer.from("hello world"));
      const result = rb.read(6, 5);
      expect(result.data).toBe("world");
    });

    it("returns truncated when offset is before oldest data", () => {
      const rb = new RingBuffer(10);
      rb.append(Buffer.from("0123456789"));
      rb.append(Buffer.from("ABC"));
      const result = rb.read(0, 5);
      expect(result.truncated).toBe(true);
      expect(result.data).toBe("");
    });
  });

  describe("multiple chunks", () => {
    it("handles multiple appends", () => {
      const rb = new RingBuffer(100);
      rb.append(Buffer.from("hello"));
      rb.append(Buffer.from(" "));
      rb.append(Buffer.from("world"));
      const result = rb.read(0, 100);
      expect(result.data).toBe("hello world");
    });
  });
});

describe("generateHandle", () => {
  it("generates handle with bg_ prefix", () => {
    const handle = generateHandle();
    expect(handle.startsWith("bg_")).toBe(true);
    expect(handle.length).toBe(11);
  });

  it("generates unique handles", () => {
    const handles = new Set<string>();
    for (let i = 0; i < 100; i++) {
      handles.add(generateHandle());
    }
    expect(handles.size).toBe(100);
  });

  it("matches pattern bg_[a-f0-9]{8}", () => {
    expect(generateHandle()).toMatch(/^bg_[a-f0-9]{8}$/);
  });
});
