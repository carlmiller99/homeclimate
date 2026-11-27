import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import AirIntakeField from "./AirIntakeField";

describe("My Home → Edit Zone → Outside Air Intake", () => {
  it("offers Yes, No and Not Sure, with no test to run", () => {
    const onChange = vi.fn();
    render(<AirIntakeField zoneName="Upstairs" value="unsure" onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Outside air intake for Upstairs" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.textContent)
    ).toEqual(["Yes", "No", "Not Sure"]);
    expect(within(group).getByRole("radio", { name: "Not Sure" })).toBeChecked();
    fireEvent.click(within(group).getByRole("radio", { name: "Yes" }));
    expect(onChange).toHaveBeenCalledWith("yes");
    expect(screen.queryByRole("button", { name: /Test/ })).not.toBeInTheDocument();
  });
});
