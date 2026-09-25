import { describe, expect, it } from "vitest";
import { loadAppearance, loadTheme, saveAppearance, saveTheme } from "./theme";

describe("theme", () => {
  it("persists the chosen theme across loads (localStorage)", () => {
    saveTheme("dark");
    expect(loadTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    saveTheme("light");
    expect(loadTheme()).toBe("light");
    expect(localStorage.getItem("revue-theme")).toBe("light");
  });
});

describe("appearance", () => {
  it("persists the palette and accent and stamps them on <html>", () => {
    saveAppearance({ palette: "mauve", accent: "amber" });
    expect(loadAppearance()).toEqual({ palette: "mauve", accent: "amber" });
    expect(document.documentElement.dataset.palette).toBe("mauve");
    expect(document.documentElement.dataset.accent).toBe("amber");

    localStorage.setItem("revue-appearance", '{"palette":"gray"}');
    expect(loadAppearance()).toEqual({ palette: "neutral", accent: "none" });
  });
});
