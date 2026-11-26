import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import Notice from "./Notice";

describe("Notice", () => {
  it("says what, why and where to fix it, with the particulars folded away", () => {
    render(
      <MemoryRouter>
        <Notice
          title="2 sensors not reporting"
          details={<p>sensor.one, sensor.two</p>}
          to="/settings?section=sensors"
          action="Sensor Settings"
          testId="n"
        >
          Two rooms are on partial readings.
        </Notice>
      </MemoryRouter>
    );
    const notice = screen.getByTestId("n");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("2 sensors not reporting");
    expect(notice).toHaveTextContent("Two rooms are on partial readings.");
    expect(screen.getByText("Details").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("link", { name: "Sensor Settings" })).toHaveAttribute(
      "href",
      "/settings?section=sensors"
    );
    expect(notice.querySelector(".notice-mark")).toBeNull();
  });

  it("marks a serious one, and needs neither details nor a link", () => {
    render(
      <Notice serious title="1 thermostat unavailable" testId="n">
        Its zone is not being controlled.
      </Notice>
    );
    const notice = screen.getByTestId("n");
    expect(notice.querySelector(".notice-mark")).not.toBeNull();
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("still links when it is shown outside the app's router", () => {
    render(
      <Notice title="t" to="/my-home" action="Set Up in My Home">
        b
      </Notice>
    );
    expect(screen.getByRole("link", { name: "Set Up in My Home" })).toHaveAttribute(
      "href",
      "/my-home"
    );
  });
});
