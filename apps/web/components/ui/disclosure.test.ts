import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Disclosure } from "./disclosure";

const ROOT = join(import.meta.dirname, "..", "..");

describe("Disclosure", () => {
  it("renders one details, one summary and one chevron", () => {
    const html = renderToStaticMarkup(
      createElement(Disclosure, { summary: "Head", children: "Body" }),
    );

    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html.match(/<summary/g)).toHaveLength(1);
    expect(html.match(/lucide-chevron-down/g)).toHaveLength(1);
    expect(html).toContain("Head");
    expect(html).toContain("Body");
  });

  it("puts trailing content between the summary and the chevron", () => {
    const html = renderToStaticMarkup(
      createElement(Disclosure, { summary: "Head", trailing: "42ms", children: "Body" }),
    );

    expect(html.indexOf("Head")).toBeLessThan(html.indexOf("42ms"));
    expect(html.indexOf("42ms")).toBeLessThan(html.indexOf("lucide-chevron-down"));
  });

  it("renders children bare when the panel wants no wrapper", () => {
    const html = renderToStaticMarkup(
      createElement(Disclosure, {
        summary: "Head",
        contentClassName: null,
        children: createElement("ol", { "data-bare": "" }),
      }),
    );

    expect(html).toContain('<ol data-bare=""></ol>');
  });

  it("forwards native details attributes", () => {
    const html = renderToStaticMarkup(
      createElement(Disclosure, { summary: "Head", id: "commands", open: true, children: "Body" }),
    );

    expect(html).toContain('id="commands"');
    expect(html).toContain("open=");
  });

  it("is the only hand-rolled details in the app", () => {
    // Item 6's acceptance condition, as a test rather than as a grep somebody
    // has to remember to run: nine call sites used to spell this themselves,
    // each with its own chevron character and its own summary classes.
    const offenders: string[] = [];

    for (const file of sources()) {
      if (file.endsWith(join("components", "ui", "disclosure.tsx"))) continue;
      // Test files assert against rendered markup, which legitimately contains
      // the tag; only authored JSX counts.
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes("<details")) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

function sources(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith(".tsx") || path.endsWith(".ts")) found.push(path);
    }
  };

  walk(join(ROOT, "app"));
  walk(join(ROOT, "components"));
  return found;
}
