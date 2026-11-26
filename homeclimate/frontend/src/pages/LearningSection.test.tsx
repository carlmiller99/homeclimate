import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as la from "../learningApi";
import { buildUnitContext, UnitContext } from "../contexts";
import LearningSection from "./LearningSection";

vi.mock("../learningApi", async (orig) => ({
  ...(await orig<typeof import("../learningApi")>()),
  getLearning: vi.fn(),
  updateLearningSettings: vi.fn(),
  fitLearning: vi.fn(),
}));

const MODEL: la.RoomModel = {
  room_id: "r1",
  fitted_at: "2026-01-13T09:20:00+00:00",
  windows: 500,
  hours: 250,
  loss: 0.05,
  pull: 0.2,
  heat: 3.6,
  cool: -2.7,
  drift: 0.3,
  heat_hours: 40,
  cool_hours: 0,
  out_spread: 30,
  rmse: 0.2,
  learned: { loss: true, heat: true, cool: false },
  pinned: [],
  grade: "ready",
};

const ROOM: la.LearningRoom = {
  room_id: "r1",
  name: "Bunk Room",
  thermostat_entity_id: "climate.up",
  samples: 3600,
  days: 12.5,
  with_temperature_pct: 97,
  first_sample_at: "2026-01-01T00:00:00+00:00",
  last_sample_at: "2026-01-13T12:00:00+00:00",
  model: null,
};

