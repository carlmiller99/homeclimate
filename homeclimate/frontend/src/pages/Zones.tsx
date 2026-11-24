import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import EntityPicker from "../components/EntityPicker";
import {
  BACKUP_HEAT_LABELS,
  createBuilding,
  deleteBuilding,
  equipmentSummary,
  getBuildings,
  getZones,
  groupByBuilding,
  updateBuilding,
  updateZone,
  type BackupHeat,
  type Building,
  type SystemType,
  type ZoneProfile,
} from "../zonesApi";

export const HEAT_KIT_WARNING =
  "Backup heat is set to electric strips. Confirm a heater kit is installed in the air handler, or set Backup Heat to None.";

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
  const [form, setForm] = useState({
    building_id: zone.building_id,
    system_type: zone.system_type,
    compressor_stages: zone.compressor_stages,
    backup_heat: zone.backup_heat,
    equipment_running_entity: zone.equipment_running_entity,
    heat_kit_confirmed: zone.heat_kit_confirmed,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hp = form.system_type === "heat_pump";
  const needsKitCheck = hp && form.backup_heat === "electric" && !form.heat_kit_confirmed;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      onSaved(await updateZone(zone.thermostat_entity_id, form));
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
        <div className="zone-editor-title">
          <div className="zone-name">{zone.name || zone.thermostat_entity_id}</div>
          <div className="zone-entity">{zone.thermostat_entity_id}</div>
        </div>
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
            Backup Heat
            <select
              className="form-control"
              value={form.backup_heat}
              onChange={(e) =>
                setForm((f) => ({ ...f, backup_heat: e.target.value as BackupHeat }))
              }
            >
              {(Object.keys(BACKUP_HEAT_LABELS) as BackupHeat[]).map((k) => (
                <option key={k} value={k}>
                  {BACKUP_HEAT_LABELS[k]}
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
          <div className="notice notice-heat" role="note">
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

        {err && <p className="form-error">{err}</p>}
        <div className="zone-editor-actions">
          <Link className="btn btn-secondary" to="/thermostats">
            Thermostat Settings
          </Link>
          <span className="spacer" />
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            Save Zone
          </button>
        </div>
      </div>
    </section>
  );
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
  const remove = async () => {
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
        </>
      ) : (
        <>
          <h2 className="group-header-title">{building.name}</h2>
          <span className="group-header-rule" />
          <button type="button" className="link-button" onClick={() => setEditing(true)}>
            Rename
          </button>
          <button type="button" className="link-button" onClick={remove}>
            Delete
          </button>
        </>
      )}
      {err && <p className="form-error group-header-error">{err}</p>}
    </div>
  );
}

export default function Zones() {
  const [zones, setZones] = useState<ZoneProfile[] | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [z, b] = await Promise.all([getZones(), getBuildings()]);
      setZones(z);
      setBuildings(b);
    } catch {
      setErr("Could not load zones");
      setZones([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const groups = groupByBuilding(buildings, zones ?? [], (z) => z.building_id);

  return (
    <div className="zones-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Zones</h1>
          <p className="page-subtitle">One zone per thermostat, grouped by building.</p>
        </div>
        <div className="page-actions">
          <Link className="btn btn-secondary" to="/thermostats">
            Add Thermostat
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

      {zones !== null && zones.length === 0 && buildings.length === 0 && (
        <div className="empty-panel">No zones yet. Add a thermostat to create the first zone.</div>
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
          {g.items.length === 0 && (
            <div className="empty-panel">
              No zones in this building yet. Edit a zone to move it here.
            </div>
          )}
          {g.items.map((z) =>
            editing === z.thermostat_entity_id ? (
              <ZoneEditor
                key={z.thermostat_entity_id}
                zone={z}
                buildings={buildings}
                onCancel={() => setEditing(null)}
                onSaved={(saved) => {
                  setEditing(null);
                  setZones((all) =>
                    (all ?? []).map((x) =>
                      x.thermostat_entity_id === saved.thermostat_entity_id ? saved : x
                    )
                  );
                }}
              />
            ) : (
              <div key={z.thermostat_entity_id} className="zone-row">
                <div className="zone-row-title">
                  <div className="zone-name">{z.name || z.thermostat_entity_id}</div>
                  <div className="zone-entity">{z.thermostat_entity_id}</div>
                </div>
                <span className="pill">{equipmentSummary(z)}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditing(z.thermostat_entity_id)}
                >
                  Edit
                </button>
              </div>
            )
          )}
        </section>
      ))}
    </div>
  );
}
