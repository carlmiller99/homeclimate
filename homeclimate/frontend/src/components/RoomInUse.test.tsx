import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as ha from "../houseApi";
import RoomInUse from "./RoomInUse";

vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  setRoomCalendar: vi.fn(),
  clearRoomCalendar: vi.fn(),
  setRoomSwitches: vi.fn(),
}));
vi.mock("./EntityPicker", () => ({
  default: ({ onSelect, domain }: { onSelect: (id: string) => void; domain: string }) => (
    <button type="button" onClick={() => onSelect(`${domain}.guests`)}>
      pick {domain}
    </button>
  ),
}));

const CAL: ha.RoomCalendar = { entity_id: "calendar.guests", match_text: "Stay", lead_min: 120 };
const ROOM = { id: "bunk", name: "Bunk Room" } as api.Room;

function house(calendar: ha.RoomCalendar | null = CAL, inUse = false): ha.House {
  return {
    house_heat_to: null,
    house_cool_to: null,
    min_gap: 3,
    low: 45,
    high: 95,
    rooms: [{ room_id: "bunk", in_use: inUse, use_schedules: true, use_presence: true, calendar }],
  } as ha.House;
}

function Harness({ initial }: { initial: ha.House }) {
  const [h, setH] = useState(initial);
  return <RoomInUse room={ROOM} house={h} onHouse={setH} />;
}
const radio = (name: string) => screen.getByRole("radio", { name });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ha.setRoomCalendar).mockImplementation(async (_id, patch) =>
    house({ ...CAL, ...patch })
  );
  vi.mocked(ha.clearRoomCalendar).mockResolvedValue(house(null, false));
  vi.mocked(ha.setRoomSwitches).mockImplementation(async (_id, patch) => house(null, patch.in_use));
});

describe("Whether a room is in use", () => {
  it("shows Always for a room in use by hand, and Never with what that means", () => {
    const first = render(<Harness initial={house(null, true)} />);
    expect(screen.getByRole("radiogroup", { name: "Bunk Room is in use" })).toBeInTheDocument();
    expect(radio("Always")).toBeChecked();
    expect(screen.queryByText(/Not in use: only a hold/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    first.unmount();
    render(<Harness initial={house(null, false)} />);
    expect(radio("Never")).toBeChecked();
    expect(screen.getByText(/Not in use: only a hold or its safety limits/)).toBeInTheDocument();
  });

  it("switches between Always and Never, and does nothing for the choice already made", async () => {
    render(<Harness initial={house(null, true)} />);
    fireEvent.click(radio("Always"));
    expect(ha.setRoomSwitches).not.toHaveBeenCalled();
    fireEvent.click(radio("Never"));
    await waitFor(() => expect(ha.setRoomSwitches).toHaveBeenCalledWith("bunk", { in_use: false }));
    await waitFor(() => expect(radio("Never")).toBeChecked());
    fireEvent.click(radio("Always"));
    await waitFor(() =>
      expect(ha.setRoomSwitches).toHaveBeenLastCalledWith("bunk", { in_use: true })
    );
    expect(ha.clearRoomCalendar).not.toHaveBeenCalled();
  });

  it("follows a calendar once one is picked, and says what it reports now", async () => {
    render(<Harness initial={house(null, true)} />);
    fireEvent.click(radio("When a Calendar Says So"));
    // Nothing is saved until a calendar is chosen.
    expect(radio("When a Calendar Says So")).toBeChecked();
    expect(ha.setRoomCalendar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "pick calendar" }));
    await waitFor(() =>
      expect(ha.setRoomCalendar).toHaveBeenCalledWith("bunk", { entity_id: "calendar.guests" })
    );
    expect(await screen.findByText("calendar.guests")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Not in use now");
    expect(screen.getByLabelText("Only Events Containing")).toHaveValue("Stay");
    expect(screen.getByLabelText("Minutes ahead for Bunk Room")).toHaveValue(120);
  });

  it("backs out of choosing a calendar without saving anything", () => {
    render(<Harness initial={house(null, true)} />);
    fireEvent.click(radio("When a Calendar Says So"));
    fireEvent.click(radio("Always"));
    expect(radio("Always")).toBeChecked();
    expect(screen.queryByRole("button", { name: "pick calendar" })).toBeNull();
  });

  it("says In use now, or that the calendar has stopped answering", () => {
    const first = render(<Harness initial={house(CAL, true)} />);
    expect(screen.getByRole("status")).toHaveTextContent("In use now");
    first.unmount();
    render(<Harness initial={house({ ...CAL, unreadable: true }, true)} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "This calendar isn't answering, so the room is being treated as in use."
    );
  });

  it("changes how a calendar is followed", async () => {
    render(<Harness initial={house()} />);
    const match = screen.getByLabelText("Only Events Containing");
    // Unchanged (after trimming) saves nothing.
    fireEvent.change(match, { target: { value: " Stay " } });
    fireEvent.blur(match);
    expect(match).toHaveValue("Stay");
    expect(ha.setRoomCalendar).not.toHaveBeenCalled();
    fireEvent.change(match, { target: { value: " here " } });
    fireEvent.blur(match);
    await waitFor(() =>
      expect(ha.setRoomCalendar).toHaveBeenLastCalledWith("bunk", { match_text: "here" })
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Only Events Containing")).toHaveValue("here")
    );
    const lead = screen.getByLabelText("Minutes ahead for Bunk Room");
    fireEvent.change(lead, { target: { value: "45" } });
    fireEvent.blur(lead);
    await waitFor(() =>
      expect(ha.setRoomCalendar).toHaveBeenLastCalledWith("bunk", { lead_min: 45 })
    );
  });

  it("stops following a calendar when Always or Never is chosen", async () => {
    // The room was not in use by hand before the calendar: Always turns it on.
    const first = render(<Harness initial={house()} />);
    fireEvent.click(radio("Always"));
    await waitFor(() => expect(ha.clearRoomCalendar).toHaveBeenCalledWith("bunk"));
    await waitFor(() => expect(ha.setRoomSwitches).toHaveBeenCalledWith("bunk", { in_use: true }));
    await waitFor(() => expect(radio("Always")).toBeChecked());
    first.unmount();
    // Never, for a room that is already off by hand, only drops the calendar.
    vi.mocked(ha.setRoomSwitches).mockClear();
    render(<Harness initial={house()} />);
    fireEvent.click(radio("Never"));
    await waitFor(() => expect(radio("Never")).toBeChecked());
    expect(ha.setRoomSwitches).not.toHaveBeenCalled();
  });

  it("runs one change at a time, and puts back what is stored when one is refused", async () => {
    let finish!: (h: ha.House) => void;
    vi.mocked(ha.setRoomCalendar).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<Harness initial={house()} />);
    const match = screen.getByLabelText("Only Events Containing");
    fireEvent.change(match, { target: { value: "first" } });
    fireEvent.blur(match);
    await waitFor(() => expect(radio("Never")).toBeDisabled());
    finish(house());
    await waitFor(() => expect(radio("Never")).not.toBeDisabled());

    vi.mocked(ha.setRoomCalendar).mockRejectedValueOnce(new Error("Not allowed"));
    fireEvent.change(screen.getByLabelText("Only Events Containing"), { target: { value: "x" } });
    fireEvent.blur(screen.getByLabelText("Only Events Containing"));
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    expect(screen.getByLabelText("Only Events Containing")).toHaveValue("Stay");
    vi.mocked(ha.clearRoomCalendar).mockRejectedValueOnce("nope");
    fireEvent.click(radio("Never"));
    expect(await screen.findByText("Could not save the change")).toBeInTheDocument();
  });
});
