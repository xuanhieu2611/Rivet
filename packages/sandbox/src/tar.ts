/**
 * The tar format, in the two directions this package needs it and no further.
 *
 * Docker moves files across the container boundary as tar streams and offers no
 * other way to do it: `getArchive` hands back a tar, `putArchive` takes one.
 * Everything in this file is pure - bytes in, bytes out, no daemon, no sockets -
 * which is the same argument `stream.ts` makes about Docker's frame format, and
 * it is the reason neither has a dependency. A format parser is the easiest
 * thing here to get subtly wrong, and a pure function is one that can be tested
 * exhaustively without a container.
 *
 * The write side remains deliberately tiny: **one regular file**. That is what
 * makes hand-rolling defensible for `putFile`. Archive reads have two callers:
 * `getFile` reads the first file it needs, while the scripted fake needs the
 * complete tree uploaded by `putArchive`. Both readers recognise the extended-
 * header entries GNU and PAX may prepend and skip or apply them, which is a
 * loop rather than an implementation of either extension.
 *
 * ```text
 * offset  size  field
 * 0       100   name
 * 100     8     mode      octal, NUL-terminated
 * 108     8     uid
 * 116     8     gid
 * 124     12    size      octal, NUL-terminated
 * 136     12    mtime     octal, seconds since the epoch
 * 148     8     checksum  octal, computed with these eight bytes read as spaces
 * 156     1     type flag
 * 157     100   link name
 * 257     6     magic     "ustar\0"
 * 263     2     version   "00"
 * 265     32    user name
 * 297     32    group name
 * 329     8     device major
 * 337     8     device minor
 * 345     155   prefix
 * ```
 */

export const TAR_BLOCK_BYTES = 512;

/** Longest name a plain ustar header can carry. Rivet only ever writes a basename. */
const MAX_NAME_BYTES = 100;

/**
 * The container's own user, matching the `User: "node"` the provider sets.
 *
 * Stamped into the header because Docker extracts an archive as root and
 * honours the ownership the tar states. Leave it at zero and every file the
 * agent writes lands owned by root inside a container running as uid 1000,
 * which shows up much later as a build that cannot overwrite a file it just
 * created.
 */
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

const FILE_MODE = 0o644;

const REGULAR_FILE = "0";
const ALTERNATE_REGULAR_FILE = "\0";
const DIRECTORY = "5";

/**
 * Entry types that describe the *next* entry rather than any content of their
 * own: PAX extended headers, PAX global headers, and GNU long name and long
 * link name records. Their payload is skipped whole.
 */
const METADATA_TYPES = new Set(["x", "g", "L", "K"]);

/** A tar that is not one, or one this reader will not pretend to understand. */
export class TarFormatError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TarFormatError";
  }
}

/**
 * Packs one file into a complete tar archive.
 *
 * `name` is a single path component, never a path: the archive is always
 * extracted *into* the file's parent directory, so a name with a slash in it
 * would silently write somewhere other than where the caller asked.
 */
export function packFile(name: string, content: Buffer): Buffer {
  if (name.length === 0 || name.includes("/")) {
    throw new TarFormatError(`A tar entry name must be a single path component, not \`${name}\`.`);
  }
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.byteLength > MAX_NAME_BYTES) {
    throw new TarFormatError(
      `\`${name}\` is ${nameBytes.byteLength} bytes; a tar name is limited to ${MAX_NAME_BYTES}.`,
    );
  }

  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  nameBytes.copy(header, 0);
  writeOctal(header, 100, 8, FILE_MODE);
  writeOctal(header, 108, 8, CONTAINER_UID);
  writeOctal(header, 116, 8, CONTAINER_GID);
  writeOctal(header, 124, 12, content.byteLength);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.write(REGULAR_FILE, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("node", 265, 4, "ascii");
  header.write("node", 297, 4, "ascii");

  // The checksum is defined over a header whose checksum field reads as eight
  // spaces, so it has to be blanked first and written last.
  header.fill(0x20, 148, 156);
  const checksum = sumBytes(header);
  // Six octal digits, a NUL, then a space - the one field that is not simply
  // NUL-terminated, and getting it wrong produces an archive tar reads as
  // corrupt rather than as wrong.
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  const padding = Buffer.alloc(paddingFor(content.byteLength));
  // Two zero blocks are the end-of-archive marker. Without them a reader waits
  // for an entry that never arrives.
  const trailer = Buffer.alloc(TAR_BLOCK_BYTES * 2);
  return Buffer.concat([header, content, padding, trailer]);
}

