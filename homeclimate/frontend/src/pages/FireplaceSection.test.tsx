import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { TimeZoneContext, buildTimeZoneContext } from "../contexts";
import * as fp from "../fireplaceApi";
import FireplaceSection from "./FireplaceSection";

vi.mock("../fireplaceApi", async (orig) => ({
  ...(await orig<typeof import("../fireplaceApi")>()),
  getFireplaces: vi.fn(),
  addFireplace: vi.fn(),
  saveFireplace: vi.fn(),
  deleteFireplace: vi.fn(),
}));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  getRooms: vi.fn(),
}));
vi.mock("../components/EntityPicker", () => ({
  default: ({ onSelect, placeholder }: { onSelect: (id: string) => void; placeholder: string }) =>
    placeholder === "Change to…" ? (
      <>
        <button type="button" onClick={() => onSelect("switch.relay")}>
          pick same
        </button>
        <button type="button" onClick={() => onSelect("binary_sensor.flame")}>
          pick other
        </button>
      </>
    ) : (
      <button type="button" onClick={() => onSelect("switch.relay")}>
        pick signal
      </button>
    ),
}));

const ROOMS = [
  { id: "r2", name: "Loft", thermostat_entity_id: "climate.up" },
  { id: "r1", name: "Great Room", thermostat_entity_id: "climate.main" },
] as api.Room[];

const HEARTH: fp.Fireplace = {
  id: "f1",
  name: "Hearth",
  entity_id: "switch.relay",
  room_ids: ["r1"],
  cooldown_min: 60,
  control: "watch",
  state: "out",
  lit_since: null,
  cooling_until: null,
  setting_aside: false,
  signal_lost: false,
};

const list = (...f: fp.Fireplace[]): fp.Fireplaces => ({ fireplaces: f });

function show() {
  return render(
    <TimeZoneContext.Provider value={buildTimeZoneContext("America/New_York")}>
      <FireplaceSection />
    </TimeZoneContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getRooms).mockResolvedValue(ROOMS);
  vi.mocked(fp.getFireplaces).mockResolvedValue(list(HEARTH));
  vi.mocked(fp.saveFireplace).mockImplementation(async (_id, patch) =>
    list({ ...HEARTH, ...patch })
  );
  vi.mocked(fp.addFireplace).mockResolvedValue(list(HEARTH));
  vi.mocked(fp.deleteFireplace).mockResolvedValue(list());
});

