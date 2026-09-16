import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

const CHUNK = 256 * 1024;
export class IncrementalReader {
  constructor(checkpoint = {}) {
    Object.assign(
      this,
      { offset: 0, identity: null, prefix: null, mtime: 0, size: 0 },
      checkpoint,
    );
  }
  checkpoint() {
    return {
      offset: this.offset,
      identity: this.identity,
      prefix: this.prefix,
      prefixLength: this.prefixLength,
      mtime: this.mtime,
      size: this.size,
    };
  }
  async read(file, consume) {
    const info = await stat(file);
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    if (
      this.identity === identity &&
      this.size === info.size &&
      this.mtime === info.mtimeMs &&
      this.offset === info.size
    )
      return { bytes: 0, reset: false };
    const handle = await open(file, "r");
    let bytes = 0;
    try {
      const header = Buffer.alloc(Math.min(1024, info.size));
      await handle.read(header, 0, header.length, 0);
      const prefix = createHash("sha256")
        .update(
          header.subarray(
            0,
            Math.min(this.prefixLength || header.length, header.length),
          ),
        )
        .digest("hex");
      const reset =
        this.identity !== identity ||
        info.size < this.offset ||
        (this.prefix && this.prefix !== prefix) ||
        (info.size === this.size && info.mtimeMs !== this.mtime);
      if (reset) this.offset = 0;
      this.identity = identity;
      if (!this.prefix || reset) {
        this.prefix = createHash("sha256").update(header).digest("hex");
        this.prefixLength = header.length;
      }
      if (this.offset === 0 && info.size > CHUNK * 2) {
        const head = Buffer.alloc(64 * 1024);
        await handle.read(head, 0, head.length, 0);
        this.lines(head, 0, consume);
        this.offset = info.size - CHUNK;
        const tail = Buffer.alloc(CHUNK);
        await handle.read(tail, 0, tail.length, this.offset);
        const skip = tail.indexOf(10) + 1;
        if (skip)
          this.offset = this.lines(
            tail.subarray(skip),
            this.offset + skip,
            consume,
          );
        bytes += head.length + tail.length;
      } else {
        for (let n = 0; n < 8 && this.offset < info.size; n++) {
          const buffer = Buffer.alloc(Math.min(CHUNK, info.size - this.offset));
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            this.offset,
          );
          bytes += bytesRead;
          const next = this.lines(
            buffer.subarray(0, bytesRead),
            this.offset,
            consume,
          );
          if (next === this.offset) {
            if (bytesRead === CHUNK) {
              // Discard oversized records through the next newline without parsing fragments.
              let position = this.offset + bytesRead;
              while (position < info.size) {
                const skipBuffer = Buffer.alloc(
                  Math.min(CHUNK, info.size - position),
                );
                await handle.read(skipBuffer, 0, skipBuffer.length, position);
                bytes += skipBuffer.length;
                const end = skipBuffer.indexOf(10);
                position += end < 0 ? skipBuffer.length : end + 1;
                if (end >= 0) {
                  this.offset = position;
                  break;
                }
              }
            }
            break;
          }
          this.offset = next;
        }
      }
      this.size = info.size;
      this.mtime = info.mtimeMs;
      return { bytes, reset };
    } finally {
      await handle.close();
    }
  }
  lines(buffer, start, consume) {
    let pos = 0;
    for (;;) {
      const end = buffer.indexOf(10, pos);
      if (end < 0) break;
      try {
        consume(
          JSON.parse(buffer.subarray(pos, end).toString("utf8")),
          start + pos,
        );
      } catch {
        /* malformed record */
      }
      pos = end + 1;
    }
    return start + pos;
  }
}
