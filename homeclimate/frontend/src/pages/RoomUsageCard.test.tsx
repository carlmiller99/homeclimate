import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import RoomUsageCard from "./RoomUsageCard";
import * as api from "../api";
import * as sa from "../suggestionsApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../api");
vi.mock("../suggestionsApi", async (orig) => ({
  ...(await orig<typeof import("../suggestionsApi")>()),
  getSuggestions: vi.fn(),
}));

const week = (fill: (d: number, h: number) => number) =>
  Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => fill(d, h)));

const BUNK: sa.RoomSuggestion = {
  kind: "schedule",
  room_id: "r1",
  name: "Bunk Room",
  days: 21,
  hours_a_week: 20,
  blocks: [
    { days: [0, 1, 2, 3, 4], start: "07:00", end: "09:00" },
    { days: [5, 6], start: "22:00", end: "00:00" },
  ],
  usage: week((d, h) => (d < 5 && (h === 7 || h === 8) ? 100 : h === 20 ? 40 : 0)),
};
const LOFT: sa.RoomSuggestion = {
  ...BUNK,
  room_id: "r2",
  name: "Loft",
  hours_a_week: 0,
  blocks: [],
  usage: week((_d, h) => (h === 13 ? 30 : 0)),
};

const data = (rooms: sa.RoomSuggestion[]): sa.Suggestions => ({
  min_days: 14,
  window_days: 30,
  zones: [],
  rooms,
});

const show = (unit: "F" | "C" = "F") =>
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <RoomUsageCard />
    </UnitContext.Provider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sa.getSuggestions).mockResolvedValue(data([BUNK, LOFT]));
  vi.mocked(api.getRooms).mockResolvedValue([
    { id: "r1", name: "Bunk Room", system_wide_temp: 72 } as api.Room,
    { id: "r2", name: "Loft", system_wide_temp: null } as api.Room,
  ]);
  vi.mocked(api.createSchedule).mockResolvedValue({} as api.Schedule);
  vi.mocked(api.getSchedules).mockResolvedValue([]);
});

