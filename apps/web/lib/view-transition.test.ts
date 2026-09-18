import { describe, expect, it, vi } from "vitest";

import { isPlainLeftClick, viewTransitionStarter, type NavigationIntent } from "./view-transition";

const PLAIN: NavigationIntent = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

describe("isPlainLeftClick", () => {
  it("accepts an unmodified primary click", () => {
    expect(isPlainLeftClick(PLAIN)).toBe(true);
  });

  it("leaves every click the browser already has a meaning for alone", () => {
    expect(isPlainLeftClick({ ...PLAIN, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...PLAIN, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...PLAIN, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...PLAIN, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...PLAIN, altKey: true })).toBe(false);
  });

  it("declines a click something else already handled", () => {
    expect(isPlainLeftClick({ ...PLAIN, defaultPrevented: true })).toBe(false);
  });
});

describe("viewTransitionStarter", () => {
  it("is null where the browser has no view transitions", () => {
    expect(viewTransitionStarter({})).toBeNull();
    expect(viewTransitionStarter(undefined)).toBeNull();
    expect(viewTransitionStarter(null)).toBeNull();
    expect(viewTransitionStarter({ startViewTransition: "yes" })).toBeNull();
  });

  it("binds the method to the document that owns it", () => {
    const handle = { finished: Promise.resolve() };
    const doc = {
      seen: null as unknown,
      startViewTransition(callback: () => void) {
        this.seen = this;
        callback();
        return handle;
      },
    };

    const start = viewTransitionStarter(doc);
    expect(start).not.toBeNull();

    const update = vi.fn();
    expect(start?.(update)).toBe(handle);
    expect(update).toHaveBeenCalledOnce();
    expect(doc.seen).toBe(doc);
  });
});
