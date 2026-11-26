import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as ha from "../houseApi";
import RoomCalendarsCard from "./RoomCalendarsCard";

vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  getHouse: vi.fn(),
  setRoomCalendar: vi.fn(),
  clearRoomCalendar: vi.fn(),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getRooms: vi.fn(),
}));
vi.mock("../components/EntityPicker", () => ({
  default: ({ onSelect, domain }: { onSelect: (id: string) => void; domain: string }) => (
    <button type="button" onClick={() => onSelect(`${domain}.custody`)}>
      pick {domain}
    </button>
  ),
}));

const CAL: ha.RoomCalendar = { entity_id: "calendar.custody", match_text: "Girls", lead_min: 120 };

function house(calendar: ha.RoomCalendar | null = CAL, inUse = false): ha.House {
  return {
    house_heat_to: null,
    house_cool_to: null,
    min_gap: 3,
    low: 45,
    high: 95,
    rooms: [
      { room_id: "bunk", in_use: inUse, use_schedules: true, use_presence: true, calendar },
      { room_id: "den", in_use: true, use_schedules: true, use_presence: true, calendar: null },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getRooms).mockResolvedValue([
    { id: "den", name: "Den" },
    { id: "bunk", name: "Bunk Room" },
  ] as api.Room[]);
  vi.mocked(ha.getHouse).mockResolvedValue(house());
  vi.mocked(ha.setRoomCalendar).mockImplementation(async (_id, patch) =>
    house({ ...CAL, ...patch })
  );
  vi.mocked(ha.clearRoomCalendar).mockResolvedValue(house(null));
});

