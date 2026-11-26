import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import * as sh from "../shadesApi";
import { useState } from "react";
import RoomShades from "./RoomShades";

vi.mock("../shadesApi", async (orig) => ({
  ...(await orig<typeof import("../shadesApi")>()),
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
        room_id: "r1",
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
  vi.mocked(sh.saveShade).mockResolvedValue(data());
  vi.mocked(sh.deleteShade).mockResolvedValue(data({ shades: [] }));
  vi.mocked(api.getHAEntities).mockImplementation(async (domain) =>
    domain === "weather"
      ? [{ entity_id: "weather.home", friendly_name: "Home", state: "sunny" }]
      : [{ entity_id: "cover.new_shade", friendly_name: "New Shade", state: "open" }]
  );
});

function Harness({ initial }: { initial: sh.Shades }) {
  const [d, setD] = useState(initial);
  return <RoomShades room={ROOMS[0]} data={d} onData={setD} />;
}

async function ready(initial: sh.Shades = data()) {
  render(<Harness initial={initial} />);
  await screen.findByText("Bunk Shade");
}

describe("A room's shades", () => {
  it("shows only this room's shades, with the sun and each window's direction", async () => {
    await ready(
      data({
        shades: [SHADE, { ...SHADE, entity_id: "cover.craft", name: "Craft Shade", room_id: "r2" }],
      })
    );
    expect(screen.getByText("Sun 34° up, from the south-southeast.")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Bunk Shade faces S, sun at 160°" })
    ).toBeInTheDocument();
    // The room is already named by the dialog, so the row gives only the reason.
    expect(screen.getByText("Sunlit and heating, so opened.")).toBeInTheDocument();
    expect(screen.queryByText("Craft Shade")).toBeNull();
  });

  it("invites the first shade in a room that has none", () => {
    render(<Harness initial={data({ shades: [] })} />);
    expect(screen.getByText(/No shades in this room yet/)).toBeInTheDocument();
  });

  it("follows saved positions and an unknown sun", async () => {
    vi.mocked(sh.saveShade)
      .mockResolvedValueOnce(data({ shades: [{ ...SHADE, closed_position: 10 }] }))
      .mockResolvedValueOnce(data({ shades: [{ ...SHADE, closed_position: null }] }));
    await ready(data({ sun: { elevation: null, azimuth: null, cloud_pct: null } }));
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
    // The shade goes in the room the dialog was opened for: there is no room to pick.
    expect(within(group).queryByLabelText("Room")).toBeNull();
    fireEvent.change(within(group).getByLabelText("Window Faces"), { target: { value: "W" } });
    vi.mocked(sh.saveShade).mockRejectedValueOnce(new Error("That cover is already a vent"));
    fireEvent.click(add);
    expect(await screen.findByText("That cover is already a vent")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Add Shade" })).toBeInTheDocument();
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add Shade" })).toBeNull());
    expect(sh.saveShade).toHaveBeenLastCalledWith("cover.new_shade", {
      room_id: "r1",
      facing: "W",
    });

    fireEvent.click(screen.getByRole("button", { name: "Add Shade" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Add Shade" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Bunk Shade" }));
    expect(await screen.findByText(/No shades in this room yet/)).toBeInTheDocument();
  });
});
