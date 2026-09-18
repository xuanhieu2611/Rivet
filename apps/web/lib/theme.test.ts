import { describe, expect, it } from "vitest";

import { parseThemePreference, THEME_SCRIPT, THEME_SETTER, THEME_STORAGE_KEY } from "./theme";

describe("parseThemePreference", () => {
  it("accepts the two explicit preferences", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
  });

  it("falls through to the OS for anything else", () => {
    // A cleared, absent, corrupted or unreadable value is not an error state:
    // following the OS is the correct answer for all four.
    for (const value of [null, undefined, "", "system", "DARK", "{}"]) {
      expect(parseThemePreference(value)).toBe("system");
    }
  });
});

describe("THEME_SCRIPT", () => {
  it("installs the setter the toggle calls", () => {
    expect(THEME_SCRIPT).toContain(`window.${THEME_SETTER}=`);
  });

  it("reads and writes the one storage key", () => {
    expect(THEME_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it("wraps every storage access", () => {
    // A private window makes the accessor throw, and a theme preference is not
    // worth a blank page: every read and write must be inside a try/catch.
    const accesses = THEME_SCRIPT.match(/localStorage\./g) ?? [];
    expect(accesses.length).toBeGreaterThan(0);
    for (const statement of THEME_SCRIPT.split("\n")) {
      if (!statement.includes("localStorage.")) continue;
      expect(statement).toContain("try{");
      expect(statement).toContain("catch(e)");
    }
  });

  it("still follows the OS while the tab is open", () => {
    expect(THEME_SCRIPT).toContain('m.addEventListener("change",apply)');
  });

  it("applies before paint rather than on an event", () => {
    // The whole reason this is inline in `<head>`: no flash of the light
    // palette, and no provider to mount first.
    expect(THEME_SCRIPT).toContain("\napply();");
  });
});
