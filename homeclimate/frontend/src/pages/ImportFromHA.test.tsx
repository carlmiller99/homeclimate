import { HP_DEFAULTS } from "../zoneFixtures";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as zonesApi from "../zonesApi";
import ImportFromHA from "./ImportFromHA";

vi.mock("../zonesApi", async (orig) => ({
  ...(await orig<typeof import("../zonesApi")>()),
  getImportPreview: vi.fn(),
  getBuildings: vi.fn(),
  getZones: vi.fn(),
  runImport: vi.fn(),
}));

const empty = { temperature: [], presence: [], contacts: [], shades: [], vents: [] };

const PREVIEW: zonesApi.ImportPreview = {
  zones: [
    {
      entity_id: "climate.landing",
      friendly_name: "Landing Thermostat",
      area_id: "landing",
      area_name: "Landing",
      floor_name: null,
      suggested_name: "Upstairs",
      configured: false,
    },
    {
      entity_id: "climate.old",
      friendly_name: "Old Thermostat",
      area_id: null,
      area_name: null,
      floor_name: null,
      suggested_name: "Old",
      configured: true,
    },
  ],
  rooms: [
    {
      area_id: "bunk",
      area_name: "Bunk Room",
      found: {
        ...empty,
        temperature: ["sensor.bunk_t"],
        presence: ["binary_sensor.bunk_occ"],
        vents: ["cover.bunk_vent"],
        shades: ["cover.bunk_shade"],
      },
      new_entities: [],
      existing_room_id: null,
      suggested_zone: "climate.landing",
      skipped: false,
    },
    {
      area_id: "bath",
      area_name: "Bunk Bath",
      found: { ...empty, temperature: ["sensor.bath_t"], contacts: ["binary_sensor.bath_window"] },
      new_entities: [],
      existing_room_id: null,
      suggested_zone: null,
      skipped: false,
    },
    {
      area_id: "drive",
      area_name: "Driveway",
      found: empty,
      new_entities: [],
      existing_room_id: null,
      suggested_zone: null,
      skipped: true,
    },
  ],
  labels: { "sensor.bunk_t": "Bunk Temperature", "cover.bunk_shade": "Bunk Shade" },
  room_names: ["Bunk Room", "Bunk Bath"],
};

const RESULT = {
  zones_added: 1,
  heat_pumps_found: 0,
  buildings_added: 1,
  rooms_added: 2,
  rooms_updated: 0,
  entities_added: 4,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ImportFromHA />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(zonesApi.getImportPreview).mockResolvedValue(structuredClone(PREVIEW));
  vi.mocked(zonesApi.getBuildings).mockResolvedValue([]);
  vi.mocked(zonesApi.getZones).mockResolvedValue([
    {
      thermostat_entity_id: "climate.old",
      name: "",
      building_id: null,
      sort_order: 0,
      system_type: "conventional",
      compressor_stages: 1,
      backup_heat: "electric",
      equipment_running_entity: null,
      heat_kit_confirmed: false,
      ...HP_DEFAULTS,
    },
  ]);
  vi.mocked(zonesApi.runImport).mockResolvedValue(RESULT);
});

