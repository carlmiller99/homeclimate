import { useCallback, useEffect, useState } from "react";
import { getRooms, getThermostats, type Room, type ThermostatConfig } from "../api";
import { useUnit } from "../contexts";
import { RoomSettings } from "./Rooms";

/** What a room has changed from its zone's settings, in a few words. */
function summary(room: Room, delta: (f: number) => number, unitLabel: string): string {
  const parts: string[] = [];
  if (room.temp_offset) parts.push(`offset ${delta(room.temp_offset)}${unitLabel}`);
  if (room.deadband_override != null)
    parts.push(`own deadband ${delta(room.deadband_override)}${unitLabel}`);
  if (room.ambient_suppression_enabled) parts.push("waits on the weather");
  if (room.eco_mode_enabled != null) parts.push(room.eco_mode_enabled ? "Eco on" : "Eco off");
  return parts.length ? parts.join(", ") : "Uses its zone's settings";
}

/**
 * Smart Control → Rooms: how each room is heated and cooled, where that
 * differs from its zone. A room's name, zone and devices are in My Home; its
 * temperatures are on the Dashboard.
 */
export default function RoomsSection() {
  const { toDisplayDelta, unitLabel } = useUnit();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [zones, setZones] = useState<ThermostatConfig[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Room | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, z] = await Promise.all([getRooms(), getThermostats()]);
      setRooms(r);
      setZones(z);
      setFailed(false);
    } catch {
      // A list already on screen stays; only a first load has nothing to show.
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (rooms === null && failed) return <p className="form-error">Could not load the rooms.</p>;
  if (rooms === null) return <p className="sc-note">Loading the rooms…</p>;

  const zoneName = (id: string) => zones.find((z) => z.thermostat_entity_id === id)?.name || id;
  const zoneIds = [...new Set(rooms.map((r) => r.thermostat_entity_id))];
  return (
    <section className="sc-section">
      <h2 className="sc-section-title">Rooms</h2>
      <p className="sc-section-lead">
        A room uses its zone&rsquo;s settings unless you change them here. Its temperatures are on
        the Dashboard.
      </p>
      {failed && (
        <p className="form-error" role="alert">
          Could not refresh the rooms. What is shown may be out of date.
        </p>
      )}
      {rooms.length === 0 && <p className="sc-note">No rooms yet. Add one in My Home.</p>}
      {zoneIds.map((zid) => (
        <div className="card" key={zid} role="group" aria-label={zoneName(zid)}>
          <h3 className="card-title">{zoneName(zid)}</h3>
          <ul className="room-tuning-list">
            {rooms
              .filter((r) => r.thermostat_entity_id === zid)
              .map((r) => (
                <li key={r.id}>
                  <span className="room-tuning-name">{r.name}</span>
                  <span className="room-tuning-summary">
                    {summary(r, toDisplayDelta, unitLabel)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-label={`Change ${r.name}`}
                    onClick={() => setOpen(r)}
                  >
                    Change
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
      {open && (
        <RoomSettings
          room={open}
          part="tuning"
          rooms={rooms}
          thermostats={zones}
          onCancel={() => setOpen(null)}
          onSaved={(saved) => {
            setOpen(null);
            // Shown at once, so opening the room again starts from what was saved.
            setRooms(rooms.map((r) => (r.id === saved.id ? { ...r, ...saved } : r)));
            void load();
          }}
        />
      )}
    </section>
  );
}