describe("Fireplace section", () => {
  it("lists each fireplace with its state, rule and rooms", async () => {
    show();
    expect(screen.getByText("Loading fireplaces…")).toBeInTheDocument();
    const card = await screen.findByRole("group", { name: "Hearth" });
    expect(within(card).getByRole("status")).toHaveTextContent("Out");
    expect(within(card).getByLabelText("When Lit")).toHaveValue("watch");
    expect(
      within(card).getByText("HomeClimate notes when it is lit, and changes nothing.")
    ).toBeInTheDocument();
    expect(within(card).getByLabelText("Cool-down for Hearth in minutes")).toHaveValue(60);
    // Rooms are listed by name; the ones it warms are ticked.
    const boxes = within(card).getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
    expect(within(card).getByLabelText("Great Room")).toBeChecked();
  });

  it("says when a fire is lit, cooling down or not reporting", async () => {
    vi.mocked(fp.getFireplaces).mockResolvedValue(
      list(
        {
          ...HEARTH,
          control: "on",
          state: "lit",
          lit_since: "2026-01-05T23:30:00+00:00",
          setting_aside: true,
        },
        {
          ...HEARTH,
          id: "f2",
          name: "Den Stove",
          state: "cooling",
          cooling_until: "2026-01-06T00:15:00+00:00",
        },
        { ...HEARTH, id: "f3", name: "Porch", state: "unknown" },
        { ...HEARTH, id: "f4", name: "Odd", state: "lit" },
        {
          ...HEARTH,
          id: "f5",
          name: "Stove",
          control: "on",
          state: "cooling",
          cooling_until: "2026-01-06T02:00:00+00:00",
          setting_aside: true,
          signal_lost: true,
        },
        { ...HEARTH, id: "f6", name: "Unused", control: "off", state: "unknown" },
        { ...HEARTH, id: "f7", name: "Bare", state: "cooling" }
      )
    );
    show();
    const lit = await screen.findByRole("group", { name: "Hearth" });
    expect(within(lit).getByRole("status")).toHaveTextContent("Lit since 6:30 PM");
    expect(
      within(lit).getByText("The rooms it warms are not calling for heating or cooling right now.")
    ).toBeInTheDocument();
    const cooling = screen.getByRole("group", { name: "Den Stove" });
    expect(within(cooling).getByRole("status")).toHaveTextContent("Cooling Down until 7:15 PM");
    expect(within(cooling).queryByText(/not calling/)).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Porch" })).getByText(
        "switch.relay is not reporting, so HomeClimate can't tell whether the fire is lit."
      )
    ).toBeInTheDocument();
    const lost = screen.getByRole("group", { name: "Stove" });
    expect(within(lost).getByRole("status")).toHaveTextContent(
      "Signal Lost While Lit, held until 9:00 PM"
    );
    expect(
      within(lost).getByText(
        "switch.relay stopped reporting while the fire was lit, so HomeClimate is treating it as still lit."
      )
    ).toBeInTheDocument();
    // A fireplace that is off is not described as lit or broken.
    const unused = screen.getByRole("group", { name: "Unused" });
    expect(within(unused).getByRole("status")).toHaveTextContent(/^Ignored$/);
    expect(within(unused).queryByText(/not reporting/)).toBeNull();
    expect(
      within(screen.getByRole("group", { name: "Bare" })).getByRole("status")
    ).toHaveTextContent(/^Cooling Down$/);
    // Lit with no start time on record still reads Lit.
    expect(
      within(screen.getByRole("group", { name: "Odd" })).getByRole("status")
    ).toHaveTextContent(/^Lit$/);
  });

  it("saves the rule, the cool-down and the rooms", async () => {
    show();
    const card = await screen.findByRole("group", { name: "Hearth" });
    fireEvent.change(within(card).getByLabelText("When Lit"), { target: { value: "on" } });
    await waitFor(() => expect(fp.saveFireplace).toHaveBeenCalledWith("f1", { control: "on" }));
    expect(
      await within(card).findByText(/stop calling for heating or cooling/)
    ).toBeInTheDocument();

    const minutes = within(card).getByLabelText("Cool-down for Hearth in minutes");
    fireEvent.change(minutes, { target: { value: "90" } });
    fireEvent.blur(minutes);
    await waitFor(() =>
      expect(fp.saveFireplace).toHaveBeenLastCalledWith("f1", { cooldown_min: 90 })
    );

    await waitFor(() => expect(within(card).getByLabelText("Loft")).not.toBeDisabled());
    fireEvent.click(within(card).getByLabelText("Loft"));
    await waitFor(() =>
      expect(fp.saveFireplace).toHaveBeenLastCalledWith("f1", { room_ids: ["r1", "r2"] })
    );
    await waitFor(() => expect(within(card).getByLabelText("Loft")).toBeChecked());
    fireEvent.click(within(card).getByLabelText("Great Room"));
    await waitFor(() =>
      expect(fp.saveFireplace).toHaveBeenLastCalledWith("f1", { room_ids: ["r2"] })
    );
    // The only ticked room is locked: a fireplace warms at least one room.
    await waitFor(() => expect(within(card).getByLabelText("Great Room")).not.toBeChecked());
    expect(within(card).getByLabelText("Loft")).toBeDisabled();
    expect(within(card).getByLabelText("Loft")).toHaveAttribute(
      "title",
      "A fireplace warms at least one room"
    );
    expect(within(card).getByLabelText("Great Room")).not.toBeDisabled();
  });

  it("renames a fireplace and changes its signal", async () => {
    show();
    const card = await screen.findByRole("group", { name: "Hearth" });
    const name = within(card).getByLabelText("Name");
    // Blank or unchanged puts the stored name back and saves nothing.
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.blur(name);
    expect(name).toHaveValue("Hearth");
    fireEvent.blur(name);
    fireEvent.click(within(card).getByRole("button", { name: "pick same" }));
    expect(fp.saveFireplace).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "pick other" }));
    await waitFor(() =>
      expect(fp.saveFireplace).toHaveBeenCalledWith("f1", { entity_id: "binary_sensor.flame" })
    );
    await waitFor(() => expect(within(card).getByLabelText("Name")).not.toBeDisabled());
    fireEvent.change(within(card).getByLabelText("Name"), { target: { value: " Stove " } });
    fireEvent.blur(within(card).getByLabelText("Name"));
    await waitFor(() => expect(fp.saveFireplace).toHaveBeenLastCalledWith("f1", { name: "Stove" }));
    expect(await screen.findByRole("group", { name: "Stove" })).toBeInTheDocument();
    // The card is the same one: its details stay as the user left them.
    expect(within(card).getByLabelText("Name")).toHaveValue("Stove");

    // A refused rename puts the stored name back.
    vi.mocked(fp.saveFireplace).mockRejectedValueOnce(new Error("Another fireplace has it"));
    await waitFor(() => expect(within(card).getByLabelText("Name")).not.toBeDisabled());
    fireEvent.change(within(card).getByLabelText("Name"), { target: { value: "Taken" } });
    fireEvent.blur(within(card).getByLabelText("Name"));
    expect(await screen.findByText("Another fireplace has it")).toBeInTheDocument();
    expect(within(card).getByLabelText("Name")).toHaveValue("Stove");
  });

  it("puts back what is stored when a save is refused", async () => {
    vi.mocked(fp.saveFireplace).mockRejectedValueOnce(new Error("Not allowed"));
    show();
    const card = await screen.findByRole("group", { name: "Hearth" });
    const minutes = within(card).getByLabelText("Cool-down for Hearth in minutes");
    fireEvent.change(minutes, { target: { value: "90" } });
    fireEvent.blur(minutes);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    expect(screen.getByLabelText("Cool-down for Hearth in minutes")).toHaveValue(60);
  });

  it("adds a fireplace once it has a name, a signal and a room", async () => {
    vi.mocked(fp.getFireplaces).mockResolvedValue(list());
    show();
    expect(await screen.findByText("No fireplaces yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Fireplace" }));
    const form = screen.getByRole("group", { name: "Add Fireplace" });
    const add = within(form).getByRole("button", { name: "Add Fireplace" });
    expect(add).toBeDisabled();
    expect(screen.queryByText("No fireplaces yet.")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " Hearth " } });
    fireEvent.click(within(form).getByRole("button", { name: "pick signal" }));
    expect(within(form).getByText("switch.relay")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Change" }));
    fireEvent.click(within(form).getByRole("button", { name: "pick signal" }));
    expect(add).toBeDisabled();
    fireEvent.click(within(form).getByLabelText("Great Room"));
    fireEvent.click(within(form).getByLabelText("Loft"));
    fireEvent.click(within(form).getByLabelText("Loft"));
    fireEvent.click(add);
    await waitFor(() =>
      expect(fp.addFireplace).toHaveBeenCalledWith({
        name: "Hearth",
        entity_id: "switch.relay",
        room_ids: ["r1"],
      })
    );
    await waitFor(() => expect(screen.queryByRole("group", { name: "Add Fireplace" })).toBeNull());
    expect(screen.getByRole("group", { name: "Hearth" })).toBeInTheDocument();
  });

  it("keeps the form open when adding fails, and Cancel closes it", async () => {
    vi.mocked(fp.getFireplaces).mockResolvedValue(list());
    vi.mocked(fp.addFireplace).mockRejectedValueOnce(
      new Error("Another fireplace already has that name")
    );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Add Fireplace" }));
    const form = screen.getByRole("group", { name: "Add Fireplace" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Hearth" } });
    fireEvent.click(within(form).getByRole("button", { name: "pick signal" }));
    fireEvent.click(within(form).getByLabelText("Loft"));
    fireEvent.click(within(form).getByRole("button", { name: "Add Fireplace" }));
    expect(await screen.findByText("Another fireplace already has that name")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Add Fireplace" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Add Fireplace" })).toBeNull();
  });

  it("asks before removing a fireplace", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Hearth" }));
    expect(screen.getByText("Remove Hearth?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fp.deleteFireplace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Hearth" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Fireplace" }));
    await waitFor(() => expect(fp.deleteFireplace).toHaveBeenCalledWith("f1"));
    expect(await screen.findByText("No fireplaces yet.")).toBeInTheDocument();
  });

  it("runs one change at a time and reports a failed save", async () => {
    let finish!: (d: fp.Fireplaces) => void;
    vi.mocked(fp.saveFireplace).mockReturnValueOnce(new Promise((r) => (finish = r)));
    show();
    const card = await screen.findByRole("group", { name: "Hearth" });
    const select = within(card).getByLabelText("When Lit");
    fireEvent.change(select, { target: { value: "on" } });
    await waitFor(() => expect(select).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Add Fireplace" }));
    const adding = screen.getByRole("group", { name: "Add Fireplace" });
    fireEvent.change(within(adding).getByLabelText("Name"), { target: { value: "Two" } });
    fireEvent.click(within(adding).getByRole("button", { name: "pick signal" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Add Fireplace" })).getByLabelText("Loft")
    );
    // Add is held while the save is in flight.
    expect(
      within(screen.getByRole("group", { name: "Add Fireplace" })).getByRole("button", {
        name: "Add Fireplace",
      })
    ).toBeDisabled();
    finish(list(HEARTH));
    await waitFor(() => expect(select).not.toBeDisabled());

    vi.mocked(fp.saveFireplace).mockRejectedValueOnce("nope");
    fireEvent.change(select, { target: { value: "off" } });
    expect(await screen.findByText("Could not save the fireplace")).toBeInTheDocument();
  });

  it("says so when it cannot load, and ignores late responses", async () => {
    vi.mocked(fp.getFireplaces).mockRejectedValueOnce(new Error("down"));
    const first = show();
    expect(await screen.findByText("Could not load fireplaces.")).toBeInTheDocument();
    first.unmount();
    let resolve!: (d: fp.Fireplaces) => void;
    let reject!: (e: Error) => void;
    vi.mocked(fp.getFireplaces)
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    show().unmount();
    resolve(list());
    show().unmount();
    reject(new Error("late"));
    await Promise.resolve();
    await Promise.resolve();
  });
});
