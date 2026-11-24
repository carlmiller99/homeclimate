import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as sh from "../shadesApi";
import ShadesSection from "./ShadesSection";

vi.mock("../shadesApi", async (orig) => ({
  ...(await orig<typeof import("../shadesApi")>()),
  getShades: vi.fn(),
  updateShadeSettings: vi.fn(),
  saveShade: vi.fn(),
  deleteShade: vi.fn(),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getHAEntities: vi.fn(),
}));

const ROOMS = [
  { id: "r1", name: "Bunk Room", thermostat_entity_id: "climate.up" },
  { id: "r2", name: "Craft Room", thermostat_entity_id: "climate.up" },
] as api.Room[];

const SETTINGS: sh.ShadeSettings = {
  auto_enabled: true,
  skip_occupied: true,
  daylight_only: true,
  close_night_heat: false,
  respect_manual: true,
  manual_hold_min: 120,
  min_move_min: 30,
  quiet_hours: false,
  quiet_start: "20:00",
  quiet_end: "07:00",
  weather_entity: "",
};

const SHADE: sh.Shade = {
  entity_id: "cover.bunk_shade",
  name: "Bunk Shade",
  room_id: "r1",
  facing: "S",
  never_control: false,
  quiet_hours: false,
  open_position: null,
  closed_position: null,
  state: "open",
  reason: "Sunlit and heating, so opened.",
  last_moved_at: null,
  hold_until: null,
};

