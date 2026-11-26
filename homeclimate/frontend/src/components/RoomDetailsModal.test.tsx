import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RoomDetailsModal, { type SensorReading } from "./RoomDetailsModal";
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
    onOptions: vi.fn(),
    onClearedPresence: vi.fn(),
    onRoomSaved: vi.fn(),
    onClose: vi.fn(),
  };
  const readings: SensorReading[] = [
    { entity_id: "sensor.game_1", value: 68.4, stale: false },
    { entity_id: "sensor.game_2", value: 61, stale: true },
    { entity_id: "sensor.game_3", value: null, stale: false },
  ];
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <RoomDetailsModal
        level={ROOM}
        house={HOUSE}
        temp={68.4}
        readings={readings}
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
  it("offers the occupied temperature when it has the room, and not without it", () => {
    show();
    expect(screen.queryByRole("region", { name: "When occupied" })).not.toBeInTheDocument();
  });

  it("shows the room's occupied temperature", () => {
    show({
      room: { id: "r1", name: "Game Room", system_wide_temp: 70, presence_cool_to: null } as never,
    });
    const block = screen.getByRole("region", { name: "When occupied" });
    expect(block).toHaveTextContent("Kept here while someone is in the room");
    expect(screen.getByLabelText(/^Temperature/)).toHaveValue(70);
  });

  it("shows where the room is, its reading, what it follows and each sensor", () => {
    show();
    const dialog = screen.getByRole("dialog", { name: "Game Room details" });
    expect(dialog).toHaveTextContent("Upstairs, Main House");
    expect(dialog).toHaveTextContent("68.4°F");
    expect(dialog).toHaveTextContent("Asking for heating or cooling now.");
    expect(screen.getByText("Follows Upstairs: 71 to 72°F")).toBeInTheDocument();
    const sensors = screen.getByRole("region", { name: "Sensors" });
    expect(sensors).toHaveTextContent("sensor.game_168.4°F");
    expect(sensors).toHaveTextContent("sensor.game_2Not reporting, left out of the average");
    expect(sensors).toHaveTextContent("sensor.game_3No reading");
  });

  it("shows readings in the house's unit", () => {
    show({}, "C");
    expect(screen.getByRole("dialog", { name: "Game Room details" })).toHaveTextContent("20.2°C");
  });

  it("starts or cancels a hold, opens the options, and closes", () => {
    const h = show();
    fireEvent.click(screen.getByRole("button", { name: "Start a Hold" }));
    expect(h.onHold).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "In Use, Schedules and Occupancy" }));
    expect(h.onOptions).toHaveBeenCalled();
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
    expect(vents).toHaveTextContent("cover.game_a Open");
    expect(vents).toHaveTextContent("cover.game_b Closed");
    // Nobody was seen here, so there is no occupancy to clear.
    expect(screen.queryByRole("region", { name: "Occupancy" })).toBeNull();
  });

  it("offers to cancel a hold that is on, and copes with no reading or sensors", () => {
    const h = show({ held: true, temp: null, readings: [], level: { ...ROOM, parent: undefined } });
    expect(screen.getByText(/This room is on hold/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Hold" }));
    expect(h.onCancelHold).toHaveBeenCalled();
    expect(screen.getByText("No reading")).toBeInTheDocument();
    expect(
      screen.getByText(/No temperature sensors\. This room goes by its thermostat/)
    ).toBeInTheDocument();
  });
});
