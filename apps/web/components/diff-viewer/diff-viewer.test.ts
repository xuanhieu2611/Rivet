import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiffViewer, DIFF_FILE_COLLAPSE_THRESHOLD } from "./diff-viewer";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}

function render(content: string, extras: { truncated?: boolean; byteSize?: number } = {}): string {
  return renderToStaticMarkup(
    createElement(DiffViewer, {
      content,
      ...(extras.truncated === undefined ? {} : { truncated: extras.truncated }),
      ...(extras.byteSize === undefined ? {} : { byteSize: extras.byteSize }),
    }),
  );
}

function manyFiles(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const name = `file-${String(index)}.txt`;
    return [
      `diff --git a/${name} b/${name}`,
      "index 1111111..2222222 100644",
      `--- a/${name}`,
      `+++ b/${name}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
  }).join("");
}

describe("DiffViewer", () => {
  it("renders a pure addition without a counterpart old side", () => {
    const html = render(fixture("add.patch"));
    expect(html).toContain('data-diff-kind="add"');
    expect(html).toContain("src/added.ts");
    expect(html).toContain("export const n = 1;");
    expect(html).toContain('data-diff-line="added"');
  });

  it("renders a pure deletion without a counterpart new side", () => {
    const html = render(fixture("delete.patch"));
    expect(html).toContain('data-diff-kind="delete"');
    expect(html).toContain("deleted.txt");
    expect(html).toContain(">gone<");
    expect(html).toContain('data-diff-line="removed"');
  });

  it("renders a rename with both paths", () => {
    const html = render(fixture("rename.patch"));
    expect(html).toContain('data-diff-kind="rename"');
    expect(html).toContain("old-name.ts -&gt; new-name.ts");
    expect(html).toContain("changed");
  });

  it("renders a mode change without a line table", () => {
    const html = render(fixture("mode.patch"));
    expect(html).toContain('data-diff-kind="mode"');
    expect(html).toContain("100644 -&gt; 100755");
    expect(html).toContain("no counterpart side");
    expect(html).not.toContain("<table");
  });

  it("states that a binary file changed and never dumps the payload", () => {
    const html = render(fixture("binary-literal.patch"));
    expect(html).toContain('data-diff-kind="binary"');
    expect(html).toContain("Binary file changed");
    expect(html).not.toContain("GIT binary patch");
    expect(html).not.toContain("OcmeYYaA");
    expect(html).not.toContain("literal 7");
  });

  it("states the same for a Binary files marker", () => {
    const html = render(fixture("binary.patch"));
    expect(html).toContain("Binary file changed");
    expect(html).not.toContain("Binary files a/icon.bin");
  });

  it("says a truncated artifact is truncated at the clip point", () => {
    const html = render(fixture("truncated.patch"), { truncated: true, byteSize: 1420 });
    expect(html).toContain("data-diff-truncated");
    expect(html).toContain("This diff was truncated");
    expect(html).toContain("data-diff-clip");
    expect(html).toContain("... 565 bytes elided ...");
    expect(html).toContain("deleted.txt");
    expect(html).toContain("src/sum.ts");
  });

  it("renders every shape from a real --binary --full-index capture", () => {
    const html = render(fixture("captured.patch"));
    expect(html).toContain('data-diff-kind="delete"');
    expect(html).toContain('data-diff-kind="binary"');
    expect(html).toContain('data-diff-kind="rename"');
    expect(html).toContain('data-diff-kind="mode"');
    expect(html).toContain('data-diff-kind="add"');
    expect(html).toContain('data-diff-kind="modify"');
    expect(html).not.toContain("OcmeYYaA");
    expect(html).toContain("extra");
  });

  it("collapses by default above the file-count threshold", () => {
    const collapsed = render(manyFiles(DIFF_FILE_COLLAPSE_THRESHOLD + 1));
    expect(collapsed.match(/ data-diff-collapsed="true"/g)?.length).toBe(
      DIFF_FILE_COLLAPSE_THRESHOLD + 1,
    );
    expect(collapsed.includes(" open=")).toBe(false);

    const expanded = render(manyFiles(DIFF_FILE_COLLAPSE_THRESHOLD));
    expect(expanded.match(/data-diff-collapsed="false"/g)?.length).toBe(
      DIFF_FILE_COLLAPSE_THRESHOLD,
    );
    expect(expanded.includes(" open=")).toBe(true);
  });

  it("keeps a 40-file diff from expanding every hunk", () => {
    const html = render(manyFiles(40));
    expect(html.match(/data-diff-file=/g)?.length).toBe(40);
    expect(html.includes(" open=")).toBe(false);
  });
});