function data(over: Partial<sh.Shades> = {}): sh.Shades {
  return {
    settings: SETTINGS,
    sun: { elevation: 34, azimuth: 160, cloud_pct: null },
    shades: [
      SHADE,
      {
        ...SHADE,
        entity_id: "cover.x",
        name: "Lost Shade",
        room_id: "gone",
        reason: "",
        state: "moving",
        open_position: 60,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sh.getShades).mockResolvedValue(data());
  vi.mocked(sh.updateShadeSettings).mockImplementation(async (patch) =>
    data({ settings: { ...SETTINGS, ...patch } })
  );
  vi.mocked(sh.saveShade).mockResolvedValue(data());
  vi.mocked(sh.deleteShade).mockResolvedValue(data({ shades: [] }));
  vi.mocked(api.getHAEntities).mockImplementation(async (domain) =>
    domain === "weather"
      ? [{ entity_id: "weather.home", friendly_name: "Home", state: "sunny" }]
      : [{ entity_id: "cover.new_shade", friendly_name: "New Shade", state: "open" }]
  );
});

async function ready() {
  render(<ShadesSection rooms={ROOMS} />);
  await screen.findByText("Bunk Shade");
}

describe("Shades section", () => {
  it("loads, describes the sun and each shade", async () => {
    render(<ShadesSection rooms={ROOMS} />);
    expect(screen.getByText("Loading shades…")).toBeInTheDocument();
    await screen.findByText("Bunk Shade");
    expect(screen.getByText("Sun 34° up, from the south-southeast.")).toBeInTheDocument();
    expect(screen.getByText("Bunk Room. Sunlit and heating, so opened.")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the next check.")).toBeInTheDocument();
    expect(screen.getByText("Moving")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Bunk Shade faces S, sun at 160°" })
    ).toBeInTheDocument();
  });

  it("reports a failed load and ignores late answers", async () => {
    vi.mocked(sh.getShades).mockRejectedValueOnce(new Error("x"));
    const first = render(<ShadesSection rooms={ROOMS} />);
    expect(await screen.findByText("Could not load shades.")).toBeInTheDocument();
    first.unmount();
    let resolve: (d: sh.Shades) => void = () => {};
    vi.mocked(sh.getShades).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const second = render(<ShadesSection rooms={ROOMS} />);
    second.unmount();
    resolve(data());
    let reject: (e: Error) => void = () => {};
    vi.mocked(sh.getShades).mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    const third = render(<ShadesSection rooms={ROOMS} />);
    third.unmount();
    reject(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByText("Could not load shades.")).toBeNull();
  });

  it("shows the empty state and a sun without a dial position", async () => {
    vi.mocked(sh.getShades).mockResolvedValue(
      data({ shades: [], sun: { elevation: null, azimuth: null, cloud_pct: null } })
    );
    render(<ShadesSection rooms={ROOMS} />);
    expect(await screen.findByText(/No shades yet/)).toBeInTheDocument();
    expect(screen.getByText("Sun position unknown.")).toBeInTheDocument();
  });

  it("follows saved positions and an unknown sun", async () => {
    vi.mocked(sh.getShades).mockResolvedValue(
      data({ sun: { elevation: null, azimuth: null, cloud_pct: null } })
    );
    vi.mocked(sh.saveShade)
      .mockResolvedValueOnce(data({ shades: [{ ...SHADE, closed_position: 10 }] }))
      .mockResolvedValueOnce(data({ shades: [{ ...SHADE, closed_position: null }] }));
    await ready();
    expect(screen.getByRole("img", { name: "Bunk Shade faces S" })).toBeInTheDocument();
    const closed = screen.getAllByLabelText("Closed Position")[0];
    fireEvent.change(closed, { target: { value: "250" } });
    fireEvent.blur(closed);
    expect(closed).toHaveValue(null);
    fireEvent.change(closed, { target: { value: "10" } });
    fireEvent.blur(closed);
    await waitFor(() => expect(screen.getAllByLabelText("Closed Position")[0]).toHaveValue(10));
    fireEvent.change(screen.getAllByLabelText("Closed Position")[0], { target: { value: "" } });
    fireEvent.blur(screen.getAllByLabelText("Closed Position")[0]);
    await waitFor(() => expect(screen.getAllByLabelText("Closed Position")[0]).toHaveValue(null));
  });

  it("saves every setting", async () => {
    await ready();
    for (const [label, key] of [
      ["Automatically Control Shades to Optimize Solar Effects", "auto_enabled"],
      ["Do Not Control Shades in an Occupied Room", "skip_occupied"],
      ["Only Between Sunrise and Sunset", "daylight_only"],
      ["Close at Night in Heat Mode", "close_night_heat"],
      ["Respect Manual Moves For", "respect_manual"],
      ["Quiet Hours", "quiet_hours"],
    ] as const) {
      fireEvent.click(screen.getByLabelText(label));
      await waitFor(() =>
        expect(sh.updateShadeSettings).toHaveBeenLastCalledWith({ [key]: !SETTINGS[key] })
      );
    }
    vi.mocked(sh.updateShadeSettings).mockResolvedValue(
      data({ settings: { ...SETTINGS, quiet_hours: true } })
    );
    fireEvent.click(screen.getByLabelText("Quiet Hours"));
    await waitFor(() => expect(screen.getByLabelText("Quiet hours start")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Quiet hours start"), { target: { value: "21:00" } });
    fireEvent.change(screen.getByLabelText("Quiet hours end"), { target: { value: "06:30" } });
    fireEvent.change(screen.getByLabelText("Quiet hours end"), { target: { value: "" } });
    expect(sh.updateShadeSettings).toHaveBeenCalledWith({ quiet_start: "21:00" });
    expect(sh.updateShadeSettings).toHaveBeenCalledWith({ quiet_end: "06:30" });

    const hold = screen.getByLabelText("Manual move hold in minutes");
    fireEvent.change(hold, { target: { value: "60" } });
    fireEvent.blur(hold);
    expect(sh.updateShadeSettings).toHaveBeenCalledWith({ manual_hold_min: 60 });
    const gap = screen.getByLabelText("Minimum time between moves in minutes");
    fireEvent.change(gap, { target: { value: "45" } });
    fireEvent.blur(gap);
    expect(sh.updateShadeSettings).toHaveBeenCalledWith({ min_move_min: 45 });

    vi.mocked(sh.updateShadeSettings).mockResolvedValueOnce(
      data({ settings: { ...SETTINGS, weather_entity: "weather.home" } })
    );
    fireEvent.focus(screen.getByPlaceholderText("Not set"));
    fireEvent.mouseDown(await screen.findByText("Home"));
    await waitFor(() =>
      expect(sh.updateShadeSettings).toHaveBeenCalledWith({ weather_entity: "weather.home" })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(sh.updateShadeSettings).toHaveBeenLastCalledWith({ weather_entity: "" });

    vi.mocked(sh.updateShadeSettings).mockRejectedValueOnce(new Error("min_move_min is wrong"));
    fireEvent.click(screen.getByLabelText("Quiet Hours"));
    expect(await screen.findByText("min_move_min is wrong")).toBeInTheDocument();
    vi.mocked(sh.updateShadeSettings).mockRejectedValueOnce(7);
    fireEvent.click(screen.getByLabelText("Quiet Hours"));
    expect(await screen.findByText("Could not save the setting")).toBeInTheDocument();
  });

  it("changes, removes and adds shades", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText("Which way Bunk Shade's window faces"), {
      target: { value: "SW" },
    });
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.bunk_shade", { facing: "SW" });
    const row = screen
      .getByLabelText("Which way Bunk Shade's window faces")
      .closest(".shade-row") as HTMLElement;
    fireEvent.click(within(row).getByLabelText("Quiet Hours Apply"));
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.bunk_shade", { quiet_hours: true });
    fireEvent.click(within(row).getByLabelText("Never Control This Shade"));
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.bunk_shade", { never_control: true });

    const openPos = within(row).getByLabelText("Open Position");
    fireEvent.change(openPos, { target: { value: "70" } });
    fireEvent.blur(openPos);
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.bunk_shade", { open_position: 70 });
    vi.mocked(sh.saveShade).mockClear();
    for (const v of ["101", "1.5", ""]) {
      fireEvent.change(openPos, { target: { value: v } });
      fireEvent.blur(openPos);
    }
    expect(sh.saveShade).not.toHaveBeenCalled();

    const lostRow = screen
      .getByLabelText("Which way Lost Shade's window faces")
      .closest(".shade-row") as HTMLElement;
    const lostOpen = within(lostRow).getByLabelText("Open Position");
    expect(lostOpen).toHaveValue(60);
    fireEvent.change(lostOpen, { target: { value: "" } });
    fireEvent.blur(lostOpen);
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.x", { open_position: null });
    fireEvent.change(lostOpen, { target: { value: "60" } });
    fireEvent.blur(lostOpen);
    expect(sh.saveShade).toHaveBeenCalledTimes(1);
    const closedPos = within(row).getByLabelText("Closed Position");
    fireEvent.change(closedPos, { target: { value: "5" } });
    fireEvent.blur(closedPos);
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.bunk_shade", { closed_position: 5 });

    vi.mocked(sh.saveShade).mockRejectedValueOnce(new Error("Window Faces must be one of"));
    fireEvent.change(screen.getByLabelText("Which way Bunk Shade's window faces"), {
      target: { value: "N" },
    });
    expect(await screen.findByText("Window Faces must be one of")).toBeInTheDocument();
    vi.mocked(sh.saveShade).mockRejectedValueOnce(null);
    fireEvent.change(screen.getByLabelText("Which way Bunk Shade's window faces"), {
      target: { value: "E" },
    });
    expect(await screen.findByText("Could not save the shade")).toBeInTheDocument();

    vi.mocked(sh.deleteShade).mockRejectedValueOnce(new Error("Shade not found"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Bunk Shade" }));
    expect(await screen.findByText("Shade not found")).toBeInTheDocument();
    vi.mocked(sh.deleteShade).mockRejectedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Remove Bunk Shade" }));
    expect(await screen.findByText("Could not remove the shade")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Shade" }));
    const group = screen.getByRole("group", { name: "Add Shade" });
    const add = within(group).getByRole("button", { name: "Add Shade" });
    expect(add).toBeDisabled();
    fireEvent.focus(within(group).getByPlaceholderText("Search shades…"));
    fireEvent.mouseDown(await within(group).findByText("New Shade"));
    fireEvent.click(within(group).getByRole("button", { name: "Change" }));
    fireEvent.focus(within(group).getByPlaceholderText("Search shades…"));
    fireEvent.mouseDown(await within(group).findByText("New Shade"));
    fireEvent.change(within(group).getByLabelText("Room"), { target: { value: "r2" } });
    fireEvent.change(within(group).getByLabelText("Window Faces"), { target: { value: "W" } });
    vi.mocked(sh.saveShade).mockRejectedValueOnce(new Error("That cover is already a vent"));
    fireEvent.click(add);
    expect(await screen.findByText("That cover is already a vent")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Add Shade" })).toBeInTheDocument();
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add Shade" })).toBeNull());
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.new_shade", {
      room_id: "r2",
      facing: "W",
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Shade" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Add Shade" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Bunk Shade" }));
    expect(await screen.findByText(/No shades yet/)).toBeInTheDocument();
  });
});

describe("shadesApi", () => {
  it("calls the shade endpoints", async () => {
    const real = await vi.importActual<typeof import("../shadesApi")>("../shadesApi");
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    await real.getShades();
    await real.updateShadeSettings({ min_move_min: 10 });
    await real.saveShade("cover.a b", { facing: "N" });
    await real.deleteShade("cover.a");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET"])).toEqual([
      ["/api/shades", "GET"],
      ["/api/shades/settings", "PUT"],
      ["/api/shades/cover.a%20b", "PUT"],
      ["/api/shades/cover.a", "DELETE"],
    ]);
    vi.unstubAllGlobals();
  });

  it("names the sun's direction", async () => {
    const real = await vi.importActual<typeof import("../shadesApi")>("../shadesApi");
    expect(real.compassName(0)).toBe("north");
    expect(real.compassName(-90)).toBe("west");
    expect(real.compassName(359)).toBe("north");
    expect(real.describeSun({ elevation: -3, azimuth: 270, cloud_pct: null })).toBe(
      "The sun is down."
    );
    expect(real.describeSun({ elevation: 20.4, azimuth: 90, cloud_pct: 42.6 })).toBe(
      "Sun 20° up, from the east. Cloud cover 43%."
    );
  });
});