export interface TarFileContent {
  name: string;
  /** The file's real length, which is larger than `content` when truncated. */
  size: number;
  content: Buffer;
  truncated: boolean;
}

/** One entry from a complete archive, used by the scripted sandbox fake. */
export interface TarArchiveEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  content: Buffer;
  linkName?: string;
}

/**
 * Unpacks a complete tar archive in memory.
 *
 * Docker performs this operation in the daemon. The fake needs the same
 * observable filesystem effect without a daemon, so it uses the same header
 * validation and understands the metadata entries GNU tar and PAX use for long
 * names. It intentionally does not preserve ownership: the fake has no kernel
 * filesystem, and ownership is an adapter concern.
 */
export function unpackArchive(input: Uint8Array): TarArchiveEntry[] {
  const archive = Buffer.from(input);
  const entries: TarArchiveEntry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  let pendingLinkName: string | undefined;
  let pax: { path?: string; linkpath?: string } = {};

  while (offset + TAR_BLOCK_BYTES <= archive.byteLength) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (isZeroBlock(header)) break;

    const parsed = parseHeader(header);
    const end = offset + parsed.size;
    if (end > archive.byteLength) {
      throw new TarFormatError("A tar entry extends beyond the end of the archive.");
    }
    const content = archive.subarray(offset, end);
    offset = end + paddingFor(parsed.size);
    if (offset > archive.byteLength) {
      throw new TarFormatError("A tar entry is missing its block padding.");
    }

    if (parsed.type === "L") {
      pendingName = nulTerminated(content);
      continue;
    }
    if (parsed.type === "K") {
      pendingLinkName = nulTerminated(content);
      continue;
    }
    if (parsed.type === "x" || parsed.type === "g") {
      pax = { ...pax, ...parsePax(content) };
      continue;
    }

    const name = pax.path ?? pendingName ?? parsed.name;
    const linkName = pax.linkpath ?? pendingLinkName ?? parsed.linkName;
    pendingName = undefined;
    pendingLinkName = undefined;
    pax = {};

    if (parsed.type === DIRECTORY) {
      entries.push({ name, type: "directory", content: Buffer.alloc(0) });
    } else if (parsed.type === REGULAR_FILE || parsed.type === ALTERNATE_REGULAR_FILE) {
      entries.push({ name, type: "file", content: Buffer.from(content) });
    } else if (parsed.type === "2") {
      entries.push({
        name,
        type: "symlink",
        content: Buffer.alloc(0),
        ...(linkName === undefined ? {} : { linkName }),
      });
    }
  }

  return entries;
}

/**
 * Pulls the first regular file out of a tar stream, one chunk at a time.
 *
 * Incremental for the same reason `CappedOutput` is bounded: the archive
 * carries a whole file and the caller has asked for at most `maxBytes` of it,
 * so buffering the stream and slicing afterwards would defeat the cap it went
 * to the trouble of stating. Once `finished` is true the caller can destroy the
 * stream - the rest of the archive is padding, an end marker, and bytes nobody
 * asked for.
 */
export class TarFileReader {
  private buffered: Buffer = Buffer.alloc(0);

  /** Bytes of the current entry's payload still to come. */
  private remaining = 0;

  /** Bytes of block padding after that payload, which are never content. */
  private padding = 0;

  /** Set while the current entry is one whose bytes are being kept. */
  private capturing = false;

  private chunks: Buffer[] = [];
  private captured = 0;

  private entry: { name: string; size: number } | undefined;
  private done = false;

  /** A directory entry was seen before any file, so the path is a directory. */
  private directory = false;

  constructor(private readonly maxBytes: number) {}

  /** True once the wanted file has been read, or the archive has ended. */
  get finished(): boolean {
    return this.done;
  }

  /** True when the archive described a directory rather than a file. */
  get isDirectory(): boolean {
    return this.directory;
  }

