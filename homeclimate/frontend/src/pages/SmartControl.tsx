import { useCallback, useEffect, useState } from "react";
import { getRooms, type Room } from "../api";
import EntityPicker from "../components/EntityPicker";
import { MinutesInput, RuleRow, Switch } from "../components/SmartControlControls";
import {
  contactStateLabel,
  deleteContactSensor,
  effectiveSettings,
  getSmartControl,
  OPENINGS_NOTE,
  PLANNED_SECTIONS,
  ROOM_KEYS,
  saveContactSensor,
  setOpeningOverride,
  updateOpeningSettings,
  ZONE_KEYS,
  type ContactSensor,
  type ContactTarget,
  type OpeningSettings,
  type OverrideScope,
  type SmartControl as SmartControlData,
} from "../smartControlApi";
import ShadesSection from "./ShadesSection";
import { getBuildings, getZones, type Building, type ZoneProfile } from "../zonesApi";

const REFRESH_MS = 30_000;

type Minutes = "zone_pause_min" | "room_pause_min" | "resume_min";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Override editor for one zone and the rooms it serves. */
function OverrideEditor({
  data,
  zone,
  rooms,
  onSaved,
}: {
  data: SmartControlData;
  zone: ZoneProfile;
  rooms: Room[];
  onSaved: (d: SmartControlData) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const save = async (scope: OverrideScope, id: string, body: Record<string, unknown>) => {
    setErr(null);
    try {
      onSaved(await setOpeningOverride(scope, id, body as never));
    } catch (e) {
      setErr(errorText(e, "Could not save the override"));
    }
  };
  const clear = (scope: OverrideScope, id: string) =>
    save(
      scope,
      id,
      Object.fromEntries((scope === "zone" ? ZONE_KEYS : ROOM_KEYS).map((k) => [k, null]))
    );

  const row = (scope: OverrideScope, id: string, name: string) => {
    const { values, overridden } = effectiveSettings(data, scope, id);
    const enabledKey = scope === "zone" ? "zone_pause_enabled" : "room_pause_enabled";
    const minKey: Minutes = scope === "zone" ? "zone_pause_min" : "room_pause_min";
    const label = scope === "zone" ? "Pause Zone" : "Pause Room";
    return (
      <div className="override-row" key={`${scope}-${id}`}>
        <div className="override-name">
          <span>{name}</span>
          <span className="override-status">
            {overridden.length ? "Override" : "Uses Defaults"}
          </span>
        </div>
        <label className="override-toggle">
          <Switch
            id={`ov-${scope}-${id}`}
            checked={values[enabledKey]}
            label={`${label} for ${name}`}
            onChange={(v) => save(scope, id, { [enabledKey]: v })}
          />
          {label} After
        </label>
        <MinutesInput
          value={values[minKey]}
          min={1}
          max={60}
          label={`${label} delay for ${name}`}
          disabled={!values[enabledKey]}
          onCommit={(n) => save(scope, id, { [minKey]: n })}
        />
        <span className="override-resume">Resume After</span>
        <MinutesInput
          value={values.resume_min}
          min={0}
          max={30}
          label={`Resume delay for ${name}`}
          onCommit={(n) => save(scope, id, { resume_min: n })}
        />
        <button
          type="button"
          className="link-button"
          disabled={!overridden.length}
          onClick={() => clear(scope, id)}
        >
          Use Defaults
        </button>
      </div>
    );
  };

  return (
    <div className="override-editor">
      {row("zone", zone.thermostat_entity_id, zone.name || zone.thermostat_entity_id)}
      {rooms.map((r) => row("room", r.id, r.name))}
      {err && <p className="form-error">{err}</p>}
    </div>
  );
}

function zoneOverrideLabel(data: SmartControlData, zone: ZoneProfile): string {
  const { values, overridden } = effectiveSettings(data, "zone", zone.thermostat_entity_id);
  if (!overridden.length) return "Uses Defaults";
  if (!values.zone_pause_enabled) return "Zone Pause Off (Override)";
  return `Zone Pause After ${values.zone_pause_min} Min (Override)`;
}

function AddSensor({
  zones,
  rooms,
  onSaved,
  onCancel,
}: {
  zones: ZoneProfile[];
  rooms: Room[];
  onSaved: (d: SmartControlData) => void;
  onCancel: () => void;
}) {
  const [entity, setEntity] = useState("");
  const [target, setTarget] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    const [kind, id] = target.split(":", 2) as ["zone" | "room", string];
    const body: ContactTarget = kind === "zone" ? { thermostat_entity_id: id } : { room_id: id };
    try {
      onSaved(await saveContactSensor(entity, body));
    } catch (e) {
      setErr(errorText(e, "Could not add the sensor"));
    }
  };
  return (
    <div className="add-sensor" role="group" aria-label="Add Door or Window">
      <div className="add-sensor-fields">
        <div className="field-stack">
          <span className="field-label">Door or Window</span>
          {entity ? (
            <div className="picked-entity">
              <span>{entity}</span>
              <button type="button" className="link-button" onClick={() => setEntity("")}>
                Change
              </button>
            </div>
          ) : (
            <EntityPicker
              domain="binary_sensor"
              placeholder="Search doors and windows…"
              onSelect={setEntity}
            />
          )}
        </div>
        <label className="field-stack">
          Pauses
          <select
            className="form-control"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose a zone or room</option>
            {zones.map((z) => (
              <optgroup key={z.thermostat_entity_id} label={z.name || z.thermostat_entity_id}>
                <option value={`zone:${z.thermostat_entity_id}`}>Whole Zone</option>
                {rooms
                  .filter((r) => r.thermostat_entity_id === z.thermostat_entity_id)
                  .map((r) => (
                    <option key={r.id} value={`room:${r.id}`}>
                      {r.name} Only
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      {err && <p className="form-error">{err}</p>}
      <div className="add-sensor-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!entity || !target}
          onClick={add}
        >
          Add Sensor
        </button>
      </div>
    </div>
  );
}

function SensorRow({
  sensor,
  zoneId,
  rooms,
  now,
  onSaved,
  onError,
}: {
  sensor: ContactSensor;
  zoneId: string;
  rooms: Room[];
  now: number;
  onSaved: (d: SmartControlData) => void;
  onError: (msg: string) => void;
}) {
  const value = sensor.room_id ? `room:${sensor.room_id}` : `zone:${zoneId}`;
  const move = async (v: string) => {
    const [kind, id] = v.split(":", 2);
    try {
      onSaved(
        await saveContactSensor(
          sensor.entity_id,
          kind === "zone" ? { thermostat_entity_id: id } : { room_id: id }
        )
      );
    } catch (e) {
      onError(errorText(e, "Could not move the sensor"));
    }
  };
  const remove = async () => {
    try {
      onSaved(await deleteContactSensor(sensor.entity_id));
    } catch (e) {
      onError(errorText(e, "Could not remove the sensor"));
    }
  };
  return (
    <div className={`sensor-row state-${sensor.pausing ? "pausing" : sensor.state}`}>
      <span className="sensor-dot" aria-hidden="true" />
      <div className="sensor-name">
        <div className="sensor-title">{sensor.name}</div>
        <div className="zone-entity">{sensor.entity_id}</div>
      </div>
      <span className="sensor-state">{contactStateLabel(sensor, now)}</span>
      <label className="sensor-scope">
        Pauses
        <select
          className="form-control"
          value={value}
          aria-label={`What ${sensor.name} pauses`}
          onChange={(e) => move(e.target.value)}
        >
          <option value={`zone:${zoneId}`}>Whole Zone</option>
          {rooms.map((r) => (
            <option key={r.id} value={`room:${r.id}`}>
              {r.name} Only
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="link-button"
        aria-label={`Remove ${sensor.name}`}
        onClick={remove}
      >
        Remove
      </button>
    </div>
  );
}

export default function SmartControl() {
  const [data, setData] = useState<SmartControlData | null>(null);
  const [zones, setZones] = useState<ZoneProfile[]>([]);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sensorErr, setSensorErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [overriding, setOverriding] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [section, setSection] = useState<"doors" | "shades">("doors");

  const refresh = useCallback(async () => {
    const d = await getSmartControl();
    setData(d);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSmartControl(), getZones(), getBuildings(), getRooms()])
      .then(([d, z, b, r]) => {
        if (cancelled) return;
        setData(d);
        setZones(z);
        setBuildings(b);
        setRooms(r);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const saved = (d: SmartControlData) => {
    setData(d);
    setErr(null);
    setSensorErr(null);
    setNow(Date.now());
  };

  const saveSetting = async (patch: Partial<OpeningSettings>) => {
    setErr(null);
    try {
      saved(await updateOpeningSettings(patch));
    } catch (e) {
      setErr(errorText(e, "Could not save the setting"));
    }
  };

  if (loadFailed) {
    return (
      <div className="smart-control-page">
        <h1 className="page-title">Smart Control</h1>
        <p className="form-error">
          Could not load Smart Control. Check that HomeClimate is running.
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="smart-control-page">
        <h1 className="page-title">Smart Control</h1>
        <p className="page-subtitle">Loading…</p>
      </div>
    );
  }

  const s = data.settings;
  const roomZone = new Map(rooms.map((r) => [r.id, r.thermostat_entity_id]));
  const zoneOf = (c: ContactSensor) =>
    c.thermostat_entity_id ?? roomZone.get(c.room_id ?? "") ?? "";
  const buildingName = new Map(buildings.map((b) => [b.id, b.name]));
  const sensorZones = zones.filter((z) =>
    data.sensors.some((c) => zoneOf(c) === z.thermostat_entity_id)
  );

  return (
    <div className="smart-control-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Smart Control</h1>
          <p className="page-subtitle">Rules that react to the house, on top of your schedules.</p>
        </div>
      </div>

      <div className="sc-layout">
        <nav className="sc-nav" aria-label="Smart Control sections">
          <button
            type="button"
            className="sc-nav-item"
            aria-current={section === "doors" ? "true" : undefined}
            onClick={() => setSection("doors")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 21V4h11v17" />
              <path d="M15 6l5 2v13" />
            </svg>
            Doors &amp; Windows
          </button>
          <button
            type="button"
            className="sc-nav-item sc-nav-shades"
            aria-current={section === "shades" ? "true" : undefined}
            onClick={() => setSection("shades")}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="4" y="3" width="16" height="18" rx="1" />
              <path d="M4 8h16M4 12h16" />
            </svg>
            Shades
          </button>
          {PLANNED_SECTIONS.map((name) => (
            <div key={name} className="sc-nav-item is-planned">
              <span>{name}</span>
              <span className="sc-nav-note">Planned</span>
            </div>
          ))}
        </nav>

        <div className="sc-main">
          {section === "shades" ? (
            <ShadesSection rooms={rooms} />
          ) : (
            <>
              <section className="sc-section" id="doors-windows">
                <h2 className="sc-section-title">Doors &amp; Windows</h2>
                <p className="sc-section-lead">
                  Stop conditioning air that is going straight outside.
                </p>
                <RuleRow
                  id="zone-pause"
                  title="Pause Zone When a Door or Window Is Open For"
                  help="The thermostat stops until every zone door and window is closed."
                  enabled={s.zone_pause_enabled}
                  onToggle={(v) => saveSetting({ zone_pause_enabled: v })}
                >
                  <MinutesInput
                    value={s.zone_pause_min}
                    min={1}
                    max={60}
                    label="Zone pause delay in minutes"
                    disabled={!s.zone_pause_enabled}
                    onCommit={(n) => saveSetting({ zone_pause_min: n })}
                  />
                </RuleRow>
                <RuleRow
                  id="room-pause"
                  title="Pause Room When a Door or Window Is Open For"
                  help="The room stops calling and its vents close until it is shut again."
                  enabled={s.room_pause_enabled}
                  onToggle={(v) => saveSetting({ room_pause_enabled: v })}
                >
                  <MinutesInput
                    value={s.room_pause_min}
                    min={1}
                    max={60}
                    label="Room pause delay in minutes"
                    disabled={!s.room_pause_enabled}
                    onCommit={(n) => saveSetting({ room_pause_min: n })}
                  />
                </RuleRow>
                <RuleRow
                  id="resume"
                  title="Resume After Everything Is Closed For"
                  help="Stops a door that opens and shuts again from restarting the system."
                >
                  <MinutesInput
                    value={s.resume_min}
                    min={0}
                    max={30}
                    label="Resume delay in minutes"
                    onCommit={(n) => saveSetting({ resume_min: n })}
                  />
                </RuleRow>
                <p className="sc-note">{OPENINGS_NOTE}</p>
                {err && <p className="form-error">{err}</p>}
              </section>

              <section className="sc-section">
                <div className="sc-section-head">
                  <h2 className="sc-section-title">Sensors</h2>
                  {!adding && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setAdding(true)}
                    >
                      Add Door or Window
                    </button>
                  )}
                </div>
                <p className="sc-section-lead">Attach a sensor to a whole zone, or to one room.</p>
                {sensorErr && <p className="form-error">{sensorErr}</p>}
                {adding && (
                  <AddSensor
                    zones={zones}
                    rooms={rooms}
                    onCancel={() => setAdding(false)}
                    onSaved={(d) => {
                      saved(d);
                      setAdding(false);
                    }}
                  />
                )}
                {sensorZones.length === 0 && !adding && (
                  <p className="empty-panel">
                    No doors or windows yet. Add one here, or bring them in with Set Up from Home
                    Assistant.
                  </p>
                )}
                {sensorZones.map((z) => {
                  const zoneRooms = rooms.filter(
                    (r) => r.thermostat_entity_id === z.thermostat_entity_id
                  );
                  const building = z.building_id ? buildingName.get(z.building_id) : undefined;
                  const open = overriding === z.thermostat_entity_id;
                  return (
                    <div className="sensor-zone" key={z.thermostat_entity_id}>
                      <div className="sensor-zone-head">
                        <span className="sensor-zone-name">{z.name || z.thermostat_entity_id}</span>
                        <span className="sensor-zone-meta">
                          {building ? `${building}, ` : ""}
                          {z.thermostat_entity_id}
                        </span>
                        <button
                          type="button"
                          className="link-button"
                          aria-expanded={open}
                          onClick={() => setOverriding(open ? null : z.thermostat_entity_id)}
                        >
                          {zoneOverrideLabel(data, z)}
                        </button>
                      </div>
                      {open && (
                        <OverrideEditor data={data} zone={z} rooms={zoneRooms} onSaved={saved} />
                      )}
                      {data.sensors
                        .filter((c) => zoneOf(c) === z.thermostat_entity_id)
                        .map((c) => (
                          <SensorRow
                            key={c.entity_id}
                            sensor={c}
                            zoneId={z.thermostat_entity_id}
                            rooms={zoneRooms}
                            now={now}
                            onSaved={saved}
                            onError={setSensorErr}
                          />
                        ))}
                    </div>
                  );
                })}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
