import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as sh from "../shadesApi";
import { MemoryRouter } from "react-router";
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
  predictive_close: false,
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
  render(
    <MemoryRouter>
      <ShadesSection rooms={ROOMS} />
    </MemoryRouter>
  );
  await screen.findByText("Bunk Shade");
}

describe("Shades section", () => {
  it("loads, describes the sun and each shade", async () => {
    render(
      <MemoryRouter>
        <ShadesSection rooms={ROOMS} />
      </MemoryRouter>
    );
    expect(screen.getByText("Loading shades…")).toBeInTheDocument();
    await screen.findByText("Bunk Shade");
    expect(screen.getByText("Sun 34° up, from the south-southeast.")).toBeInTheDocument();
    expect(screen.getByText("Bunk Room. Sunlit and heating, so opened.")).toBeInTheDocument();
    // A shade whose room is gone still shows, and one with nothing to say waits.
    expect(screen.getByText("No room. Waiting for the next check.")).toBeInTheDocument();
    expect(screen.getByText("Moving")).toBeInTheDocument();
    // Shades are added and changed from their room, not here.
    expect(screen.getByRole("link", { name: "My Home" })).toHaveAttribute("href", "/my-home");
    expect(screen.queryByRole("button", { name: "Add Shade" })).toBeNull();
    expect(screen.queryByLabelText("Which way Bunk Shade's window faces")).toBeNull();
  });

  it("reports a failed load and ignores late answers", async () => {
    vi.mocked(sh.getShades).mockRejectedValueOnce(new Error("x"));
    const first = render(
      <MemoryRouter>
        <ShadesSection rooms={ROOMS} />
      </MemoryRouter>
    );
    expect(await screen.findByText("Could not load shades.")).toBeInTheDocument();
    first.unmount();
    let resolve: (d: sh.Shades) => void = () => {};
    vi.mocked(sh.getShades).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const second = render(
      <MemoryRouter>
        <ShadesSection rooms={ROOMS} />
      </MemoryRouter>
    );
    second.unmount();
    resolve(data());
    let reject: (e: Error) => void = () => {};
    vi.mocked(sh.getShades).mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    const third = render(
      <MemoryRouter>
        <ShadesSection rooms={ROOMS} />
      </MemoryRouter>
    );
    third.unmount();
    reject(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByText("Could not load shades.")).toBeNull();
  });

  it("shows the empty state and a sun without a dial position", async () => {
    vi.mocked(sh.getShades).mockResolvedValue(
      data({ shades: [], sun: { elevation: null, azimuth: null, cloud_pct: null } })
    );
    render(
      <MemoryRouter>
        <ShadesSection rooms={ROOMS} />
      </MemoryRouter>
    );
    expect(await screen.findByText(/No shades yet/)).toBeInTheDocument();
    expect(screen.getByText("Sun position unknown.")).toBeInTheDocument();
  });

  it("saves every setting", async () => {
    await ready();
    for (const [label, key] of [
      ["Automatically Control Shades to Optimize Solar Effects", "auto_enabled"],
      ["Do Not Control Shades in an Occupied Room", "skip_occupied"],
      ["Only Between Sunrise and Sunset", "daylight_only"],
      ["Close at Night in Heat Mode", "close_night_heat"],
      ["Close Ahead of a Warm Room", "predictive_close"],
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
