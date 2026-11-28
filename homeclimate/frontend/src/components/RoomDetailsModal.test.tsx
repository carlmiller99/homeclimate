import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RoomDetailsModal from "./RoomDetailsModal";
import { buildUnitContext, UnitContext } from "../contexts";
import type { House } from "../houseApi";
import type { TargetLevel } from "./TargetsCard";

const HOUSE = {
  house_heat_to: null,
  house_cool_to: null,
  targets: [{ scope: "zone", scope_id: "climate.up", house_heat_to: 71, house_cool_to: 72 }],
} as unknown as House;
const BUILDING: TargetLevel = { scope: "building", id: "b1", name: "Main House" };
const ZONE: TargetLevel = { scope: "zone", id: "climate.up", name: "Upstairs", parent: BUILDING };
const ROOM: TargetLevel = { scope: "room", id: "r1", name: "Game Room", parent: ZONE };

function show(over: Partial<Parameters<typeof RoomDetailsModal>[0]> = {}, unit: "F" | "C" = "F") {
  const handlers = {
    onSaved: vi.fn(),
    onHold: vi.fn(),
    onCancelHold: vi.fn(),
    onClearedPresence: vi.fn(),
    onRoomSaved: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <RoomDetailsModal
        level={ROOM}
        house={HOUSE}
        temp={68.4}
        held={false}
        status="Asking for heating or cooling now."
        {...handlers}
        {...over}
      />
    </UnitContext.Provider>
  );
  return handlers;
}

describe("Room details", () => {
  it("leaves When Occupied out without the room, and both occupancy parts without the house", () => {
    show({ house: null });
    expect(screen.queryByText("When Occupied")).not.toBeInTheDocument();
    expect(screen.queryByText("When Unoccupied")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Baseline temperature target" })).toBeNull();
  });

  it("shows the baseline it follows, and its occupancy targets folded away", () => {
    show({
      room: { id: "r1", name: "Game Room", system_wide_temp: 71, presence_cool_to: 74 } as never,
    });
    const baseline = screen.getByRole("region", { name: "Baseline temperature target" });
    expect(baseline).toHaveTextContent(
      "Leave empty to follow Upstairs: 71 to 72°F. A hold, a schedule or occupancy comes first."
    );
    expect(screen.getByLabelText("Heating Target for Game Room (°F)")).toHaveAttribute(
      "placeholder",
      "71"
    );
    // Folded away, each says what it is set to.
    const occupied = screen.getByText("When Occupied").closest("details") as HTMLElement;
    expect(occupied).not.toHaveAttribute("open");
    expect(occupied).toHaveTextContent("71 to 74°F");
    expect(occupied).toHaveTextContent(
      "While someone is in the room. Leave empty and occupancy does not change its temperature."
    );
    expect(screen.getByLabelText("Heating Target when Game Room is occupied (°F)")).toHaveValue(71);
    const empty = screen.getByText("When Unoccupied").closest("details") as HTMLElement;
    expect(empty).not.toHaveAttribute("open");
    expect(empty).toHaveTextContent("Not set");
    expect(empty).toHaveTextContent(
      "While its occupancy sensors see nobody. Leave empty and the room keeps its baseline."
    );
    expect(
      screen.getByLabelText("Heating Target for Game Room when unoccupied (°F)")
    ).toHaveAttribute("placeholder", "71");
  });

  it("shows one occupied temperature, and the unoccupied targets that are set", () => {
    show({
      house: {
        ...HOUSE,
        targets: [
          ...HOUSE.targets!,
          { scope: "unoccupied", scope_id: "r1", house_heat_to: 64, house_cool_to: 78 },
        ],
      } as House,
      room: { id: "r1", name: "Game Room", system_wide_temp: 70, presence_cool_to: null } as never,
    });
    const occupied = screen.getByText("When Occupied").closest("details") as HTMLElement;
    expect(occupied).toHaveTextContent("70.0°F");
    const empty = screen.getByText("When Unoccupied").closest("details") as HTMLElement;
    expect(empty).toHaveTextContent("64 to 78°F");
  });

  it("says when there is nothing above the room to follow", () => {
    show({ house: { ...HOUSE, targets: [] } as House });
    expect(screen.getByRole("region", { name: "Baseline temperature target" })).toHaveTextContent(
      "Leave empty and the room is kept at nothing in particular."
    );
  });

  it("shows where the room is and its reading, in the house's unit", () => {
    show();
    const dialog = screen.getByRole("dialog", { name: "Game Room details" });
    expect(dialog).toHaveTextContent("Upstairs, Main House");
    expect(dialog).toHaveTextContent("68.4°F");
    expect(dialog).toHaveTextContent("Asking for heating or cooling now.");
    // Sensors and what the room follows are set elsewhere now.
    expect(screen.queryByRole("region", { name: "Sensors" })).toBeNull();
  });

  it("shows readings in the house's unit", () => {
    show({}, "C");
    expect(screen.getByRole("dialog", { name: "Game Room details" })).toHaveTextContent("20.2°C");
  });

  it("starts or cancels a hold, and closes", () => {
    const h = show();
    fireEvent.click(screen.getByRole("button", { name: "Start a Hold" }));
    expect(h.onHold).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    // Clicking the backdrop closes it; clicking inside does not.
    fireEvent.click(screen.getByText("68.4°F", { selector: ".room-details-temp" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog", { name: "Game Room details" }));
    expect(h.onClose).toHaveBeenCalledTimes(2);
  });

  it("lists the vents and what the room is asking for", () => {
    show({
      active: {
        room_id: "r1",
        avg_temp: 68.4,
        target_temp: 71,
        presence_active: false,
        vent_states: { "cover.game_a": "open", "cover.game_b": "closed" },
      },
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("Asking for 71.0°F.");
    const vents = screen.getByRole("region", { name: "Vents" });
    expect(vents).toHaveTextContent("1 of 2 open");
    expect(vents).toHaveTextContent("Game A Open");
    expect(vents).toHaveTextContent("Game B Closed");
    // Nobody was seen here, so there is no occupancy to clear.
    expect(screen.queryByRole("region", { name: "Occupancy" })).toBeNull();
  });

  it("offers to cancel a hold that is on, and copes with no reading", () => {
    const h = show({ held: true, temp: null, level: { ...ROOM, parent: undefined } });
    expect(screen.getByText(/On hold: kept at one temperature/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Hold" }));
    expect(h.onCancelHold).toHaveBeenCalled();
    expect(screen.getByText("No reading")).toBeInTheDocument();
  });
});