describe("Rooms In Use by Calendar", () => {
  it("lists every room, with the calendar a room follows and what it says now", async () => {
    render(<RoomCalendarsCard />);
    expect(screen.getByText("Loading rooms…")).toBeInTheDocument();
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    expect(within(bunk).getByText("calendar.custody")).toBeInTheDocument();
    expect(within(bunk).getByText("Not in use now")).toBeInTheDocument();
    expect(within(bunk).getByLabelText("Only Events Containing")).toHaveValue("Girls");
    expect(within(bunk).getByLabelText("Minutes ahead for Bunk Room")).toHaveValue(120);
    // A room following nothing only offers to follow one. Rooms are in name order.
    const den = screen.getByRole("group", { name: "Den" });
    expect(within(den).getByRole("button", { name: "pick calendar" })).toBeInTheDocument();
    expect(within(den).queryByText(/in use now/i)).toBeNull();
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "Bunk Room",
      "Den",
    ]);
  });

  it("says In use now when the calendar has the room in use", async () => {
    vi.mocked(ha.getHouse).mockResolvedValue(house(CAL, true));
    render(<RoomCalendarsCard />);
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    expect(within(bunk).getByText("In use now")).toBeInTheDocument();
  });

  it("warns when a calendar has stopped answering", async () => {
    vi.mocked(ha.getHouse).mockResolvedValue(house({ ...CAL, unreadable: true }, true));
    render(<RoomCalendarsCard />);
    const bunk = await screen.findByRole("group", { name: "Bunk Room" });
    expect(
      within(bunk).getByText(
        "This calendar isn't answering, so the room is being treated as in use."
      )
    ).toBeInTheDocument();
    expect(within(bunk).queryByText("In use now")).toBeNull();
  });

  it("links a room to a calendar and changes how it follows it", async () => {
    render(<RoomCalendarsCard />);
    const den = await screen.findByRole("group", { name: "Den" });
    fireEvent.click(within(den).getByRole("button", { name: "pick calendar" }));
    await waitFor(() =>
      expect(ha.setRoomCalendar).toHaveBeenCalledWith("den", { entity_id: "calendar.custody" })
    );

    const bunk = screen.getByRole("group", { name: "Bunk Room" });
    await waitFor(() =>
      expect(within(bunk).getByLabelText("Only Events Containing")).not.toBeDisabled()
    );
    const match = within(bunk).getByLabelText("Only Events Containing");
    // Unchanged (after trimming) saves nothing.
    fireEvent.change(match, { target: { value: " Girls " } });
    fireEvent.blur(match);
    expect(match).toHaveValue("Girls");
    expect(ha.setRoomCalendar).toHaveBeenCalledTimes(1);
    fireEvent.change(match, { target: { value: " here " } });
    fireEvent.blur(match);
    await waitFor(() =>
      expect(ha.setRoomCalendar).toHaveBeenLastCalledWith("bunk", { match_text: "here" })
    );
    await waitFor(() =>
      expect(within(bunk).getByLabelText("Only Events Containing")).toHaveValue("here")
    );

    const lead = within(bunk).getByLabelText("Minutes ahead for Bunk Room");
    fireEvent.change(lead, { target: { value: "45" } });
    fireEvent.blur(lead);
    await waitFor(() =>
      expect(ha.setRoomCalendar).toHaveBeenLastCalledWith("bunk", { lead_min: 45 })
    );
  });

  it("stops following a calendar", async () => {
    render(<RoomCalendarsCard />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop Bunk Room following a calendar" })
    );
    await waitFor(() => expect(ha.clearRoomCalendar).toHaveBeenCalledWith("bunk"));
    const bunk = screen.getByRole("group", { name: "Bunk Room" });
    expect(await within(bunk).findByRole("button", { name: "pick calendar" })).toBeInTheDocument();
  });

  it("runs one change at a time, and puts back what is stored when one is refused", async () => {
    let finish!: (h: ha.House) => void;
    vi.mocked(ha.clearRoomCalendar).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<RoomCalendarsCard />);
    const stop = await screen.findByRole("button", {
      name: "Stop Bunk Room following a calendar",
    });
    fireEvent.click(stop);
    await waitFor(() => expect(stop).toBeDisabled());
    fireEvent.click(
      within(screen.getByRole("group", { name: "Den" })).getByRole("button", {
        name: "pick calendar",
      })
    );
    expect(ha.setRoomCalendar).not.toHaveBeenCalled();
    finish(house());
    await waitFor(() => expect(stop).not.toBeDisabled());

    vi.mocked(ha.setRoomCalendar).mockRejectedValueOnce(new Error("Not allowed"));
    const bunk = screen.getByRole("group", { name: "Bunk Room" });
    const match = within(bunk).getByLabelText("Only Events Containing");
    fireEvent.change(match, { target: { value: "x" } });
    fireEvent.blur(match);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    expect(within(bunk).getByLabelText("Only Events Containing")).toHaveValue("Girls");
    vi.mocked(ha.clearRoomCalendar).mockRejectedValueOnce("nope");
    fireEvent.click(stop);
    expect(await screen.findByText("Could not save the change")).toBeInTheDocument();
  });

  it("says so when it cannot load, when there are no rooms, and ignores late responses", async () => {
    vi.mocked(ha.getHouse).mockRejectedValueOnce(new Error("down"));
    const first = render(<RoomCalendarsCard />);
    expect(await screen.findByText("Could not load rooms and calendars.")).toBeInTheDocument();
    expect(screen.queryByText("Loading rooms…")).toBeNull();
    first.unmount();

    vi.mocked(api.getRooms).mockResolvedValueOnce([]);
    const second = render(<RoomCalendarsCard />);
    expect(await screen.findByText("Add rooms in My Home first.")).toBeInTheDocument();
    second.unmount();

    let resolve!: (h: ha.House) => void;
    let reject!: (e: Error) => void;
    vi.mocked(ha.getHouse)
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    render(<RoomCalendarsCard />).unmount();
    resolve(house());
    render(<RoomCalendarsCard />).unmount();
    reject(new Error("late"));
    await Promise.resolve();
    await Promise.resolve();
  });
});
