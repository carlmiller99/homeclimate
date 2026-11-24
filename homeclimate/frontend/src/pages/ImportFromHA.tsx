import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  getBuildings,
  getImportPreview,
  getZones,
  runImport,
  type Building,
  type ImportPreview,
  type ImportResult,
  type ImportRoomRow,
} from "../zonesApi";

const NEW_BUILDING = "__new__";

/** Entity kinds the importer can attach today, in chip order. */
const IMPORTABLE = ["temperature", "presence", "vents"] as const;
const KIND_LABEL: Record<string, string> = {
  temperature: "Temperature",
  presence: "Presence",
  vents: "Vent",
  contacts: "Door or Window",
  shades: "Shade",
};
const LATER: Record<string, string> = {
  contacts: "Doors and windows are attached in Smart Control.",
  shades: "Shades are attached in Smart Control.",
};

interface ZoneChoice {
  include: boolean;
  name: string;
  building: string; // building id, or NEW_BUILDING
  newBuilding: string;
}

interface RoomChoice {
  include: boolean;
  name: string;
  zone: string;
  areas: string[]; // first is the row's own area
  excluded: string[];
}

export default function ImportFromHA() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [configured, setConfigured] = useState<{ id: string; name: string }[]>([]);
  const [zoneChoices, setZoneChoices] = useState<Record<string, ZoneChoice>>({});
  const [roomChoices, setRoomChoices] = useState<Record<string, RoomChoice>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getImportPreview(), getBuildings(), getZones()])
      .then(([p, b, z]) => {
        if (cancelled) return;
        setPreview(p);
        setBuildings(b);
        setConfigured(z.map((x) => ({ id: x.thermostat_entity_id, name: x.name })));
        const zc: Record<string, ZoneChoice> = {};
        for (const row of p.zones) {
          zc[row.entity_id] = {
            include: !row.configured,
            name: row.suggested_name,
            building: b[0]?.id ?? NEW_BUILDING,
            newBuilding: "Main House",
          };
        }
        setZoneChoices(zc);
        const rc: Record<string, RoomChoice> = {};
        for (const row of p.rooms) {
          rc[row.area_id] = {
            include: !row.skipped,
            name: row.area_name,
            zone: row.suggested_zone ?? "",
            areas: [row.area_id],
            excluded: [],
          };
        }
        setRoomChoices(rc);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoadError(e instanceof Error ? e.message : "Could not read Home Assistant");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rowsByArea = useMemo(() => {
    const m: Record<string, ImportRoomRow> = {};
    for (const r of preview?.rooms ?? []) m[r.area_id] = r;
    return m;
  }, [preview]);

  if (loadError) {
    return (
      <div className="import-sheet">
        <h1 className="page-title">Set Up from Home Assistant</h1>
        <p className="form-error">{loadError}</p>
        <Link className="btn btn-secondary" to="/zones">
          Back to Zones
        </Link>
      </div>
    );
  }
  if (!preview) return <div className="import-sheet">Reading Home Assistant…</div>;

  // Areas folded into another row are not shown on their own.
  const mergedInto = new Map<string, string>();
  for (const [owner, c] of Object.entries(roomChoices)) {
    for (const a of c.areas.slice(1)) mergedInto.set(a, owner);
  }
  const zoneOptions = [
    ...configured.map((c) => ({ id: c.id, name: c.name || c.id })),
    ...preview.zones
      .filter((z) => !z.configured && zoneChoices[z.entity_id]?.include)
      .map((z) => ({ id: z.entity_id, name: zoneChoices[z.entity_id].name || z.entity_id })),
  ];
  const label = (eid: string) => preview.labels[eid] ?? eid;
  const visible = preview.rooms.filter((r) => !mergedInto.has(r.area_id));
  const active = visible.filter((r) => !r.skipped || roomChoices[r.area_id]?.include);
  const skipped = visible.filter((r) => r.skipped && !roomChoices[r.area_id]?.include);

  const setZone = (id: string, patch: Partial<ZoneChoice>) =>
    setZoneChoices((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
  const setRoom = (id: string, patch: Partial<RoomChoice>) =>
    setRoomChoices((all) => ({ ...all, [id]: { ...all[id], ...patch } }));

  const foundFor = (c: RoomChoice) => {
    const out: Record<string, string[]> = {};
    for (const kind of Object.keys(KIND_LABEL)) {
      out[kind] = c.areas.flatMap(
        (a) => (rowsByArea[a].found as unknown as Record<string, string[]>)[kind]
      );
    }
    return out;
  };

  const toggleEntity = (area: string, eid: string) =>
    setRoomChoices((all) => {
      const c = all[area];
      const excluded = c.excluded.includes(eid)
        ? c.excluded.filter((x) => x !== eid)
        : [...c.excluded, eid];
      return { ...all, [area]: { ...c, excluded } };
    });

  const combine = (owner: string, other: string) =>
    setRoomChoices((all) => ({
      ...all,
      [owner]: { ...all[owner], areas: [...all[owner].areas, other] },
      [other]: { ...all[other], include: false },
    }));
  const split = (owner: string) =>
    setRoomChoices((all) => {
      const next = { ...all, [owner]: { ...all[owner], areas: [owner] } };
      for (const a of all[owner].areas.slice(1)) next[a] = { ...next[a], include: true };
      return next;
    });

  const submit = async () => {
    setSaving(true);
    setSaveError(null);
    const zones = preview.zones
      .filter((z) => zoneChoices[z.entity_id].include)
      .map((z) => {
        const c = zoneChoices[z.entity_id];
        return c.building === NEW_BUILDING
          ? { entity_id: z.entity_id, name: c.name, new_building_name: c.newBuilding }
          : { entity_id: z.entity_id, name: c.name, building_id: c.building };
      });
    const rooms = Object.entries(roomChoices)
      .filter(([area, c]) => c.include && !mergedInto.has(area) && c.zone)
      .map(([, c]) => {
        const found = foundFor(c);
        const keep = (ids: string[]) => ids.filter((e) => !c.excluded.includes(e));
        return {
          name: c.name,
          zone: c.zone,
          sensors: keep(found.temperature),
          presence: keep(found.presence),
          vents: keep(found.vents),
        };
      });
    const skippedAreas = Object.entries(roomChoices)
      .filter(([area, c]) => !c.include && !mergedInto.has(area))
      .map(([area]) => area);
    try {
      setResult(await runImport({ zones, rooms, skipped_areas: skippedAreas }));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "The import did not complete");
    } finally {
      setSaving(false);
    }
  };

  if (result) {
    return (
      <div className="import-sheet">
        <h1 className="page-title">Imported from Home Assistant</h1>
        <p className="page-subtitle">
          {`Added ${result.zones_added} zones, ${result.rooms_added} rooms and ${result.entities_added} sensors and vents.`}
        </p>
        <div className="zone-editor-actions">
          <Link className="btn btn-secondary" to="/zones">
            Go to Zones
          </Link>
          <Link className="btn btn-primary" to="/rooms">
            Go to Rooms
          </Link>
        </div>
      </div>
    );
  }

  const roomRow = (r: ImportRoomRow) => {
    const c = roomChoices[r.area_id];
    const found = foundFor(c);
    const others = visible.filter((o) => o.area_id !== r.area_id && !c.areas.includes(o.area_id));
    return (
      <tr key={r.area_id}>
        <td>
          <input
            type="checkbox"
            className="cb"
            checked={c.include}
            aria-label={`Include ${c.name}`}
            onChange={(e) => setRoom(r.area_id, { include: e.target.checked })}
          />
        </td>
        <td>
          <input
            className="form-control"
            list="import-room-names"
            value={c.name}
            aria-label={`Room name for ${r.area_name}`}
            onChange={(e) => setRoom(r.area_id, { name: e.target.value })}
          />
          <div className="import-areas">
            {c.areas.length > 1 ? (
              <>
                {`Combines ${c.areas.map((a) => rowsByArea[a].area_name).join(", ")}`}
                <button type="button" className="link-button" onClick={() => split(r.area_id)}>
                  Split
                </button>
              </>
            ) : (
              <>
                {`Area: ${r.area_name}`}
                {others.length > 0 && (
                  <select
                    className="link-select"
                    aria-label={`Combine ${r.area_name} with another area`}
                    value=""
                    onChange={(e) => combine(r.area_id, e.target.value)}
                  >
                    <option value="">Combine With…</option>
                    {others.map((o) => (
                      <option key={o.area_id} value={o.area_id}>
                        {o.area_name}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
          </div>
        </td>
        <td>
          <div className="chip-wrap">
            {IMPORTABLE.flatMap((kind) =>
              found[kind].map((eid) => {
                const on = !c.excluded.includes(eid);
                return (
                  <button
                    key={eid}
                    type="button"
                    className={`chip chip-${kind}`}
                    aria-pressed={on}
                    title={`${KIND_LABEL[kind]}: ${eid}`}
                    onClick={() => toggleEntity(r.area_id, eid)}
                  >
                    {label(eid)}
                  </button>
                );
              })
            )}
            {(["contacts", "shades"] as const).flatMap((kind) =>
              found[kind].map((eid) => (
                <span key={eid} className={`chip chip-${kind} chip-later`} title={LATER[kind]}>
                  {label(eid)}
                </span>
              ))
            )}
            {Object.values(found).every((v) => v.length === 0) && (
              <span className="field-help">Nothing found</span>
            )}
          </div>
        </td>
        <td>
          <select
            className="form-control"
            aria-label={`Zone for ${c.name}`}
            value={c.zone}
            onChange={(e) => setRoom(r.area_id, { zone: e.target.value })}
          >
            <option value="">Choose a zone</option>
            {zoneOptions.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </td>
      </tr>
    );
  };

  return (
    <div className="import-sheet">
      <div className="import-head">
        <div>
          <h1 className="page-title">Set Up from Home Assistant</h1>
          <p className="page-subtitle">
            Review what was found. Nothing is created until you import, and you can run this again
            later to pick up new devices.
          </p>
        </div>
        <Link className="btn btn-secondary" to="/zones" aria-label="Close">
          Close
        </Link>
      </div>

      <datalist id="import-room-names">
        {preview.room_names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <section className="import-section">
        <h2 className="zone-section-title">Zones</h2>
        <p className="field-help">One for each thermostat. Names start from its area or floor.</p>
        <div className="table-scroll">
          <table className="import-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Include</span>
                </th>
                <th scope="col">Thermostat</th>
                <th scope="col">Zone Name</th>
                <th scope="col">Building</th>
              </tr>
            </thead>
            <tbody>
              {preview.zones.map((z) => {
                const c = zoneChoices[z.entity_id];
                return (
                  <tr key={z.entity_id}>
                    <td>
                      <input
                        type="checkbox"
                        className="cb"
                        checked={c.include}
                        disabled={z.configured}
                        aria-label={`Include ${z.friendly_name}`}
                        onChange={(e) => setZone(z.entity_id, { include: e.target.checked })}
                      />
                    </td>
                    <td>
                      <div className="zone-name-sm">{z.friendly_name}</div>
                      <div className="zone-entity">
                        {z.configured ? "Already a zone" : `Area: ${z.area_name ?? "None"}`}
                      </div>
                    </td>
                    <td>
                      <input
                        className="form-control"
                        list="import-room-names"
                        value={c.name}
                        disabled={z.configured}
                        aria-label={`Zone name for ${z.friendly_name}`}
                        onChange={(e) => setZone(z.entity_id, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <div className="import-building">
                        <select
                          className="form-control"
                          value={c.building}
                          disabled={z.configured}
                          aria-label={`Building for ${z.friendly_name}`}
                          onChange={(e) => setZone(z.entity_id, { building: e.target.value })}
                        >
                          {buildings.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                          <option value={NEW_BUILDING}>New Building…</option>
                        </select>
                        {c.building === NEW_BUILDING && !z.configured && (
                          <input
                            className="form-control"
                            value={c.newBuilding}
                            aria-label={`New building name for ${z.friendly_name}`}
                            onChange={(e) => setZone(z.entity_id, { newBuilding: e.target.value })}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="import-section">
        <h2 className="zone-section-title">Rooms</h2>
        <p className="field-help">
          One for each area with something useful in it. Combine areas that act as one room.
        </p>
        <div className="table-scroll">
          <table className="import-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Include</span>
                </th>
                <th scope="col">Room</th>
                <th scope="col">Found in Home Assistant</th>
                <th scope="col">Zone</th>
              </tr>
            </thead>
            <tbody>{active.map(roomRow)}</tbody>
          </table>
        </div>
        {skipped.length > 0 && (
          <details className="import-skipped">
            <summary>Skipped Areas</summary>
            <div className="chip-wrap">
              {skipped.map((r) => (
                <button
                  key={r.area_id}
                  type="button"
                  className="chip"
                  onClick={() => setRoom(r.area_id, { include: true })}
                >
                  {`Add ${r.area_name}`}
                </button>
              ))}
            </div>
          </details>
        )}
      </section>

      <div className="import-foot">
        <p className="field-help">Rooms you have already set up are never changed.</p>
        {saveError && <p className="form-error">{saveError}</p>}
        <Link className="btn btn-secondary" to="/zones">
          Cancel
        </Link>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
          Import
        </button>
      </div>
    </div>
  );
}
