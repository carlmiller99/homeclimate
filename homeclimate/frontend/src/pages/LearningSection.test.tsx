import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as la from "../learningApi";
import LearningSection from "./LearningSection";

vi.mock("../learningApi", async (orig) => ({
  ...(await orig<typeof import("../learningApi")>()),
  getLearning: vi.fn(),
  updateLearningSettings: vi.fn(),
}));

const ROOM: la.LearningRoom = {
  room_id: "r1",
  name: "Bunk Room",
  thermostat_entity_id: "climate.up",
  samples: 3600,
  days: 12.5,
  with_temperature_pct: 97,
  first_sample_at: "2026-01-01T00:00:00+00:00",
  last_sample_at: "2026-01-13T12:00:00+00:00",
};

function data(over: Partial<la.Learning> = {}): la.Learning {
  return {
    settings: { sampling_enabled: true, sample_retention_days: 60 },
    samples: 3600,
    collecting_since: "2026-01-01T00:00:00+00:00",
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
    expect(screen.getByText(/about two weeks of readings/)).toBeInTheDocument();

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("12.5 days")).toBeInTheDocument();
    expect(rows[0]).not.toHaveClass("is-patchy");
    // A room whose sensors are often missing says so.
    expect(rows[1]).toHaveClass("is-patchy");
    expect(
      within(rows[1]).getByText(
        "No room temperature in 38% of readings. Check this room's sensors."
      )
    ).toBeInTheDocument();
    // A room with nothing yet is not flagged for missing sensors.
    expect(within(rows[2]).getByText("No data yet")).toBeInTheDocument();
    expect(rows[2]).not.toHaveClass("is-patchy");
  });

  it("turns collection off and says what happens to existing data", async () => {
    render(<LearningSection />);
    fireEvent.click(await screen.findByRole("switch", { name: "Collect Room Data" }));
    await waitFor(() =>
      expect(la.updateLearningSettings).toHaveBeenCalledWith({ sampling_enabled: false })
    );
    expect(await screen.findByText(/Collection is off/)).toBeInTheDocument();
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

  it("says so when it cannot load", async () => {
    vi.mocked(la.getLearning).mockRejectedValue(new Error("down"));
    render(<LearningSection />);
    expect(await screen.findByText("Could not load Smart Learning.")).toBeInTheDocument();
  });

  it("points to My Home when there are no rooms", async () => {
    vi.mocked(la.getLearning).mockResolvedValue(data({ rooms: [] }));
    render(<LearningSection />);
    expect(
      await screen.findByText("Add rooms in My Home to start collecting.")
    ).toBeInTheDocument();
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