describe("Set Up from Home Assistant", () => {
  it("shows a loading line, then suggestions", async () => {
    renderPage();
    expect(screen.getByText("Reading Home Assistant…")).toBeInTheDocument();
    expect(await screen.findByLabelText("Zone name for Landing Thermostat")).toBeInTheDocument();
    expect(screen.getByText("Already a zone")).toBeInTheDocument();
    expect(screen.getByText("Area: Landing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bunk Temperature" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("Bunk Shade")).toHaveAttribute(
      "title",
      "Shades are attached in Smart Control."
    );
    expect(screen.getByText("binary_sensor.bath_window")).toBeInTheDocument();
  });

  it("imports the reviewed choices with a new building", async () => {
    renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    fireEvent.change(screen.getByLabelText("New building name for Landing Thermostat"), {
      target: { value: "Guest House" },
    });
    fireEvent.change(screen.getByLabelText("Zone name for Landing Thermostat"), {
      target: { value: "Upstairs Zone" },
    });
    // Untick the vent, then tick it off and on again for the presence sensor.
    fireEvent.click(screen.getByRole("button", { name: "cover.bunk_vent" }));
    fireEvent.click(screen.getByRole("button", { name: "binary_sensor.bunk_occ" }));
    fireEvent.click(screen.getByRole("button", { name: "binary_sensor.bunk_occ" }));
    fireEvent.change(screen.getByLabelText("Room name for Bunk Room"), {
      target: { value: "Bunks" },
    });
    // Bunk Bath has no suggested zone; give it one.
    fireEvent.change(screen.getByLabelText("Zone for Bunk Bath"), {
      target: { value: "climate.old" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(zonesApi.runImport).toHaveBeenCalledWith({
        zones: [
          { entity_id: "climate.landing", name: "Upstairs Zone", new_building_name: "Guest House" },
        ],
        rooms: [
          {
            name: "Bunks",
            zone: "climate.landing",
            sensors: ["sensor.bunk_t"],
            presence: ["binary_sensor.bunk_occ"],
            vents: [],
            contacts: [],
          },
          {
            name: "Bunk Bath",
            zone: "climate.old",
            sensors: ["sensor.bath_t"],
            presence: [],
            vents: [],
            contacts: ["binary_sensor.bath_window"],
          },
        ],
        skipped_areas: ["drive"],
      })
    );
    expect(await screen.findByText("Imported from Home Assistant")).toBeInTheDocument();
    expect(screen.getByText("Added 1 zones, 2 rooms and 4 sensors and vents.")).toBeInTheDocument();
    // Nobody was asked what kind of system each zone is, so the page says what it did.
    expect(
      screen.getByText(
        "The new zones were set as conventional with electric strips. Check each new zone's system type under Edit Zone."
      )
    ).toBeInTheDocument();
  });

  it("says when new zones were set up as heat pumps, and nothing when no zone was added", async () => {
    vi.mocked(zonesApi.runImport).mockResolvedValueOnce({
      ...RESULT,
      zones_added: 2,
      heat_pumps_found: 1,
    });
    const first = renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    fireEvent.click(screen.getByRole("button", { name: /^Import/ }));
    expect(
      await screen.findByText(
        "1 new zone looked like a heat pump and was set up as one. The rest were set as conventional with electric strips. Check each new zone's system type under Edit Zone."
      )
    ).toBeInTheDocument();
    first.unmount();

    vi.mocked(zonesApi.runImport).mockResolvedValueOnce({
      ...RESULT,
      zones_added: 2,
      heat_pumps_found: 2,
    });
    const second = renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    fireEvent.click(screen.getByRole("button", { name: /^Import/ }));
    expect(
      await screen.findByText(
        "2 new zones looked like heat pumps and were set up as heat pumps. Check each new zone's system type under Edit Zone."
      )
    ).toBeInTheDocument();
    second.unmount();

    vi.mocked(zonesApi.runImport).mockResolvedValueOnce({ ...RESULT, zones_added: 0 });
    renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    fireEvent.click(screen.getByRole("button", { name: /^Import/ }));
    await screen.findByText("Imported from Home Assistant");
    expect(screen.queryByText(/system type under Edit Zone/)).toBeNull();
  });

  it("tells apart two thermostats that share a name", async () => {
    const preview = structuredClone(PREVIEW);
    preview.zones.push({
      ...preview.zones[0],
      entity_id: "climate.landing_cloud",
      friendly_name: "Landing Thermostat Cloud",
    });
    vi.mocked(zonesApi.getImportPreview).mockResolvedValue(preview);
    renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    // Both start from the same suggested name, so each is shown with its entity.
    const picker = screen.getByLabelText("Zone for Bunk Bath");
    expect(
      within(picker).getByRole("option", { name: "Upstairs (climate.landing)" })
    ).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: "Upstairs (climate.landing_cloud)" })
    ).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "climate.old" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "More than one thermostat is named Upstairs. If they are the same thermostat seen through two integrations, include only one of them."
    );
    // Renaming one clears it up.
    fireEvent.change(screen.getByLabelText("Zone name for Landing Thermostat Cloud"), {
      target: { value: "Upstairs Cloud" },
    });
    expect(within(picker).getByRole("option", { name: "Upstairs" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("combines and splits areas, includes skipped ones, and leaves zoneless rooms out", async () => {
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([
      { id: "b1", name: "Main House", sort_order: 0 },
    ]);
    renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    // Existing building is the default; no new-building box.
    expect(screen.queryByLabelText("New building name for Landing Thermostat")).toBeNull();
    fireEvent.change(screen.getByLabelText("Building for Landing Thermostat"), {
      target: { value: "__new__" },
    });
    expect(screen.getByLabelText("New building name for Landing Thermostat")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Building for Landing Thermostat"), {
      target: { value: "b1" },
    });

    fireEvent.change(screen.getByLabelText("Combine Bunk Room with another area"), {
      target: { value: "bath" },
    });
    expect(screen.getByText(/Combines Bunk Room, Bunk Bath/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Room name for Bunk Bath")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByLabelText("Room name for Bunk Bath")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Combine Bunk Room with another area"), {
      target: { value: "bath" },
    });

    fireEvent.click(screen.getByText("Skipped Areas"));
    fireEvent.click(screen.getByRole("button", { name: "Add Driveway" }));
    expect(screen.getByText("Nothing found")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Include Landing Thermostat"));
    // Unticking a skipped area sends it back to the Skipped list.
    fireEvent.click(screen.getByLabelText("Include Driveway"));
    expect(screen.queryByLabelText("Include Driveway")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Driveway" }));

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(zonesApi.runImport).toHaveBeenCalled());
    const body = vi.mocked(zonesApi.runImport).mock.calls[0][0];
    expect(body.zones).toEqual([]);
    // The combined row's zone (climate.landing) is no longer offered once the
    // zone is unticked, but the row keeps the value it had; Driveway has no zone.
    expect(body.rooms.map((r) => r.name)).toEqual(["Bunk Room"]);
    expect(body.rooms[0].sensors).toEqual(["sensor.bunk_t", "sensor.bath_t"]);
    expect(body.skipped_areas).toEqual([]);
  });

  it("reports load and save failures", async () => {
    vi.mocked(zonesApi.getImportPreview).mockRejectedValueOnce(
      new Error("Home Assistant's registries could not be read")
    );
    const { unmount } = renderPage();
    expect(
      await screen.findByText("Home Assistant's registries could not be read")
    ).toBeInTheDocument();
    unmount();

    vi.mocked(zonesApi.getImportPreview).mockRejectedValueOnce("nope");
    const second = renderPage();
    expect(await screen.findByText("Could not read Home Assistant")).toBeInTheDocument();
    second.unmount();

    renderPage();
    await screen.findByLabelText("Zone name for Landing Thermostat");
    vi.mocked(zonesApi.runImport).mockRejectedValueOnce(new Error("each room needs a zone"));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("each room needs a zone")).toBeInTheDocument();
    vi.mocked(zonesApi.runImport).mockRejectedValueOnce(5);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText("The import did not complete")).toBeInTheDocument();
  });

  it("ignores a preview that lands after unmount", async () => {
    let resolve: (p: zonesApi.ImportPreview) => void = () => {};
    vi.mocked(zonesApi.getImportPreview).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    const { unmount } = renderPage();
    unmount();
    resolve(structuredClone(PREVIEW));
    await Promise.resolve();
    expect(zonesApi.runImport).not.toHaveBeenCalled();
  });

  it("ignores a failure that lands after unmount", async () => {
    let reject: (e: Error) => void = () => {};
    vi.mocked(zonesApi.getImportPreview).mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      })
    );
    const { unmount } = renderPage();
    unmount();
    reject(new Error("late"));
    await Promise.resolve();
    expect(screen.queryByText("late")).toBeNull();
  });

  it("files a zone under an existing building and names unnamed zones by entity", async () => {
    vi.mocked(zonesApi.getBuildings).mockResolvedValue([
      { id: "b1", name: "Main House", sort_order: 0 },
    ]);
    const preview = structuredClone(PREVIEW);
    preview.zones[0].area_name = null;
    vi.mocked(zonesApi.getImportPreview).mockResolvedValue(preview);
    renderPage();
    const name = await screen.findByLabelText("Zone name for Landing Thermostat");
    expect(screen.getByText("Area: None")).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "" } });
    const zoneSelect = screen.getByLabelText("Zone for Bunk Bath");
    expect(within(zoneSelect).getByRole("option", { name: "climate.landing" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(zonesApi.runImport).toHaveBeenCalled());
    expect(vi.mocked(zonesApi.runImport).mock.calls[0][0].zones).toEqual([
      { entity_id: "climate.landing", name: "", building_id: "b1" },
    ]);
  });

  it("keeps unknown labels as entity ids and shows rows within their table", async () => {
    renderPage();
    const table = (await screen.findAllByRole("table"))[1];
    expect(within(table).getByRole("button", { name: "sensor.bath_t" })).toBeInTheDocument();
  });
});
