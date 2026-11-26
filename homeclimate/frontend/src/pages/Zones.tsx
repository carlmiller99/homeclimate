import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import AirIntakeField from "../components/AirIntakeField";
import ConfirmDialog from "../components/ConfirmDialog";
import EntityPicker from "../components/EntityPicker";
import {
  createThermostat,
  deleteThermostat,
  getEntityStates,
  getThermostats,
  type ThermostatConfig,
} from "../api";
import { useUnit } from "../contexts";
import { ThermostatCard } from "./Thermostats";
import {
  BACKUP_HEAT_LABELS,
  heatLabels,
  createBuilding,
  deleteBuilding,
  equipmentSummary,
  getBuildings,
  getEquipmentHint,
  getZones,
  groupByBuilding,
  updateBuilding,
  updateZone,
  type BackupHeat,
  type Building,
  type EquipmentHint,
  type SystemType,
  type ZoneProfile,
} from "../zonesApi";

type GuardKey =
  | "hp_max_step_f"
  | "hp_recovery_f_per_hr"
  | "hp_min_runtime_min"
  | "hp_min_open_heat_pct"
  | "hp_switchover_gap_min"
  | "hp_compressor_lockout_f";

const HP_GUARDS: {
  key: GuardKey;
  label: string;
  help: string;
  unit: "temp" | "rate" | "min" | "%";
  nullable?: boolean;
  /** Only applies while auxiliary heat is avoided. */
  avoidOnly?: boolean;
}[] = [
  {
    key: "hp_max_step_f",
    label: "Max Setpoint Step",
    help: "How far above the thermostat's reading the setpoint is ever set when heating.",
    unit: "temp",
    avoidOnly: true,
  },
  {
    key: "hp_recovery_f_per_hr",
    label: "Max Recovery Rate",
    help: "A warm-up's setpoint climbs no faster than this.",
    unit: "rate",
    avoidOnly: true,
  },
  {
    key: "hp_min_runtime_min",
    label: "Minimum Run Time",
    help: "Longer cycles are more efficient for a heat pump.",
    unit: "min",
  },
  {
    key: "hp_min_open_heat_pct",
    label: "Minimum Open Vents When Heating",
    help: "Heat pumps need more airflow when heating.",
    unit: "%",
  },
  {
    key: "hp_switchover_gap_min",
    label: "Minimum Time Between Heat and Cool",
    help: "Protects the reversing valve in swing weather.",
    unit: "min",
  },
  {
    key: "hp_compressor_lockout_f",
    label: "Compressor Lockout Below",
    help: "Copy the ecobee setting here. Used for planning only.",
    unit: "temp",
    nullable: true,
  },
];

type AuxPolicy = "avoid" | "allow";

const AUX_POLICY_LABELS: Record<AuxPolicy, string> = {
  avoid: "Avoid",
  allow: "Allow When Needed",
};

export const AUX_HEAT_EXPLAINER =
  "Auxiliary heat (also called aux, backup or emergency heat) is the electric heater strips or gas furnace in the air handler. The thermostat turns it on when the heat pump can't keep up: on very cold days, or when the setpoint jumps several degrees. It heats quickly, but electric strips cost about two to three times as much to run as the heat pump.";

const AUX_POLICY_HELP: Record<AuxPolicy, string> = {
  avoid:
    "HomeClimate raises the heat in small steps, starts warm-ups early, and eases off for an hour if auxiliary heat comes on anyway. Rooms warm more slowly.",
  allow:
    "HomeClimate sets the heat like a conventional system. Rooms warm faster, and the thermostat may bring on auxiliary heat to get there. The settings below still apply, except the setpoint step and recovery rate.",
};

const STRIPS_EXPECTED_HELP =
  "Outdoors is below the compressor lockout, so auxiliary heat will do the work. Warm-ups don't start early and the deadband is 1 °F wider.";

export const HEAT_KIT_WARNING =
  "Auxiliary heat is set to electric strips. Confirm a heater kit is installed in the air handler, or set Auxiliary Heat to None.";