  push(chunk: Buffer): void {
    if (this.done || chunk.byteLength === 0) return;
    this.buffered = this.buffered.byteLength === 0 ? chunk : Buffer.concat([this.buffered, chunk]);

    for (;;) {
      if (this.remaining > 0) {
        if (this.buffered.byteLength === 0) return;
        const take = Math.min(this.remaining, this.buffered.byteLength);
        if (this.capturing) this.capture(this.buffered.subarray(0, take));
        this.buffered = this.buffered.subarray(take);
        this.remaining -= take;
        // The payload is the whole answer; the padding after it is not worth
        // waiting for, which is what lets the caller hang up early.
        if (this.remaining === 0 && this.capturing) {
          this.done = true;
          return;
        }
        continue;
      }

      if (this.padding > 0) {
        if (this.buffered.byteLength === 0) return;
        const take = Math.min(this.padding, this.buffered.byteLength);
        this.buffered = this.buffered.subarray(take);
        this.padding -= take;
        continue;
      }

      if (this.buffered.byteLength < TAR_BLOCK_BYTES) return;
      const header = this.buffered.subarray(0, TAR_BLOCK_BYTES);
      this.buffered = this.buffered.subarray(TAR_BLOCK_BYTES);

      if (isZeroBlock(header)) {
        // End of archive with nothing taken. A caller that wanted a file gets
        // `content()` of undefined and decides what that means.
        this.done = true;
        return;
      }

      const parsed = parseHeader(header);
      this.remaining = parsed.size;
      this.padding = paddingFor(parsed.size);

      if (METADATA_TYPES.has(parsed.type)) continue;
      if (parsed.type === DIRECTORY) {
        this.directory = true;
        continue;
      }
      if (parsed.type !== REGULAR_FILE && parsed.type !== ALTERNATE_REGULAR_FILE) continue;

      this.entry = { name: parsed.name, size: parsed.size };
      this.capturing = true;
      if (parsed.size === 0) {
        this.done = true;
        return;
      }
    }
  }

  /** What was read, or undefined if the archive held no regular file. */
  content(): TarFileContent | undefined {
    if (!this.entry) return undefined;
    return {
      name: this.entry.name,
      size: this.entry.size,
      content: Buffer.concat(this.chunks),
      truncated: this.entry.size > this.captured,
    };
  }

  private capture(bytes: Buffer): void {
    if (this.captured >= this.maxBytes) return;
    const room = this.maxBytes - this.captured;
    const kept = bytes.byteLength <= room ? bytes : bytes.subarray(0, room);
    this.chunks.push(kept);
    this.captured += kept.byteLength;
  }
}

function parseHeader(header: Buffer): {
  name: string;
  size: number;
  type: string;
  linkName: string;
} {
  const stated = readOctal(header, 148, 8);
  const blanked = Buffer.from(header);
  blanked.fill(0x20, 148, 156);
  // Historically some writers summed the header as signed bytes. Accepting
  // either is four extra characters and saves rejecting a valid archive.
  if (stated !== sumBytes(blanked) && stated !== sumSignedBytes(blanked)) {
    throw new TarFormatError("A tar header failed its checksum; the stream is not aligned.");
  }

  const name = readString(header, 0, 100);
  const prefix = readString(header, 345, 155);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: readOctal(header, 124, 12),
    type: String.fromCharCode(header[156] ?? 0),
    linkName: readString(header, 157, 100),
  };
}

function nulTerminated(value: Buffer): string {
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.byteLength : end).toString("utf8");
}

function parsePax(content: Buffer): { path?: string; linkpath?: string } {
  const values: { path?: string; linkpath?: string } = {};
  let offset = 0;
  while (offset < content.byteLength) {
    const lineEnd = content.indexOf(0x0a, offset);
    if (lineEnd === -1) throw new TarFormatError("A PAX header has no terminating newline.");
    const line = content.subarray(offset, lineEnd + 1).toString("utf8");
    const separator = line.indexOf(" ");
    const length = Number.parseInt(line.slice(0, separator), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > content.byteLength) {
      throw new TarFormatError("A PAX header has an invalid record length.");
    }
    const record = content.subarray(offset, offset + length).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      const key = record.slice(record.indexOf(" ") + 1, equals);
      const value = record.slice(equals + 1).replace(/\n$/, "");
      if (key === "path") values.path = value;
      if (key === "linkpath") values.linkpath = value;
    }
    offset += length;
  }
  return values;
}

function paddingFor(size: number): number {
  const remainder = size % TAR_BLOCK_BYTES;
  return remainder === 0 ? 0 : TAR_BLOCK_BYTES - remainder;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function sumBytes(block: Buffer): number {
  let total = 0;
  for (const byte of block) total += byte;
  return total;
}

function sumSignedBytes(block: Buffer): number {
  let total = 0;
  for (const byte of block) total += byte > 127 ? byte - 256 : byte;
  return total;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  // One digit is given up to the terminating NUL, which is what every ustar
  // field except the checksum does.
  target.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function readOctal(source: Buffer, offset: number, length: number): number {
  const text = readString(source, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new TarFormatError(`A tar header field is not an octal number: \`${text}\`.`);
  }
  return value;
}

function readString(source: Buffer, offset: number, length: number): string {
  const field = source.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.byteLength : end).toString("utf8");
}
