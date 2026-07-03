import { describe, expect, it } from "vitest";
import { loadTheme, saveTheme } from "./theme";

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
