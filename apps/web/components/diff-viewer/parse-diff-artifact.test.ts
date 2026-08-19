import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { displayPath, parseDiffArtifact } from "./parse-diff-artifact";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}

describe("parseDiffArtifact", () => {
  it("classifies a pure addition", () => {
    const parsed = parseDiffArtifact({ content: fixture("add.patch") });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({
      kind: "add",
      newPath: "src/added.ts",
      insertions: 1,
      deletions: 0,
    });
  });

  it("classifies a pure deletion", () => {
    const parsed = parseDiffArtifact({ content: fixture("delete.patch") });
    expect(parsed.files[0]).toMatchObject({
      kind: "delete",
      oldPath: "deleted.txt",
      insertions: 0,
      deletions: 1,
    });
  });

  it("classifies a rename even when gitdiff-parser reports modify", () => {
    const parsed = parseDiffArtifact({ content: fixture("rename.patch") });
    expect(parsed.files[0]).toMatchObject({
      kind: "rename",
      oldPath: "old-name.ts",
      newPath: "new-name.ts",
    });
    expect(displayPath(parsed.files[0]!)).toBe("old-name.ts -> new-name.ts");
  });

  it("classifies a mode-only change with no hunks", () => {
    const parsed = parseDiffArtifact({ content: fixture("mode.patch") });
    expect(parsed.files[0]).toMatchObject({
      kind: "mode",
      oldMode: "100644",
      newMode: "100755",
    });
    expect(parsed.files[0]?.hunks).toEqual([]);
  });

  it("does not treat a Binary files line as text hunks", () => {
    const parsed = parseDiffArtifact({ content: fixture("binary.patch") });
    expect(parsed.files[0]).toMatchObject({ kind: "binary", oldPath: "icon.bin" });
    expect(parsed.files[0]?.hunks).toEqual([]);
  });

  it("does not parse a GIT binary patch payload as lines", () => {
    const parsed = parseDiffArtifact({ content: fixture("binary-literal.patch") });
    expect(parsed.files[0]).toMatchObject({ kind: "binary" });
    expect(parsed.files[0]?.hunks).toEqual([]);
  });

  it("splits a truncated artifact at the elision marker", () => {
    const content = fixture("truncated.patch");
    const parsed = parseDiffArtifact({ content, truncated: true, byteSize: 1420 });

    expect(parsed.truncated).toBe(true);
    expect(parsed.elidedBytes).toBe(565);
    expect(parsed.entries.some((entry) => entry.type === "clip")).toBe(true);
    expect(parsed.files.map((file) => displayPath(file))).toEqual([
      "deleted.txt",
      "icon.bin",
      "src/added.ts",
      "src/sum.ts",
    ]);
  });

  it("marks a mid-file tail as incomplete rather than inventing hunks", () => {
    const content = [
      fixture("add.patch").trimEnd(),
      "... 40 bytes elided ...",
      "keep me",
      "+extra",
      "",
    ].join("\n");
    const parsed = parseDiffArtifact({ content, truncated: true, byteSize: 200 });
    const tail = parsed.files.at(-1);
    expect(tail?.incomplete).toBe(true);
  });

  it("reads every shape out of a real --binary --full-index capture", () => {
    const parsed = parseDiffArtifact({ content: fixture("captured.patch") });
    expect(parsed.files.map((file) => [file.kind, displayPath(file)])).toEqual([
      ["delete", "deleted.txt"],
      ["binary", "icon.bin"],
      ["binary", "logo.bin"],
      ["rename", "old-name.ts -> new-name.ts"],
      ["mode", "script.sh"],
      ["add", "src/added.ts"],
      ["modify", "src/sum.ts"],
    ]);
  });
});
