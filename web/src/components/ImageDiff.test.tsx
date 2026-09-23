import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import ImageDiff from "./ImageDiff";

describe("ImageDiff", () => {
  it("opens a clicked side in the viewer and switches between sides", async () => {
    const user = userEvent.setup();
    render(
      <ImageDiff
        path="shot.png"
        status="modified"
        oldUrl="/old.png"
        newUrl="/new.png"
        oldSize={2048}
        newSize={1024}
        diffStyle="split"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open after image shot.png" }),
    );
    const viewer = screen.getByTestId("image-viewer");
    expect(within(viewer).getByAltText("After: shot.png")).toHaveAttribute(
      "src",
      "/new.png",
    );
    expect(viewer).toHaveTextContent("1.0 KB");

    await user.click(within(viewer).getByRole("radio", { name: "Before" }));
    expect(within(viewer).getByAltText("Before: shot.png")).toHaveAttribute(
      "src",
      "/old.png",
    );
    expect(viewer).toHaveTextContent("2.0 KB");

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("image-viewer")).not.toBeInTheDocument();
  });

  it("shows a single side without a Before/After switch", async () => {
    const user = userEvent.setup();
    render(
      <ImageDiff
        path="new.png"
        status="added"
        newUrl="/new.png"
        newSize={10}
        diffStyle="unified"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Open image new.png" }),
    );
    const viewer = screen.getByTestId("image-viewer");
    expect(within(viewer).queryByRole("radio")).not.toBeInTheDocument();
  });
});
