import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EXPERIMENT_1 } from "@/lib/experiment-1";
import { AUTHOR, LINKS } from "@/lib/links";
import { RUN } from "@/lib/run-script";

import Home from "./page";

const SITE_ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("public site", () => {
  it("depends on no Rivet runtime package", async () => {
    const manifest = JSON.parse(await readFile(`${SITE_ROOT}package.json`, "utf8")) as {
      dependencies: Record<string, string>;
    };
    // A static page that imports core or the database is one refactor away
    // from needing a server, and the product is deliberately not public.
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["next", "react", "react-dom"]);
  });

  it("builds as a static export", async () => {
    const config = await readFile(`${SITE_ROOT}next.config.ts`, "utf8");
    expect(config).toContain('output: "export"');
  });

  it("renders the story, the evidence and the way out", () => {
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("Give it a GitHub issue. Get back a tested pull request.");
    expect(html).toContain(RUN.title);
    expect(html).toContain(RUN.pullRequestUrl);
    expect(html).toContain(EXPERIMENT_1.independent.successFraction);
    expect(html).toContain(EXPERIMENT_1.none.successFraction);
    expect(html).toContain(LINKS.repo);
    expect(html).toContain("Built by Hieu Le");
    expect(html).toContain(AUTHOR.linkedin);
    expect(html).not.toContain("Sign in");
  });

  it("references only images that exist", async () => {
    const html = renderToStaticMarkup(createElement(Home));
    const sources = [...html.matchAll(/src="(\/[^"]+)"/g)].map((match) => match[1]!);
    expect(sources.length).toBeGreaterThan(5);
    for (const source of [...new Set(sources), "/og.png"]) {
      await expect(access(`${SITE_ROOT}public${source}`), source).resolves.toBeUndefined();
    }
  });
});
