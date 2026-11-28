import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RoomFollowSwitches from "./RoomFollowSwitches";
import * as ha from "../houseApi";

vi.mock("../houseApi", async (orig) => ({
  ...(await orig<typeof import("../houseApi")>()),
  setRoomSwitches: vi.fn(),
}));

const HOUSE = { rooms: [] } as unknown as ha.House;
const onSaved = vi.fn();
const show = (switches: ha.RoomSwitches) =>
  render(<RoomFollowSwitches roomId="kitchen" switches={switches} onSaved={onSaved} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ha.setRoomSwitches).mockResolvedValue(HOUSE);
});

describe("Smart Control → Rooms → what a room follows", () => {
  it("flips each switch and says what it means", async () => {
    show(ha.ALL_ON);
    expect(
      screen.getByText("A schedule gives the room its own target while it is active.")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Follow Its Schedules" }));
    await waitFor(() =>
      expect(ha.setRoomSwitches).toHaveBeenCalledWith("kitchen", { use_schedules: false })
    );
    expect(onSaved).toHaveBeenCalledWith(HOUSE);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Follow Occupancy" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("switch", { name: "Follow Occupancy" }));
    await waitFor(() =>
      expect(ha.setRoomSwitches).toHaveBeenLastCalledWith("kitchen", { use_presence: false })
    );
  });

  it("says what each switch off means", () => {
    show({ in_use: true, use_schedules: false, use_presence: false });
    expect(screen.getByText(/^The room's schedules are skipped, not deleted/)).toBeInTheDocument();
    expect(screen.getByText(/^Occupancy sets no target/)).toBeInTheDocument();
  });

  it("greys both out for a room that is not in use", () => {
    show({ in_use: false, use_schedules: true, use_presence: true });
    expect(screen.getByRole("switch", { name: "Follow Its Schedules" })).toBeDisabled();
    expect(screen.getAllByText("Not used while the room is not in use.")).toHaveLength(2);
  });

  it("reports a switch that could not be saved", async () => {
    vi.mocked(ha.setRoomSwitches).mockRejectedValueOnce(new Error("Room not found"));
    show(ha.ALL_ON);
    fireEvent.click(screen.getByRole("switch", { name: "Follow Occupancy" }));
    expect(await screen.findByText("Room not found")).toBeInTheDocument();
    vi.mocked(ha.setRoomSwitches).mockRejectedValueOnce("nope");
    fireEvent.click(screen.getByRole("switch", { name: "Follow Occupancy" }));
    expect(await screen.findByText("Could not save the change")).toBeInTheDocument();
  });
});
