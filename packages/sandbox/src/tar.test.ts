import { describe, expect, it } from "vitest";

import { packFile, TAR_BLOCK_BYTES, TarFileReader, TarFormatError } from "./tar";

/**
 * The tar codec, tested the way `stream.test.ts` tests the frame parser: pure
 * bytes, no daemon, every chunk boundary the socket could invent.
 *
 * What these cases cannot tell you is whether Docker agrees, which is what
 * `docker.sbx.test.ts` is for. A round trip through this file proves the reader
 * and the writer agree with each other, which is a much weaker claim and worth
 * remembering when one of them is wrong.
 */

function read(archive: Buffer, maxBytes = 1_024, chunkSize = archive.byteLength) {
  const reader = new TarFileReader(maxBytes);
  for (let offset = 0; offset < archive.byteLength; offset += chunkSize) {
    if (reader.finished) break;
    reader.push(archive.subarray(offset, offset + chunkSize));
  }
  return reader;
}

describe("packFile", () => {
  it("writes a header a reader can round-trip", () => {
    const archive = packFile("sum.ts", Buffer.from("export const sum = 1;\n", "utf8"));
    const file = read(archive).content();

    expect(file).toEqual({
      name: "sum.ts",
      size: 22,
      content: Buffer.from("export const sum = 1;\n", "utf8"),
      truncated: false,
    });
  });

  it("pads every archive to whole blocks and ends it with two empty ones", () => {
    const archive = packFile("a.txt", Buffer.from("hello", "utf8"));

    expect(archive.byteLength % TAR_BLOCK_BYTES).toBe(0);
    // Header, one padded content block, two zero blocks.
    expect(archive.byteLength).toBe(TAR_BLOCK_BYTES * 4);
    expect(archive.subarray(archive.byteLength - TAR_BLOCK_BYTES * 2).every((b) => b === 0)).toBe(
      true,
    );
  });

  it("stamps the container's own user, so extraction does not produce root-owned files", () => {
    // Docker extracts as root and honours what the archive says. A zero here is
    // a file the agent can create and then cannot overwrite.
    const header = packFile("a.txt", Buffer.from("x", "utf8")).subarray(0, TAR_BLOCK_BYTES);

    // Octal, like every numeric field in the format: uid 1000 is 1750 here.
    expect(header.subarray(108, 115).toString("ascii")).toBe("0001750");
    expect(header.subarray(116, 123).toString("ascii")).toBe("0001750");
    expect(Number.parseInt(header.subarray(108, 115).toString("ascii"), 8)).toBe(1000);
    expect(header.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    expect(String.fromCharCode(header[156]!)).toBe("0");
  });

  it("handles an empty file, which has a header and no content block", () => {
    const archive = packFile("empty.txt", Buffer.alloc(0));
    const file = read(archive).content();

    expect(file?.size).toBe(0);
    expect(file?.content.byteLength).toBe(0);
    expect(file?.truncated).toBe(false);
  });

  it("refuses a name that is a path, or one too long for a plain header", () => {
    // The archive is always extracted into the file's parent, so a name with a
    // slash would write somewhere other than where the caller asked - silently.
    expect(() => packFile("src/sum.ts", Buffer.alloc(0))).toThrow(TarFormatError);
    expect(() => packFile("", Buffer.alloc(0))).toThrow(TarFormatError);
    expect(() => packFile("a".repeat(101), Buffer.alloc(0))).toThrow(TarFormatError);
  });
});

describe("TarFileReader", () => {
  it("keeps at most maxBytes and says the file was longer", () => {
    const archive = packFile("big.txt", Buffer.from("0123456789", "utf8"));
    const file = read(archive, 4).content();

    expect(file?.content.toString("utf8")).toBe("0123");
    expect(file?.size).toBe(10);
    expect(file?.truncated).toBe(true);
  });

  it("reassembles a file split across arbitrary chunk boundaries", () => {
    // The socket has no idea where a block ends. A reader that assumes a chunk
    // is a block works perfectly until the first file large enough to matter.
    const content = Buffer.from("x".repeat(1_500), "utf8");
    const archive = packFile("big.txt", content);

    for (const chunkSize of [1, 7, 64, 511, 512, 513, 1_024]) {
      const file = read(archive, 10_000, chunkSize).content();
      expect(file?.content).toEqual(content);
      expect(file?.truncated).toBe(false);
    }
  });

  it("finishes as soon as it has what it was asked for", () => {
    // This is what makes reading 4KB of a 900MB file cost 4KB: the caller
    // destroys the stream the moment this flips.
    const archive = packFile("big.txt", Buffer.from("y".repeat(5_000), "utf8"));
    const reader = new TarFileReader(10_000);

    reader.push(archive.subarray(0, TAR_BLOCK_BYTES));
    expect(reader.finished).toBe(false);
    reader.push(archive.subarray(TAR_BLOCK_BYTES));
    expect(reader.finished).toBe(true);
  });

  it("reports a directory archive rather than inventing a file", () => {
    const archive = Buffer.concat([directoryHeader("repo"), Buffer.alloc(TAR_BLOCK_BYTES * 2)]);
    const reader = read(archive);

    expect(reader.content()).toBeUndefined();
    expect(reader.isDirectory).toBe(true);
  });

  it("skips extended headers and reads the file behind them", () => {
    // A PAX header is a real entry with real content that describes the next
    // entry. A reader that treats it as the file returns key-value pairs and
    // calls them source code.
    const pax = Buffer.from("30 path=src/deeply/nested/name.ts\n", "utf8");
    const archive = Buffer.concat([
      entry("PaxHeaders/0", pax, "x"),
      packFile("name.ts", Buffer.from("real content", "utf8")),
    ]);

    expect(read(archive).content()?.content.toString("utf8")).toBe("real content");
  });

  it("rejects a stream it has lost alignment in", () => {
    // Better to fail loudly than to read a length out of the middle of a file
    // and allocate whatever it happens to say.
    const archive = packFile("a.txt", Buffer.from("hello", "utf8"));
    const corrupt = Buffer.from(archive);
    corrupt.write("zzzz", 124, 4, "ascii");

    expect(() => read(corrupt)).toThrow(TarFormatError);
  });

  it("ends on the empty archive without claiming a file", () => {
    const reader = read(Buffer.alloc(TAR_BLOCK_BYTES * 2));

    expect(reader.finished).toBe(true);
    expect(reader.content()).toBeUndefined();
    expect(reader.isDirectory).toBe(false);
  });
});

/** Builds a header of an arbitrary type, which `packFile` deliberately will not. */
function entry(name: string, content: Buffer, type: string): Buffer {
  const archive = packFile("placeholder", content);
  const header = Buffer.from(archive.subarray(0, TAR_BLOCK_BYTES));
  header.fill(0, 0, 100);
  header.write(name, 0, 100, "utf8");
  header.write(type, 156, 1, "ascii");
  rechecksum(header);
  const padding = Buffer.alloc((TAR_BLOCK_BYTES - (content.byteLength % TAR_BLOCK_BYTES)) % 512);
  return Buffer.concat([header, content, padding]);
}

function directoryHeader(name: string): Buffer {
  return entry(name, Buffer.alloc(0), "5");
}

function rechecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}
