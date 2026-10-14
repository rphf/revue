import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import UpdateNotice from "./UpdateNotice";

describe("UpdateNotice", () => {
  it("shows nothing when the server reports no newer release", () => {
    render(<UpdateNotice version={{ version: "dev" }} />);
    expect(screen.queryByTestId("update-notice")).not.toBeInTheDocument();
  });

  it("offers revue update and links the release notes", async () => {
    const user = userEvent.setup();
    render(
      <UpdateNotice version={{ version: "v0.14.1", latest: "v0.15.0" }} />,
    );
    await user.click(screen.getByTestId("update-notice"));
    expect(screen.getByText("revue update")).toBeInTheDocument();
    expect(screen.getByText(/This server runs v0\.14\.1/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /What's new in v0\.15\.0/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/rphf/revue/releases/tag/v0.15.0",
    );
  });
});