function data(over: Partial<la.Learning> = {}): la.Learning {
  return {
    settings: {
      sampling_enabled: true,
      sample_retention_days: 60,
      early_start_level: 0,
      coast_level: 0,
      arrival_level: 0,
      early_cool_level: 0,
    },
    coasting: { level: 0, misses_this_week: 0, misses_to_watch_only: 3, switched_back_at: null },
    samples: 3600,
    collecting_since: "2026-01-01T00:00:00+00:00",
    last_sample_at: "2026-01-13T12:00:00+00:00",
    sample_every_min: 5,
    checked_at: "2026-01-13T12:00:00+00:00",
    rooms: [
      ROOM,
      {
        ...ROOM,
        room_id: "r2",
        name: "Craft Room",
        samples: 400,
        days: 1.4,
        with_temperature_pct: 62,
      },
      { ...ROOM, room_id: "r3", name: "Den", samples: 0, days: 0, with_temperature_pct: 0 },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(la.getLearning).mockResolvedValue(data());
  vi.mocked(la.updateLearningSettings).mockImplementation(async (patch) =>
    data({ settings: { ...data().settings, ...patch } })
  );
});

describe("describeCollected", () => {
  it("names how much a room has", () => {
    expect(la.describeCollected({ samples: 0, days: 0 })).toBe("No data yet");
    expect(la.describeCollected({ samples: 3, days: 0 })).toBe("Just started");
    expect(la.describeCollected({ samples: 288, days: 1 })).toBe("1 day");
    expect(la.describeCollected({ samples: 3600, days: 12.5 })).toBe("12.5 days");
  });
});

describe("Smart Learning section", () => {
  it("shows a loading line, then the settings and each room's progress", async () => {
    render(<LearningSection />);
    expect(screen.getByText("Loading Smart Learning…")).toBeInTheDocument();
    const toggle = await screen.findByRole("switch", { name: "Collect Room Data" });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/every 5 minutes/)).toBeInTheDocument();
    expect(screen.getByLabelText("Keep Room Data For")).toHaveValue(60);
    expect(screen.getByText(/How much each room has recorded so far/)).toBeInTheDocument();
    expect(screen.getByText(/Last reading/)).toBeInTheDocument();

    // Each room appears twice: what it has recorded, then what that has taught.
    const rows = screen.getAllByRole("listitem").slice(0, 3);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("12.5 days")).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/No room temperature/)).toBeNull();
    // A room whose sensors are often missing says so.
    expect(
      within(rows[1]).getByText(
        "No room temperature in 38% of readings. Check this room's sensors."
      )
    ).toBeInTheDocument();
    // A room with nothing yet is not flagged for missing sensors.
    expect(within(rows[2]).getByText("No data yet")).toBeInTheDocument();
    expect(within(rows[2]).queryByText(/No room temperature/)).toBeNull();
  });

  it("turns collection off and says what happens to existing data", async () => {
    render(<LearningSection />);
    fireEvent.click(await screen.findByRole("switch", { name: "Collect Room Data" }));
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ sampling_enabled: false })
    );
    expect(await screen.findByText(/Collection is off/)).toBeInTheDocument();
    expect(screen.queryByText(/How much each room/)).toBeNull();
    expect(screen.getByRole("switch", { name: "Collect Room Data" })).not.toBeChecked();
  });

  it("saves the retention on blur or Enter and shows what the server stored", async () => {
    render(<LearningSection />);
    const input = await screen.findByLabelText("Keep Room Data For");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ sample_retention_days: 90 })
    );
    await waitFor(() => expect(input).toHaveValue(90));

    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenLastCalledWith({ sample_retention_days: 120 })
    );
    await waitFor(() => expect(input).toHaveValue(120));
    // Another key does not save.
    fireEvent.change(input, { target: { value: "121" } });
    fireEvent.keyDown(input, { key: "a" });
    expect(la.updateLearningSettings).toHaveBeenCalledTimes(2);
  });

  it("puts back a retention that is out of range, blank, fractional or unchanged", async () => {
    render(<LearningSection />);
    const input = await screen.findByLabelText("Keep Room Data For");
    for (const bad of ["29", "366", "", "45.5"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.blur(input);
      expect(input).toHaveValue(60);
    }
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.blur(input);
    expect(la.updateLearningSettings).not.toHaveBeenCalled();
  });

  it("shows why a save failed, and clears it on the next save", async () => {
    vi.mocked(la.updateLearningSettings).mockRejectedValueOnce(new Error("Not allowed"));
    render(<LearningSection />);
    const toggle = await screen.findByRole("switch", { name: "Collect Room Data" });
    fireEvent.click(toggle);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    expect(toggle).toBeChecked();

    vi.mocked(la.updateLearningSettings).mockRejectedValueOnce("nope");
    fireEvent.click(toggle);
    expect(await screen.findByText("Could not save the setting")).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText("Could not save the setting")).toBeNull());
  });

  it("asks before shortening the retention, because that deletes readings", async () => {
    render(<LearningSection />);
    const input = await screen.findByLabelText("Keep Room Data For");
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    const dialog = await screen.findByText("Keep room data for 30 days?");
    expect(
      screen.getByText(
        "Readings older than 30 days will be deleted within 5 minutes. This can't be undone."
      )
    ).toBeInTheDocument();
    expect(la.updateLearningSettings).not.toHaveBeenCalled();
    // Cancel puts the stored number back.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog).not.toBeInTheDocument();
    expect(input).toHaveValue(60);
    expect(la.updateLearningSettings).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.blur(input);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Older Readings" }));
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ sample_retention_days: 45 })
    );
    await waitFor(() => expect(input).toHaveValue(45));
    expect(screen.queryByText("Keep room data for 45 days?")).toBeNull();
  });

  it("holds the controls while a save is in flight, and puts back a refused number", async () => {
    let finish!: (d: la.Learning) => void;
    vi.mocked(la.updateLearningSettings).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<LearningSection />);
    const toggle = await screen.findByRole("switch", { name: "Collect Room Data" });
    const input = screen.getByLabelText("Keep Room Data For");
    fireEvent.click(toggle);
    await waitFor(() => expect(input).toBeDisabled());
    fireEvent.click(toggle); // ignored: one save at a time
    expect(la.updateLearningSettings).toHaveBeenCalledTimes(1);
    finish(
      data({
        settings: {
          sampling_enabled: false,
          sample_retention_days: 60,
          early_start_level: 0,
          coast_level: 0,
          arrival_level: 0,
          early_cool_level: 0,
        },
      })
    );
    await waitFor(() => expect(input).not.toBeDisabled());

    vi.mocked(la.updateLearningSettings).mockRejectedValueOnce(new Error("Not allowed"));
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    expect(input).toHaveValue(60);
  });

  it("leaves out the last-reading time before anything is recorded", async () => {
    vi.mocked(la.getLearning).mockResolvedValue(data({ last_sample_at: null }));
    render(<LearningSection />);
    await screen.findByText(/How much each room/);
    expect(screen.queryByText(/Last reading/)).toBeNull();
  });

  it("shows what each room has taught, and works it out on request", async () => {
    vi.mocked(la.getLearning).mockResolvedValue(
      data({
        rooms: [
          { ...ROOM, model: MODEL },
          { ...ROOM, room_id: "r2", name: "Craft Room" },
        ],
      })
    );
    vi.mocked(la.fitLearning).mockResolvedValue(
      data({
        rooms: [
          { ...ROOM, model: MODEL },
          {
            ...ROOM,
            room_id: "r2",
            name: "Craft Room",
            model: { ...MODEL, room_id: "r2", grade: "learning" },
          },
        ],
      })
    );
    render(<LearningSection />);
    const bunk = await screen.findByRole("listitem", { name: "Bunk Room model" });
    expect(bunk).toHaveTextContent("Ready");
    expect(bunk).toHaveTextContent(
      "Heats about 3.6°F an hour. Cooling rate not learned yet (needs about 3 hours of long cooling runs). Drifts about 0.5°F an hour toward outside for every 10°F of difference."
    );
    const craft = screen.getByRole("listitem", { name: "Craft Room model" });
    expect(craft).toHaveTextContent("Not worked out yet.");
    fireEvent.click(screen.getByRole("button", { name: "Work It Out Now" }));
    expect(screen.getByRole("button", { name: "Working It Out…" })).toBeDisabled();
    await waitFor(() => expect(craft).toHaveTextContent("Learning"));
    vi.mocked(la.fitLearning).mockRejectedValueOnce(new Error("Busy"));
    fireEvent.click(screen.getByRole("button", { name: "Work It Out Now" }));
    expect(await screen.findByText("Busy")).toBeInTheDocument();
    vi.mocked(la.fitLearning).mockRejectedValueOnce("x");
    fireEvent.click(screen.getByRole("button", { name: "Work It Out Now" }));
    expect(await screen.findByText("Could not work it out")).toBeInTheDocument();
  });

  it("sets how far Start Rooms Early may go", async () => {
    render(<LearningSection />);
    const level = await screen.findByLabelText("Start Rooms Early");
    expect(level).toHaveValue("0");
    fireEvent.change(level, { target: { value: "1" } });
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ early_start_level: 1 })
    );
    await waitFor(() => expect(level).toHaveValue("1"));
  });

  it("sets whether rooms may coast, and says how the week has gone", async () => {
    vi.mocked(la.getLearning).mockResolvedValue(
      data({
        coasting: {
          level: 2,
          misses_this_week: 2,
          misses_to_watch_only: 3,
          switched_back_at: null,
        },
      })
    );
    render(<LearningSection />);
    const level = await screen.findByLabelText("Let Rooms Coast");
    expect(
      screen.getByText(/2 waits this week ended with the room well short\. At 3 it goes back/)
    ).toBeInTheDocument();
    fireEvent.change(level, { target: { value: "2" } });
    await waitFor(() => expect(la.updateLearningSettings).toHaveBeenCalledWith({ coast_level: 2 }));
    fireEvent.change(screen.getByLabelText("Get Rooms Ready for Usual Arrivals"), {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ arrival_level: 1 })
    );
    fireEvent.change(screen.getByLabelText("Early Cooling"), { target: { value: "2" } });
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ early_cool_level: 2 })
    );
    cleanup();
    vi.mocked(la.getLearning).mockResolvedValue(
      data({
        coasting: {
          level: 1,
          misses_this_week: 0,
          misses_to_watch_only: 3,
          switched_back_at: "2026-01-13T09:00:00+00:00",
        },
      })
    );
    render(<LearningSection />);
    expect(
      await screen.findByText(/It switched itself back to Watch Only on .*(2026|Jan)/)
    ).toBeInTheDocument();
    const none = { level: 2, misses_this_week: 0, misses_to_watch_only: 3, switched_back_at: null };
    expect(la.describeCoasting(none)).toBe("No room has been left waiting too long this week.");
    expect(la.describeCoasting({ ...none, misses_this_week: 1 })).toMatch(/^One wait this week/);
    // After it has switched itself back, it says so (in the house's time, when given a formatter).
    const back = { ...none, level: 1, switched_back_at: "2026-01-13T09:00:00+00:00" };
    expect(la.describeCoasting(back)).toBe(
      "It switched itself back to Watch Only on 2026-01-13T09:00:00+00:00, after 3 waits in a week ended with the room well short."
    );
    expect(la.describeCoasting(back, () => "Jan 13")).toMatch(/Watch Only on Jan 13,/);
  });

  it("gives the fixed margins in the house's unit", async () => {
    const { unmount } = render(<LearningSection />);
    expect(await screen.findByText(/is kept 1\.5° below its Cool To/)).toBeInTheDocument();
    expect(screen.getByText(/never once a room is 2° off/)).toBeInTheDocument();
    unmount();
    render(
      <UnitContext.Provider value={buildUnitContext("C")}>
        <LearningSection />
      </UnitContext.Provider>
    );
    expect(await screen.findByText(/is kept 0\.8° below its Cool To/)).toBeInTheDocument();
    expect(screen.getByText(/never once a room is 1\.1° off/)).toBeInTheDocument();
  });

  it("describes a model in the house's unit, as differences", () => {
    const c = buildUnitContext("C");
    // 3.6 °F an hour is 2.0 °C an hour: a rate is a difference, with no 32° offset.
    expect(la.describeModel(MODEL, c.toDisplayDelta, c.unitLabel)).toEqual([
      "Heats about 2.0°C an hour",
      "Cooling rate not learned yet (needs about 3 hours of long cooling runs)",
      // 0.05 per °F is 0.45 °F an hour per 9 °F, which is 0.25 °C an hour per 5 °C.
      "Drifts about 0.3°C an hour toward outside for every 5°C of difference",
    ]);
    const f = buildUnitContext("F");
    const all = { ...MODEL, learned: { loss: false, heat: false, cool: true } };
    expect(la.describeModel(all, f.toDisplayDelta, f.unitLabel)).toEqual([
      "Heating rate not learned yet (needs about 3 hours of long heating runs)",
      "Cools about 2.7°F an hour",
      "Heat loss not learned yet (needs more varied weather)",
    ]);
    // A room with a window of known direction says what the sun does to it.
    const sunny = { ...MODEL, sun: 1.8, sun_hours: 40, learned: { ...MODEL.learned, sun: true } };
    expect(la.describeModel(sunny, f.toDisplayDelta, f.unitLabel)[3]).toBe(
      "Gains about 0.7°F an hour with the sun full on its windows"
    );
    expect(la.describeModel(sunny, c.toDisplayDelta, c.unitLabel)[3]).toBe(
      "Gains about 0.4°C an hour with the sun full on its windows"
    );
    expect(la.describeModel({ ...sunny, sun: undefined }, f.toDisplayDelta, f.unitLabel)[3]).toBe(
      "Gains about 0.0°F an hour with the sun full on its windows"
    );
    const dawning = { ...MODEL, sun_hours: 4, learned: { ...MODEL.learned, sun: false } };
    expect(la.describeModel(dawning, f.toDisplayDelta, f.unitLabel)[3]).toBe(
      "Sun on its windows not learned yet (needs about 10 sunlit hours)"
    );
    expect(la.describeModel({ ...MODEL, grade: "none" }, f.toDisplayDelta, f.unitLabel)).toEqual([
      "Needs about a day of readings with nothing open and no fire lit.",
    ]);
  });

  it("says so when it cannot load", async () => {
    vi.mocked(la.getLearning).mockRejectedValue(new Error("down"));
    render(<LearningSection />);
    expect(await screen.findByText("Could not load Smart Learning.")).toBeInTheDocument();
  });

  it("points to My Home when there are no rooms", async () => {
    vi.mocked(la.getLearning).mockResolvedValue(data({ rooms: [] }));
    render(<LearningSection />);
    expect(await screen.findAllByText("Add rooms in My Home to start collecting.")).toHaveLength(2);
  });

  it("ignores a response that arrives after it is gone", async () => {
    let resolve!: (d: la.Learning) => void;
    let reject!: (e: Error) => void;
    vi.mocked(la.getLearning)
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    render(<LearningSection />).unmount();
    resolve(data());
    render(<LearningSection />).unmount();
    reject(new Error("late"));
    await Promise.resolve();
  });
});
