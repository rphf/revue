import { describe, expect, it } from "vitest";
import { excerpt } from "./text";

describe("excerpt", () => {
  it("strips markup to prose", () => {
    expect(
      excerpt(
        "## Title\n\n- **bold** and _em_ with [a link](http://x) ~~gone~~",
      ),
    ).toBe("Title bold and em with a link gone");
  });

  it("keeps code spans and underscores inside words as typed", () => {
    expect(
      excerpt("Want a `GATEWAY_BURST` setting, or keep `a*b`? See snake_case."),
    ).toBe("Want a GATEWAY_BURST setting, or keep a*b? See snake_case.");
  });

  it("drops fenced code", () => {
    expect(excerpt("before\n```go\nx := 1\n```\nafter")).toBe("before after");
  });
});
