import EntityName from "../components/EntityName";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { getRooms, type Room } from "../api";
import SectionLayout from "../components/SectionLayout";
import { SMART_CONTROL_SECTIONS } from "../sections";
import { MinutesInput, RuleRow, Switch } from "../components/SmartControlControls";
import {
  effectiveSettings,
  getSmartControl,
  OPENINGS_NOTE,
  ROOM_KEYS,
  setOpeningOverride,
  updateOpeningSettings,
  ZONE_KEYS,
  type OpeningSettings,
  type OverrideScope,
  type SmartControl as SmartControlData,
} from "../smartControlApi";
import { getZones, type ZoneProfile } from "../zonesApi";
import Schedules from "./Schedules";
import FireplaceSection from "./FireplaceSection";
import BuildingAutoCard from "./BuildingAutoCard";
import FanSection from "./FanSection";
import EcoSection from "./EcoSection";
import RoomUsageCard from "./RoomUsageCard";
import SuggestionsCard from "./SuggestionsCard";
import ZoneBalanceSection from "./ZoneBalanceSection";
import PeakSection from "./PeakSection";
import ForecastSection from "./ForecastSection";
import LearningSection from "./LearningSection";
import ShadesSection from "./ShadesSection";
import RoomsSection from "./RoomsSection";

type Minutes = "zone_pause_min" | "room_pause_min" | "resume_min";

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

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

/** Door and window pause rules, their per-zone/room overrides, and shades. */
function DoorsWindows() {
  const [data, setData] = useState<SmartControlData | null>(null);
  const [zones, setZones] = useState<ZoneProfile[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [overriding, setOverriding] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSmartControl(), getZones(), getRooms()])
      .then(([d, z, r]) => {
        if (cancelled) return;
        setData(d);
        setZones(z);
        setRooms(r);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadFailed) {
    return (
      <p className="form-error">Could not load Smart Control. Check that HomeClimate is running.</p>
    );
  }
  if (!data) return <p className="page-subtitle">Loading…</p>;

  const s = data.settings;
  const saved = (d: SmartControlData) => {
    setData(d);
    setErr(null);
  };
  const saveSetting = async (patch: Partial<OpeningSettings>) => {
    setErr(null);
    try {
      saved(await updateOpeningSettings(patch));
    } catch (e) {
      setErr(errorText(e, "Could not save the setting"));
    }
  };

  return (
    <>
      <section className="sc-section" id="doors-windows">
        <h2 className="sc-section-title">Doors &amp; Windows</h2>
        <p className="sc-section-lead">
          Stop conditioning air that is going straight outside. Add door and window sensors to rooms
          in My Home.
        </p>
        <RuleRow
          id="zone-pause"
          title="Pause Zone When a Door or Window Is Open For"
          help="The thermostat stops until every door and window that pauses the zone is closed."
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
        <h2 className="sc-section-title">Overrides</h2>
        <p className="sc-section-lead">
          Give a zone or a room its own timing. Everything else uses the rules above.
        </p>
        {zones.length === 0 && <p className="empty-panel">No zones yet. Add them in My Home.</p>}
        {zones.map((z) => {
          const open = overriding === z.thermostat_entity_id;
          return (
            <div className="sensor-zone" key={z.thermostat_entity_id}>
              <div className="sensor-zone-head">
                <span className="sensor-zone-name" title={z.thermostat_entity_id}>
                  {z.name || <EntityName id={z.thermostat_entity_id} />}
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
                <OverrideEditor
                  data={data}
                  zone={z}
                  rooms={rooms.filter((r) => r.thermostat_entity_id === z.thermostat_entity_id)}
                  onSaved={saved}
                />
              )}
            </div>
          );
        })}
      </section>

      <ShadesSection rooms={rooms} />
    </>
  );
}

export default function SmartControl() {
  const [params] = useSearchParams();
  // An unknown or planned section falls back to the first one.
  const asked = params.get("section");
  const section = (
    SMART_CONTROL_SECTIONS.find((x) => x.id === asked && !x.planned) ?? SMART_CONTROL_SECTIONS[0]
  ).id;
  return (
    <SectionLayout
      title="Smart Control"
      subtitle="Tune how HomeClimate runs your home."
      basePath="/smart-control"
      sections={SMART_CONTROL_SECTIONS}
      current={section}
    >
      {section === "doors-windows" ? (
        <DoorsWindows />
      ) : section === "smart-learning" ? (
        <>
          <LearningSection />
          <SuggestionsCard />
          <RoomUsageCard />
        </>
      ) : section === "auto-mode" ? (
        <BuildingAutoCard />
      ) : section === "forecasts" ? (
        <ForecastSection />
      ) : section === "fireplace" ? (
        <FireplaceSection />
      ) : section === "eco-mode" ? (
        <EcoSection />
      ) : section === "zone-balance" ? (
        <ZoneBalanceSection />
      ) : section === "fan" ? (
        <FanSection />
      ) : section === "peak-hours" ? (
        <PeakSection />
      ) : section === "rooms" ? (
        <RoomsSection />
      ) : (
        <div className="embedded-page">
          <Schedules />
        </div>
      )}
    </SectionLayout>
  );
}
