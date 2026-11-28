import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import DayChips from "./DayChips";

describe("DayChips", () => {
  it("shows the week as buttons, pressed for the days chosen", () => {
    const onToggle = vi.fn();
    render(<DayChips label="On These Days" selected={[0, 4]} onToggle={onToggle} />);
    const group = screen.getByRole("group", { name: "On These Days" });
    const days = within(group).getAllByRole("button");
    expect(days.map((d) => d.textContent)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(days.map((d) => d.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "true",
      "false",
      "false",
    ]);
    fireEvent.click(days[5]);
    expect(onToggle).toHaveBeenCalledWith(5);
  });

  it("can be switched off while a change is saving", () => {
    render(<DayChips label="Days" selected={[]} disabled onToggle={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Mon" })).toBeDisabled();
  });
});