function ZoneEditor({
  zone,
  buildings,
  onSaved,
  onCancel,
}: {
  zone: ZoneProfile;
  buildings: Building[];
  onSaved: (z: ZoneProfile) => void;
  onCancel: () => void;
}) {
  const { toDisplay, toDisplayDelta, unitLabel } = useUnit();
  // Form state holds DISPLAY units; the backend converts on write (#231).
  const [form, setForm] = useState({
    building_id: zone.building_id,
    system_type: zone.system_type,
    compressor_stages: zone.compressor_stages,
    backup_heat: zone.backup_heat,
    equipment_running_entity: zone.equipment_running_entity,
    heat_kit_confirmed: zone.heat_kit_confirmed,
    hp_max_step_f: toDisplayDelta(zone.hp_max_step_f),
    hp_recovery_f_per_hr: toDisplayDelta(zone.hp_recovery_f_per_hr),
    hp_min_runtime_min: zone.hp_min_runtime_min,
    hp_min_open_heat_pct: zone.hp_min_open_heat_pct,
    hp_switchover_gap_min: zone.hp_switchover_gap_min,
    hp_compressor_lockout_f:
      zone.hp_compressor_lockout_f === null ? null : toDisplay(zone.hp_compressor_lockout_f),
    hp_aux_policy: zone.hp_aux_policy,
    air_intake: zone.air_intake,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hp = form.system_type === "heat_pump";
  const needsKitCheck = hp && form.backup_heat === "electric" && !form.heat_kit_confirmed;

  const save = async () => {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      onSaved(await updateZone(zone.thermostat_entity_id, form));
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save this zone");
    } finally {
      setSaving(false);
    }
  };

  const setSystem = (t: SystemType) => setForm((f) => ({ ...f, system_type: t }));

  return (
    <section className="zone-editor" aria-label={`Edit ${zone.name || zone.thermostat_entity_id}`}>
      <div className="zone-editor-head">
        <label className="field-inline">
          Building
          <select
            className="form-control"
            value={form.building_id ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, building_id: e.target.value || null }))}
          >
            <option value="">Unassigned</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="zone-editor-body">
        <h3 className="zone-section-title">Equipment</h3>
        <div className="zone-fields">
          <div>
            <div id={`st-${zone.thermostat_entity_id}`} className="field-label">
              System Type
            </div>
            <div
              role="radiogroup"
              aria-labelledby={`st-${zone.thermostat_entity_id}`}
              className="segmented"
            >
              <button
                type="button"
                role="radio"
                aria-checked={!hp}
                className="segmented-option"
                onClick={() => setSystem("conventional")}
              >
                Conventional
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={hp}
                className="segmented-option"
                onClick={() => setSystem("heat_pump")}
              >
                Heat Pump
              </button>
            </div>
          </div>
          <label className="field-stack">
            Compressor Stages
            <select
              className="form-control"
              value={form.compressor_stages}
              onChange={(e) =>
                setForm((f) => ({ ...f, compressor_stages: Number(e.target.value) }))
              }
            >
              <option value={1}>1 Stage</option>
              <option value={2}>2 Stage</option>
              <option value={3}>3 Stage</option>
            </select>
          </label>
          <label className="field-stack">
            {hp ? "Auxiliary Heat" : "Heat"}
            <select
              className="form-control"
              value={form.backup_heat}
              onChange={(e) =>
                setForm((f) => ({ ...f, backup_heat: e.target.value as BackupHeat }))
              }
            >
              {(Object.keys(BACKUP_HEAT_LABELS) as BackupHeat[]).map((k) => (
                <option key={k} value={k}>
                  {heatLabels(form.system_type)[k]}
                </option>
              ))}
            </select>
          </label>
          <div className="field-stack">
            <span>Equipment Running Source</span>
            {form.equipment_running_entity ? (
              <div className="entity-chip-row">
                <span className="entity-chip">{form.equipment_running_entity}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setForm((f) => ({ ...f, equipment_running_entity: null }))}
                >
                  Clear
                </button>
              </div>
            ) : (
              <EntityPicker
                domain={["climate", "sensor"]}
                placeholder="Not set"
                onSelect={(id) => setForm((f) => ({ ...f, equipment_running_entity: id }))}
              />
            )}
          </div>
        </div>
        <p className="field-help">
          An ecobee cloud thermostat or a strip-heat power sensor lets HomeClimate see when backup
          heat runs.
        </p>

        {needsKitCheck && (
          <div className="note-box notice-heat" role="note">
            <p>{HEAT_KIT_WARNING}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setForm((f) => ({ ...f, heat_kit_confirmed: true }))}
            >
              Confirmed
            </button>
          </div>
        )}

        {hp && (
          <>
            <h3 className="zone-section-title">Heat Pump Protection</h3>
            <p className="field-help">
              Keeps the heat pump doing the work so auxiliary heat stays off.
            </p>
            <div className="aux-policy">
              <span className="field-label" id={`aux-${zone.thermostat_entity_id}`}>
                When to Use Auxiliary Heat
              </span>
              <p className="field-help">{AUX_HEAT_EXPLAINER}</p>
              <div
                role="radiogroup"
                aria-labelledby={`aux-${zone.thermostat_entity_id}`}
                className="segmented"
              >
                {(Object.keys(AUX_POLICY_LABELS) as AuxPolicy[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={form.hp_aux_policy === k}
                    className="segmented-option"
                    onClick={() => setForm((f) => ({ ...f, hp_aux_policy: k }))}
                  >
                    {AUX_POLICY_LABELS[k]}
                  </button>
                ))}
              </div>
              <p className="field-help">{AUX_POLICY_HELP[form.hp_aux_policy]}</p>
            </div>
            <div className="guard-list">
              {HP_GUARDS.map((g) => {
                const value = form[g.key];
                const unit =
                  g.unit === "temp" ? unitLabel : g.unit === "rate" ? `${unitLabel}/hr` : g.unit;
                return (
                  <div className="guard-row" key={g.key}>
                    <div className="guard-text">
                      <label htmlFor={`${g.key}-${zone.thermostat_entity_id}`}>{g.label}</label>
                      <p className="field-help">{g.help}</p>
                    </div>
                    <input
                      id={`${g.key}-${zone.thermostat_entity_id}`}
                      disabled={g.avoidOnly && form.hp_aux_policy === "allow"}
                      className="form-control guard-input"
                      type="number"
                      step={g.unit === "temp" || g.unit === "rate" ? 0.1 : 1}
                      value={value ?? ""}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setForm((f) => ({
                          ...f,
                          [g.key]: raw === "" && g.nullable ? null : parseFloat(raw),
                        }));
                      }}
                    />
                    <span className="guard-unit">{unit}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <AirIntakeField
          entityId={zone.thermostat_entity_id}
          zoneName={zone.name || zone.thermostat_entity_id}
          value={form.air_intake}
          onChange={(air_intake) => setForm((f) => ({ ...f, air_intake }))}
        />

        {err && <p className="form-error">{err}</p>}
        <div className="zone-editor-actions">
          {saved && (
            <span className="field-help" role="status">
              Zone saved.
            </span>
          )}
          <span className="spacer" />
          {/* Saving keeps the zone open: the thermostat settings below save
              separately, and closing here would drop edits made to them. */}
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            Save Zone
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * My Home → Edit Zone: one dialog for everything about a zone. Its equipment
 * and its thermostat's settings are two tabs of the same sheet; both stay
 * mounted, so switching tabs keeps what was typed in the other. Only Close
 * closes it: a stray click beside the sheet must not drop two unsaved forms.
 */
function EditZoneDialog({
  zone,
  equipment,
  thermostat,
  onClose,
  onDelete,
}: {
  zone: ZoneProfile;
  onDelete: () => void;
  equipment: ReactNode;
  thermostat: ReactNode;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"equipment" | "thermostat">("equipment");
  const name = zone.name || zone.thermostat_entity_id;
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit zone ${name}`}
    >
      <div className="modal edit-zone">
        <div className="edit-zone-head">
          <div>
            <div className="modal-title">{`Edit ${name}`}</div>
            <div className="zone-entity">{zone.thermostat_entity_id}</div>
          </div>
          <span className="edit-zone-actions">
            <button
              type="button"
              className="link-button"
              aria-label={`Delete Zone ${name}`}
              onClick={onDelete}
            >
              Delete Zone
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        {thermostat && (
          <div className="segmented" role="tablist" aria-label="Zone settings">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "equipment"}
              className="segmented-option"
              onClick={() => setTab("equipment")}
            >
              Equipment
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "thermostat"}
              className="segmented-option"
              onClick={() => setTab("thermostat")}
            >
              Thermostat
            </button>
          </div>
        )}
        <div role="tabpanel" aria-label="Equipment" hidden={tab !== "equipment"}>
          {equipment}
        </div>
        {thermostat && (
          <div role="tabpanel" aria-label="Thermostat" hidden={tab !== "thermostat"}>
            {thermostat}
          </div>
        )}
      </div>
    </div>
  );
}

/** "climate.north_wing" as "North Wing", when Home Assistant gives no name. */
function prettyEntity(id: string): string {
  return (id.split(".").pop() ?? id)
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function BuildingHeader({
  building,
  onRenamed,
  onDeleted,
}: {
  building: Building;
  onRenamed: (b: Building) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(building.name);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    try {
      onRenamed(await updateBuilding(building.id, { name }));
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not rename this building");
    }
  };
  const [confirming, setConfirming] = useState(false);
  const remove = async () => {
    setConfirming(false);
    setErr(null);
    try {
      await deleteBuilding(building.id);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete this building");
    }
  };

  return (
    <div className="group-header">
      {editing ? (
        <>
          <input
            className="form-control group-header-input"
            aria-label="Building name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={save}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setEditing(false);
              setName(building.name);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="link-button"
            aria-label={`Delete ${building.name}`}
            onClick={() => setConfirming(true)}
          >
            Delete Building
          </button>
        </>
      ) : (
        <>
          <h2 className="group-header-title">{building.name}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={`Edit ${building.name}`}
            title="Rename or delete this building"
            onClick={() => setEditing(true)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M11.3 1.8a1.5 1.5 0 0 1 2.1 0l.8.8a1.5 1.5 0 0 1 0 2.1l-8 8L2.5 13.5l.8-3.7 8-8Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="group-header-rule" />
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Delete building?"
          message={`Delete "${building.name}"? Its zones and rooms are kept and moved to Unassigned, where each zone chooses heating or cooling for itself. The building's mode and zone balance settings are removed. Zones that followed the building's targets keep them as their own.`}
          confirmLabel="Delete Building"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      )}
      {err && <p className="form-error group-header-error">{err}</p>}
    </div>
  );
}

const ZONE_NOT_FINISHED =
  "The zone was added, but its building and kind of system could not be saved. Edit the zone to set them.";

const VENT_COUNT_HELP =
  "Count every register this thermostat serves, smart vents and ordinary ones. " +
  "HomeClimate uses it to keep enough vents open to protect the equipment.";

const LOOKS_LIKE_HEAT_PUMP: Record<"aux" | "plain", string> = {
  aux: "This looks like a heat pump with auxiliary heat. Is that right?",
  plain: "This looks like a heat pump. Is that right?",
};

/**
 * Register a thermostat as a zone in one building, together with its first
 * room. The kind of system is asked for, never assumed: a heat pump left on
 * the conventional settings gets none of its protection.
 */
function AddZone({
  building,
  taken,
  onAdded,
  onCancel,
}: {
  /** The building the zone goes in; null for a zone in no building. */
  building: Building | null;
  /** Thermostats that are already zones. */
  taken: string[];
  /** Called once the zone exists; ``warning`` when a later step failed. */
  onAdded: (warning?: string) => void;
  onCancel: () => void;
}) {
  const [thermostat, setThermostat] = useState("");
  const [name, setName] = useState("");
  const [vents, setVents] = useState("");
  const [systemType, setSystemType] = useState<SystemType | null>(null);
  const [stages, setStages] = useState(1);
  // Asked for, like the system type: "electric strips" is not a safe guess.
  const [backupHeat, setBackupHeat] = useState<BackupHeat | "">("");
  const [hint, setHint] = useState<EquipmentHint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The backend requires a whole number of registers, at least one (#213).
  const ventCount = /^\d+$/.test(vents.trim()) ? parseInt(vents, 10) : 0;
  // Registering a thermostat again would overwrite that zone's settings.
  const isTaken = taken.includes(thermostat);

  // Ask Home Assistant what the chosen thermostat looks like. A suggestion
  // only: the answer never fills in the choice for the user.
  useEffect(() => {
    setHint(null);
    if (!thermostat) return;
    let cancelled = false;
    getEquipmentHint(thermostat)
      .then((h) => {
        if (!cancelled) setHint(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [thermostat]);

  const add = async () => {
    setErr(null);
    setSaving(true);
    try {
      await createThermostat({
        thermostat_entity_id: thermostat,
        name: name.trim(),
        total_vents_count: ventCount,
      });
      try {
        await updateZone(thermostat, {
          system_type: systemType!,
          compressor_stages: stages,
          backup_heat: backupHeat as BackupHeat,
          ...(building ? { building_id: building.id } : {}),
        });
      } catch {
        // The zone exists; only its building and equipment are missing.
        onAdded(ZONE_NOT_FINISHED);
        return;
      }
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add the zone");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card add-building" role="group" aria-label="Add Zone">
      <p className="field-help">
        {building
          ? `A zone in ${building.name}: one thermostat and the rooms it serves. Add its rooms once the zone exists.`
          : "A zone is one thermostat and the rooms it serves. Add its rooms once the zone exists."}
      </p>
      <div className="add-sensor-fields">
        <div className="field-stack">
          <span className="field-label">Thermostat</span>
          {thermostat ? (
            <div className="picked-entity">
              <span>{thermostat}</span>
              <button type="button" className="link-button" onClick={() => setThermostat("")}>
                Change
              </button>
            </div>
          ) : (
            <EntityPicker
              domain="climate"
              placeholder="Search thermostats…"
              onSelect={setThermostat}
            />
          )}
        </div>
        <label className="field-stack">
          Zone Name
          <input
            className="form-control"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Upstairs"
          />
        </label>
        <label className="field-stack">
          Total Vent Count
          <input
            className="form-control"
            type="number"
            min="1"
            step="1"
            value={vents}
            onChange={(e) => setVents(e.target.value)}
            placeholder="12"
          />
        </label>
      </div>
      <p className="field-help">{VENT_COUNT_HELP}</p>

      <div className="add-sensor-fields">
        <div className="field-stack">
          <span id="add-zone-system" className="field-label">
            What Kind of System Is This?
          </span>
          <div role="radiogroup" aria-labelledby="add-zone-system" className="segmented">
            <button
              type="button"
              role="radio"
              aria-checked={systemType === "conventional"}
              className="segmented-option"
              title="A furnace or electric heat with a separate air conditioner"
              onClick={() => setSystemType("conventional")}
            >
              Conventional
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={systemType === "heat_pump"}
              className="segmented-option"
              title="One outdoor unit that both heats and cools"
              onClick={() => setSystemType("heat_pump")}
            >
              Heat Pump
            </button>
          </div>
        </div>
        <label className="field-stack">
          Compressor Stages
          <select
            className="form-control"
            value={stages}
            onChange={(e) => setStages(Number(e.target.value))}
          >
            <option value={1}>1 Stage</option>
            <option value={2}>2 Stage</option>
            <option value={3}>3 Stage</option>
          </select>
        </label>
        <label className="field-stack">
          {systemType === "heat_pump" ? "Auxiliary Heat" : "Heat"}
          <select
            className="form-control"
            value={backupHeat}
            onChange={(e) => setBackupHeat(e.target.value as BackupHeat | "")}
          >
            <option value="">Choose…</option>
            {(Object.keys(BACKUP_HEAT_LABELS) as BackupHeat[]).map((k) => (
              <option key={k} value={k}>
                {heatLabels(systemType)[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {hint?.system_type === "heat_pump" && systemType !== "heat_pump" && (
        <p className="field-help" role="status">
          {LOOKS_LIKE_HEAT_PUMP[hint.auxiliary_heat ? "aux" : "plain"]}{" "}
          <button type="button" className="link-button" onClick={() => setSystemType("heat_pump")}>
            Yes, Heat Pump
          </button>
        </p>
      )}
      {(!systemType || !backupHeat) && (
        <p className="field-help">
          Choose the kind of system and its heat. HomeClimate protects a heat pump differently and
          treats electric strips as costly to run, so it does not guess.
        </p>
      )}

      {isTaken && (
        <p className="form-error">
          That thermostat is already a zone. Use Add Room to add a room to it.
        </p>
      )}
      {err && <p className="form-error">{err}</p>}
      <div className="zone-editor-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            isTaken ||
            !thermostat ||
            !name.trim() ||
            ventCount < 1 ||
            !systemType ||
            !backupHeat ||
            saving
          }
          onClick={add}
        >
          Add Zone
        </button>
      </div>
    </div>
  );
}

/**
 * The structure half of My Home: buildings, zones (with equipment and
 * thermostat settings), and — through ``renderRooms`` — each zone's rooms.
 */
export default function Zones({
  title = "My Home",
  subtitle = "Buildings, zones and rooms, and the devices in each room.",
  renderRooms,
  reloadKey = 0,
  onChanged,
}: {
  title?: string;
  subtitle?: string;
  renderRooms?: (thermostatEntityId: string) => ReactNode;
  reloadKey?: number;
  onChanged?: () => void;
}) {
  const [zones, setZones] = useState<ZoneProfile[] | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [configs, setConfigs] = useState<ThermostatConfig[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The group whose Add Zone form is open: a building id, or "" for Unassigned.
  const [addingZoneIn, setAddingZoneIn] = useState<string | null>(null);
  // What Home Assistant calls each thermostat, for the line under a zone's name.
  const [friendly, setFriendly] = useState<Record<string, string>>({});
  const zoneIds = (zones ?? []).map((z) => z.thermostat_entity_id).join();
  useEffect(() => {
    if (!zoneIds) return;
    let cancelled = false;
    void (async () => {
      try {
        const states = (await getEntityStates(zoneIds.split(","))) ?? {};
        const names: Record<string, string> = {};
        for (const [id, st] of Object.entries(states)) {
          const name = st?.attributes?.friendly_name;
          if (typeof name === "string" && name) names[id] = name;
        }
        if (!cancelled) setFriendly(names);
      } catch {
        // The entity id, tidied, stands in.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zoneIds]);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ZoneProfile | null>(null);

  const deleteZone = async (z: ZoneProfile) => {
    setDeleting(null);
    setEditing(null);
    setErr(null);
    try {
      await deleteThermostat(z.thermostat_entity_id, true);
      await changed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete this zone");
    }
  };

  const load = useCallback(async () => {
    try {
      const [z, b, c] = await Promise.all([getZones(), getBuildings(), getThermostats()]);
      setZones(z);
      setBuildings(b);
      setConfigs(c);
    } catch {
      setErr("Could not load zones");
      setZones([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const changed = async () => {
    await load();
    onChanged?.();
  };

  const addBuilding = async () => {
    setErr(null);
    try {
      await createBuilding(newName);
      setNewName("");
      setAdding(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add the building");
    }
  };

  const zoneList = zones ?? [];
  const groups = groupByBuilding(buildings, zoneList, (z) => z.building_id);

  return (
    <div className="zones-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-secondary" to="/import">
            Set Up from Home Assistant
          </Link>
          <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>
            Add Building
          </button>
        </div>
      </div>

      {adding && (
        <div className="card add-building">
          <label className="field-stack">
            Building Name
            <input
              className="form-control"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Main House"
            />
          </label>
          <div className="zone-editor-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={addBuilding}>
              Add Building
            </button>
          </div>
        </div>
      )}

      {err && <p className="form-error">{err}</p>}
      {deleting && (
        <ConfirmDialog
          title="Delete zone?"
          message={`Delete the zone "${deleting.name || deleting.thermostat_entity_id}" and all of its rooms? HomeClimate stops controlling its thermostat. This cannot be undone.`}
          confirmLabel="Delete Zone"
          onCancel={() => setDeleting(null)}
          onConfirm={() => void deleteZone(deleting)}
        />
      )}

      {zones !== null && zones.length === 0 && buildings.length === 0 && (
        <div className="empty-panel">
          Nothing here yet. Add a building, then add its zones and their rooms, or set up from Home
          Assistant.
        </div>
      )}

      {groups.map((g) => (
        <section key={g.building?.id ?? "unassigned"} className="building-group">
          {g.building ? (
            <BuildingHeader
              building={g.building}
              onRenamed={(b) => setBuildings((all) => all.map((x) => (x.id === b.id ? b : x)))}
              onDeleted={() => void load()}
            />
          ) : (
            <div className="group-header">
              <h2 className="group-header-title">Unassigned</h2>
              <span className="group-header-rule" />
            </div>
          )}
          {addingZoneIn === (g.building?.id ?? "") && (
            <AddZone
              building={g.building}
              taken={zoneList.map((z) => z.thermostat_entity_id)}
              onCancel={() => setAddingZoneIn(null)}
              onAdded={(warning) => {
                setAddingZoneIn(null);
                void changed().then(() => setErr(warning ?? null));
              }}
            />
          )}
          {g.items.length === 0 && addingZoneIn !== (g.building?.id ?? "") && (
            <div className="empty-panel">
              No zones in this building yet. Add one below, or edit a zone to move it here.
            </div>
          )}
          {g.items.map((z) => {
            const config = configs.find((c) => c.thermostat_entity_id === z.thermostat_entity_id);
            return (
              <section
                key={z.thermostat_entity_id}
                className="zone-panel"
                aria-label={z.name || z.thermostat_entity_id}
              >
                <div className="zone-row zone-panel-head">
                  <div className="zone-row-title">
                    <div className="zone-name">
                      {z.name || z.thermostat_entity_id}
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="Edit Zone"
                        title="Edit or delete this zone"
                        onClick={() => setEditing(z.thermostat_entity_id)}
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                          <path
                            d="M11.3 1.8a1.5 1.5 0 0 1 2.1 0l.8.8a1.5 1.5 0 0 1 0 2.1l-8 8L2.5 13.5l.8-3.7 8-8Z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                    <div className="zone-entity" title={z.thermostat_entity_id}>
                      {`Thermostat: ${friendly[z.thermostat_entity_id] ?? prettyEntity(z.thermostat_entity_id)}`}
                    </div>
                  </div>
                  <span className="pill">{equipmentSummary(z)}</span>
                  {z.strips_expected && (
                    <span className="pill pill-heat" title={STRIPS_EXPECTED_HELP}>
                      Strips Expected
                    </span>
                  )}
                  {z.aux_heat_running && (
                    <span className="pill pill-heat" role="status">
                      Auxiliary Heat Running
                    </span>
                  )}
                  {z.looks_like_heat_pump && (
                    <button
                      type="button"
                      className="pill pill-heat pill-button"
                      aria-label={`${z.name || z.thermostat_entity_id} looks like a heat pump. Check its system type`}
                      onClick={() => setEditing(z.thermostat_entity_id)}
                    >
                      Looks Like a Heat Pump: Check System Type
                    </button>
                  )}
                </div>
                {editing === z.thermostat_entity_id && (
                  <EditZoneDialog
                    zone={z}
                    onClose={() => setEditing(null)}
                    onDelete={() => setDeleting(z)}
                    equipment={
                      <ZoneEditor
                        zone={z}
                        buildings={buildings}
                        onCancel={() => setEditing(null)}
                        onSaved={(saved) => {
                          setZones(
                            zoneList.map((x) =>
                              x.thermostat_entity_id === saved.thermostat_entity_id ? saved : x
                            )
                          );
                        }}
                      />
                    }
                    thermostat={
                      config && (
                        <ThermostatCard
                          embedded
                          config={config}
                          onDeleted={() => {
                            setEditing(null);
                            void changed();
                          }}
                          onSaved={(updated) => {
                            setConfigs((cs) =>
                              cs.map((x) =>
                                x.thermostat_entity_id === updated.thermostat_entity_id
                                  ? updated
                                  : x
                              )
                            );
                            // The zone's name is the thermostat's friendly name.
                            setZones(
                              zoneList.map((x) =>
                                x.thermostat_entity_id === updated.thermostat_entity_id
                                  ? { ...x, name: updated.name }
                                  : x
                              )
                            );
                          }}
                        />
                      )
                    }
                  />
                )}
                {renderRooms?.(z.thermostat_entity_id)}
              </section>
            );
          })}
          {addingZoneIn !== (g.building?.id ?? "") && (
            <button
              type="button"
              className="add-tile"
              aria-label={`Add Zone to ${g.building?.name ?? "Unassigned"}`}
              onClick={() => setAddingZoneIn(g.building?.id ?? "")}
            >
              <span className="add-tile-plus" aria-hidden="true">
                +
              </span>
              Add Zone
            </button>
          )}
        </section>
      ))}
    </div>
  );
}
