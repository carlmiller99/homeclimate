import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OccupiedTargets from "./OccupiedTargets";
import * as api from "../api";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../api");

const room = (over: Partial<api.Room> = {}) =>
  ({
    id: "bunk",
    name: "Bunk Room",
    system_wide_temp: 72,
    presence_cool_to: null,
    ...over,
  }) as api.Room;

const onSaved = vi.fn();
const show = (r: api.Room, unit: "F" | "C" = "F") =>
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <OccupiedTargets room={r} onSaved={onSaved} />
    </UnitContext.Provider>
  );
const temp = () => screen.getByLabelText(/^Temperature/);
const coolTo = () => screen.getByLabelText(/^Cool To/);
const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.updateRoom).mockImplementation(async (_id, body) =>
    room(body as Partial<api.Room>)
  );
});

describe("Dashboard → a room → When Occupied", () => {
  it("shows what is stored and saves a temperature with a Cool To", async () => {
    const view = show(room());
    expect(temp()).toHaveValue(72);
    expect(coolTo()).toHaveValue(null);
    expect(save()).toBeDisabled();
    fireEvent.change(temp(), { target: { value: "68" } });
    fireEvent.change(coolTo(), { target: { value: "75" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenCalledWith("bunk", {
        system_wide_temp: 68,
        presence_cool_to: 75,
      })
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ system_wide_temp: 68 }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // Typed while the page is still reading the saved room back: it is kept.
    fireEvent.change(coolTo(), { target: { value: "76" } });
    view.rerender(
      <UnitContext.Provider value={buildUnitContext("F")}>
        <OccupiedTargets
          room={room({ system_wide_temp: 68, presence_cool_to: 75 })}
          onSaved={onSaved}
        />
      </UnitContext.Provider>
    );
    expect(coolTo()).toHaveValue(76);
  });

  it("takes a Cool To away, and clears both when the temperature is emptied", async () => {
    const view = show(room({ system_wide_temp: 68, presence_cool_to: 74 }));
    expect(coolTo()).toHaveValue(74);
    fireEvent.change(coolTo(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenLastCalledWith("bunk", {
        system_wide_temp: 68,
        presence_cool_to: null,
      })
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // The page then hands back the room as stored: nothing typed is lost.
    view.rerender(
      <UnitContext.Provider value={buildUnitContext("F")}>
        <OccupiedTargets room={room({ system_wide_temp: 68 })} onSaved={onSaved} />
      </UnitContext.Provider>
    );
    expect(temp()).toHaveValue(68);
    fireEvent.change(temp(), { target: { value: "" } });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenLastCalledWith("bunk", {
        system_wide_temp: null,
        presence_cool_to: null,
      })
    );
  });

  it("refuses a Cool To with no temperature, and a temperature out of range", async () => {
    show(room({ system_wide_temp: null }));
    expect(temp()).toHaveValue(null);
    fireEvent.change(coolTo(), { target: { value: "75" } });
    fireEvent.click(save());
    expect(screen.getByText("Cool To needs a temperature to pair with.")).toBeInTheDocument();
    fireEvent.change(temp(), { target: { value: "95" } });
    fireEvent.click(save());
    expect(screen.getByText("Use a temperature from 40.0°F to 90.0°F.")).toBeInTheDocument();
    expect(api.updateRoom).not.toHaveBeenCalled();
  });

  it("sends what a Celsius house typed, and states limits the backend accepts (#231, #521)", async () => {
    show(room(), "C");
    // 72 °F reads 22.2 °C.
    expect(temp()).toHaveValue(22.2);
    expect(screen.getByText("Temperature (°C)")).toBeInTheDocument();
    // 4.4 °C is 39.92 °F, which the backend refuses: the limit shown is 4.5.
    fireEvent.change(temp(), { target: { value: "4.4" } });
    fireEvent.click(save());
    expect(screen.getByText("Use a temperature from 4.5°C to 32.2°C.")).toBeInTheDocument();
    fireEvent.change(temp(), { target: { value: "22" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenCalledWith("bunk", {
        system_wide_temp: 22,
        presence_cool_to: null,
      })
    );
  });

  it("reports a refused save and keeps what was typed", async () => {
    vi.mocked(api.updateRoom).mockRejectedValueOnce(new Error("Cool To must be above the target"));
    show(room());
    fireEvent.change(coolTo(), { target: { value: "70" } });
    fireEvent.click(save());
    expect(await screen.findByText("Cool To must be above the target")).toBeInTheDocument();
    expect(coolTo()).toHaveValue(70);
    vi.mocked(api.updateRoom).mockRejectedValueOnce("nope");
    fireEvent.click(save());
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
  });
});
