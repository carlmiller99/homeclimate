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
const wrap = (r: api.Room, unit: "F" | "C" = "F") => (
  <UnitContext.Provider value={buildUnitContext(unit)}>
    <OccupiedTargets room={r} onSaved={onSaved} />
  </UnitContext.Provider>
);
const show = (r: api.Room, unit: "F" | "C" = "F") => render(wrap(r, unit));
const heat = () => screen.getByLabelText(/^Heating Target when Bunk Room/);
const cool = () => screen.getByLabelText(/^Cooling Target when Bunk Room/);
const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.updateRoom).mockImplementation(async (_id, body) =>
    room(body as Partial<api.Room>)
  );
});

describe("Dashboard → a room → When Occupied", () => {
  it("shows one temperature in both fields and saves a range", async () => {
    const view = show(room());
    expect(heat()).toHaveValue(72);
    expect(cool()).toHaveValue(72);
    expect(save()).toBeDisabled();
    fireEvent.change(heat(), { target: { value: "68" } });
    fireEvent.change(cool(), { target: { value: "75" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenCalledWith("bunk", {
        system_wide_temp: 68,
        presence_cool_to: 75,
      })
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ system_wide_temp: 68 }));
    await waitFor(() => expect(save()).toBeDisabled());
    // Typed while the page is still reading the saved room back: it is kept.
    fireEvent.change(cool(), { target: { value: "76" } });
    view.rerender(wrap(room({ system_wide_temp: 68, presence_cool_to: 75 })));
    expect(cool()).toHaveValue(76);
    // Changed somewhere else: what is stored is shown.
    view.rerender(wrap(room({ system_wide_temp: 66, presence_cool_to: 70 })));
    expect(heat()).toHaveValue(66);
    expect(cool()).toHaveValue(70);
  });

  it("saves the same number in both as one temperature, and empty as nothing", async () => {
    show(room({ system_wide_temp: 68, presence_cool_to: 74 }));
    fireEvent.change(cool(), { target: { value: "68" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenLastCalledWith("bunk", {
        system_wide_temp: 68,
        presence_cool_to: null,
      })
    );
    await waitFor(() => expect(save()).toBeDisabled());
    expect(cool()).toHaveValue(68);
    fireEvent.change(heat(), { target: { value: "70" } });
    fireEvent.change(cool(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenLastCalledWith("bunk", {
        system_wide_temp: 70,
        presence_cool_to: null,
      })
    );
    await waitFor(() => expect(save()).toBeDisabled());
    fireEvent.change(heat(), { target: { value: "" } });
    fireEvent.change(cool(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenLastCalledWith("bunk", {
        system_wide_temp: null,
        presence_cool_to: null,
      })
    );
  });

  it("refuses a cooling target alone, crossed targets, and targets out of range", async () => {
    show(room({ system_wide_temp: null }));
    expect(heat()).toHaveValue(null);
    expect(cool()).toHaveValue(null);
    fireEvent.change(cool(), { target: { value: "75" } });
    fireEvent.click(save());
    expect(
      screen.getByText("Add a Heating Target too. The same number in both keeps one temperature.")
    ).toBeInTheDocument();
    fireEvent.change(heat(), { target: { value: "76" } });
    fireEvent.click(save());
    expect(
      screen.getByText("The Cooling Target cannot be below the Heating Target.")
    ).toBeInTheDocument();
    fireEvent.change(heat(), { target: { value: "70" } });
    fireEvent.change(cool(), { target: { value: "95" } });
    fireEvent.click(save());
    expect(screen.getByText("Use temperatures from 40.0°F to 90.0°F.")).toBeInTheDocument();
    fireEvent.change(heat(), { target: { value: "30" } });
    fireEvent.change(cool(), { target: { value: "" } });
    fireEvent.click(save());
    expect(screen.getByText("Use temperatures from 40.0°F to 90.0°F.")).toBeInTheDocument();
    expect(api.updateRoom).not.toHaveBeenCalled();
  });

  it("sends what a Celsius house typed, and states limits the backend accepts (#231, #521)", async () => {
    show(room(), "C");
    // 72 °F reads 22.2 °C.
    expect(heat()).toHaveValue(22.2);
    expect(screen.getByText("Heating Target (°C)")).toBeInTheDocument();
    // 4.4 °C is 39.92 °F, which the backend refuses: the limit shown is 4.5.
    fireEvent.change(heat(), { target: { value: "4.4" } });
    fireEvent.change(cool(), { target: { value: "" } });
    fireEvent.click(save());
    expect(screen.getByText("Use temperatures from 4.5°C to 32.2°C.")).toBeInTheDocument();
    fireEvent.change(heat(), { target: { value: "22" } });
    fireEvent.click(save());
    await waitFor(() =>
      expect(api.updateRoom).toHaveBeenCalledWith("bunk", {
        system_wide_temp: 22,
        presence_cool_to: null,
      })
    );
  });

  it("reports a refused save and keeps what was typed", async () => {
    vi.mocked(api.updateRoom).mockRejectedValueOnce(new Error("Too close together"));
    show(room());
    fireEvent.change(cool(), { target: { value: "73" } });
    fireEvent.click(save());
    expect(await screen.findByText("Too close together")).toBeInTheDocument();
    expect(cool()).toHaveValue(73);
    vi.mocked(api.updateRoom).mockRejectedValueOnce("nope");
    fireEvent.click(save());
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
  });
});