describe("Smart Learning → When Rooms Are Used", () => {
  it("draws each room's week, darker where it is used more", async () => {
    show();
    expect(screen.getByText("Looking at the history…")).toBeInTheDocument();
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    const strip = within(bunk).getByRole("img", { name: "When Bunk Room is used, hour by hour" });
    const cells = strip.querySelectorAll<HTMLElement>(".usage-cell");
    expect(cells).toHaveLength(7 * 24);
    // Monday 07:00 is always in use, 20:00 sometimes, 03:00 never.
    expect(cells[7].style.opacity).toBe("1");
    expect(Number(cells[20].style.opacity)).toBeCloseTo(0.49);
    expect(cells[3].style.opacity).toBe("0.06");
    const blocks = within(bunk).getAllByRole("listitem");
    expect(blocks[0]).toHaveTextContent(/^Mon–Fri, .*7.*to.*9/);
    // A room seen in use, but at no regular time.
    const loft = screen.getByRole("group", { name: "Loft" });
    expect(within(loft).getByText("No regular hours yet.")).toBeInTheDocument();
    expect(within(loft).queryByRole("button")).not.toBeInTheDocument();
  });

  it("makes a room's usual hours a schedule at a temperature you confirm", async () => {
    show();
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    fireEvent.click(
      within(bunk).getByRole("button", { name: "Make Bunk Room's usual hours a schedule" })
    );
    // Starts from the room's occupied temperature.
    const temp = within(bunk).getByLabelText("Temperature (°F)");
    expect(temp).toHaveValue(72);
    fireEvent.change(temp, { target: { value: "70" } });
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 2 Blocks" }));
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalledTimes(2));
    expect(api.createSchedule).toHaveBeenNthCalledWith(1, "r1", {
      days_of_week: [0, 1, 2, 3, 4],
      start_time: "07:00",
      end_time: "09:00",
      target_temp: 70,
      enabled: true,
      expires_at: null,
      name: "Usual hours",
    });
    expect(await within(bunk).findByText("Added. Change them under Rooms.")).toBeInTheDocument();
    expect(within(bunk).queryByRole("button")).not.toBeInTheDocument();
  });

  it("sends a Celsius temperature as typed, and refuses one out of range (#231)", async () => {
    vi.mocked(sa.getSuggestions).mockResolvedValue(data([{ ...BUNK, blocks: [BUNK.blocks[0]] }]));
    show("C");
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    fireEvent.click(within(bunk).getByRole("button", { name: /Make Bunk Room/ }));
    const temp = within(bunk).getByLabelText("Temperature (°C)");
    expect(temp).toHaveValue(22.2);
    for (const bad of ["", "50"]) {
      fireEvent.change(temp, { target: { value: bad } });
      fireEvent.click(within(bunk).getByRole("button", { name: "Add 1 Block" }));
      expect(within(bunk).getByText("Use a temperature from 4.5°C to 32.2°C.")).toBeInTheDocument();
    }
    expect(api.createSchedule).not.toHaveBeenCalled();
    fireEvent.change(temp, { target: { value: "21" } });
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 1 Block" }));
    await waitFor(() =>
      expect(api.createSchedule).toHaveBeenCalledWith(
        "r1",
        expect.objectContaining({ target_temp: 21 })
      )
    );
  });

  it("adds what it can, says what was refused, and does not add anything twice", async () => {
    vi.mocked(api.getRooms).mockResolvedValue([]);
    show();
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    fireEvent.click(within(bunk).getByRole("button", { name: /Make Bunk Room/ }));
    // No occupied temperature to start from.
    const temp = within(bunk).getByLabelText("Temperature (°F)");
    expect(temp).toHaveValue(null);
    fireEvent.change(temp, { target: { value: "70" } });
    // The first block is refused; the second still goes in.
    vi.mocked(api.createSchedule)
      .mockRejectedValueOnce(new Error("Overlaps with existing block on Mon."))
      .mockResolvedValueOnce({} as api.Schedule);
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 2 Blocks" }));
    expect(
      await within(bunk).findByText("1 block was not added: Overlaps with existing block on Mon.")
    ).toBeInTheDocument();
    expect(api.createSchedule).toHaveBeenCalledTimes(2);
    // Only the refused one is left to add.
    vi.mocked(api.createSchedule).mockRejectedValueOnce("x");
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 1 Block" }));
    expect(
      await within(bunk).findByText("1 block was not added: Could not add it.")
    ).toBeInTheDocument();
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 1 Block" }));
    expect(await within(bunk).findByText("Added. Change them under Rooms.")).toBeInTheDocument();
    expect(vi.mocked(api.createSchedule).mock.calls.map((c) => c[1].start_time)).toEqual([
      "07:00",
      "22:00",
      "07:00",
      "07:00",
    ]);
  });

  it("takes a block the room already has as added, and gives each reason once", async () => {
    // The weekday block went in on an earlier visit; the list could not be read the second time.
    vi.mocked(api.getSchedules)
      .mockResolvedValueOnce([
        {
          days_of_week: [4, 3, 2, 1, 0],
          start_time: "07:00:00",
          end_time: "09:00:00",
          enabled: true,
        } as api.Schedule,
        // The same hours switched off, and different hours, are not it.
        {
          days_of_week: [5, 6],
          start_time: "22:00:00",
          end_time: "00:00:00",
          enabled: false,
        } as api.Schedule,
        {
          days_of_week: [5, 6],
          start_time: "21:00:00",
          end_time: "00:00:00",
          enabled: true,
        } as api.Schedule,
      ])
      .mockRejectedValueOnce(new Error("offline"));
    vi.mocked(api.createSchedule).mockRejectedValueOnce(new Error("Too late."));
    show();
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    fireEvent.click(within(bunk).getByRole("button", { name: /Make Bunk Room/ }));
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 2 Blocks" }));
    expect(await within(bunk).findByText("1 block was not added: Too late.")).toBeInTheDocument();
    expect(api.createSchedule).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.createSchedule).mock.calls[0][1].start_time).toBe("22:00");
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 1 Block" }));
    expect(await within(bunk).findByText("Added. Change them under Rooms.")).toBeInTheDocument();
  });

  it("counts every block that was refused", async () => {
    vi.mocked(api.createSchedule)
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("Too late."));
    show();
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    fireEvent.click(within(bunk).getByRole("button", { name: /Make Bunk Room/ }));
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 2 Blocks" }));
    expect(await within(bunk).findByText("2 blocks were not added: offline.")).toBeInTheDocument();
    expect(within(bunk).getByRole("button", { name: "Add 2 Blocks" })).toBeEnabled();
    fireEvent.click(within(bunk).getByRole("button", { name: "Add 2 Blocks" }));
    expect(
      await within(bunk).findByText("2 blocks were not added: offline; Too late.")
    ).toBeInTheDocument();
  });

  it("says so with nothing to show, when it cannot load, and ignores late answers", async () => {
    vi.mocked(sa.getSuggestions).mockResolvedValue(data([{ ...BUNK, usage: undefined }]));
    const first = show();
    expect(
      await screen.findByText(
        "Nothing yet. A room appears after 14 days of readings from an occupancy sensor."
      )
    ).toBeInTheDocument();
    first.unmount();
    vi.mocked(sa.getSuggestions).mockRejectedValue(new Error("down"));
    const second = show();
    expect(await screen.findByText("Could not load when rooms are used.")).toBeInTheDocument();
    second.unmount();
    let finish: (s: sa.Suggestions) => void = () => {};
    let fail: (e: Error) => void = () => {};
    vi.mocked(sa.getSuggestions).mockReturnValueOnce(new Promise((r) => (finish = r)));
    show().unmount();
    finish(data([BUNK]));
    vi.mocked(sa.getSuggestions).mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    show().unmount();
    fail(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
});
