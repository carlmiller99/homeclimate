import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { render, screen, within } from "@testing-library/react";
import SuggestionsCard from "./SuggestionsCard";
import * as sa from "../suggestionsApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../suggestionsApi", async (orig) => ({
  ...(await orig<typeof import("../suggestionsApi")>()),
  getSuggestions: vi.fn(),
}));

const ZONE: sa.ZoneSuggestion = {
  kind: "deadband",
  thermostat_entity_id: "climate.north",
  name: "North Wing",
  current: 0.5,
  suggested: 1,
  runs_a_day: 10.3,
  typical_run_min: 5,
  days: 19,
};

const ROOM: sa.RoomSuggestion = {
  kind: "schedule",
  room_id: "r1",
  name: "Bunk Room",
  days: 21,
  hours_a_week: 25,
  blocks: [
    { days: [0, 1, 2, 3, 4], start: "07:00", end: "09:00" },
    { days: [5, 6], start: "22:00", end: "00:00" },
  ],
};

const data = (over: Partial<sa.Suggestions> = {}): sa.Suggestions => ({
  min_days: 14,
  window_days: 30,
  zones: [],
  rooms: [],
  ...over,
});

const show = (unit: "F" | "C" = "F") =>
  render(
    <MemoryRouter>
      <UnitContext.Provider value={buildUnitContext(unit)}>
        <StrictMode>
          <SuggestionsCard />
        </StrictMode>
      </UnitContext.Provider>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sa.getSuggestions).mockResolvedValue(data({ zones: [ZONE], rooms: [ROOM] }));
});

describe("Suggestions", () => {
  it("says what it suggests, what that rests on, and where to change it", async () => {
    show();
    expect(screen.getByText("Looking at the history…")).toBeInTheDocument();
    const zone = await screen.findByRole("group", { name: "North Wing" });
    expect(
      within(zone).getByText(
        "Over 19 days it ran about 10.3 times a day, and half of those runs were under 5 minutes. A deadband of 1.0°F instead of 0.5°F would give fewer, longer runs. Rooms with a deadband of their own are not affected, and a minimum run time is the other way to lengthen runs."
      )
    ).toBeInTheDocument();
    expect(within(zone).getByRole("link", { name: "My Home" })).toHaveAttribute("href", "/my-home");
    // Rooms have a card of their own: When Rooms Are Used.
    expect(screen.queryByRole("group", { name: "Bunk Room" })).not.toBeInTheDocument();
  });

  it("gives a deadband as a difference in Celsius", async () => {
    show("C");
    // 1.0 °F and 0.5 °F are differences: 0.6 °C and 0.3 °C, with no 32° offset.
    expect(await screen.findByText(/A deadband of 0\.6°C instead of 0\.3°C/)).toBeInTheDocument();
  });

  it("says so when there is nothing to suggest, or it cannot load", async () => {
    vi.mocked(sa.getSuggestions).mockResolvedValue(data({ rooms: [ROOM] }));
    const first = show();
    expect(await screen.findByText(/Suggestions need 14 days of history/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(sa.getSuggestions).mockRejectedValue(new Error("down"));
    show();
    expect(await screen.findByText("Could not load the suggestions.")).toBeInTheDocument();
  });

  it("names days the way a schedule does", () => {
    expect(sa.describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(sa.describeDays([4, 0, 2])).toBe("Mon, Wed, Fri");
    expect(sa.describeDays([5, 6])).toBe("Sat, Sun");
    expect(sa.describeDays([1, 2, 3])).toBe("Tue–Thu");
  });

  it("ignores an answer, or a failure, that lands after it has gone", async () => {
    let answer!: (d: sa.Suggestions) => void;
    vi.mocked(sa.getSuggestions).mockReturnValue(new Promise((r) => (answer = r)));
    const first = render(
      <MemoryRouter>
        <UnitContext.Provider value={buildUnitContext("F")}>
          <SuggestionsCard />
        </UnitContext.Provider>
      </MemoryRouter>
    );
    first.unmount();
    answer(data());
    let fail!: (e: Error) => void;
    vi.mocked(sa.getSuggestions).mockReturnValue(new Promise((_, r) => (fail = r)));
    const second = render(
      <MemoryRouter>
        <UnitContext.Provider value={buildUnitContext("F")}>
          <SuggestionsCard />
        </UnitContext.Provider>
      </MemoryRouter>
    );
    second.unmount();
    fail(new Error("gone"));
    await Promise.resolve();
    expect(document.body.textContent).toBe("");
  });
});
