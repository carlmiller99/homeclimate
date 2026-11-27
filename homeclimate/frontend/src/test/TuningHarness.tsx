import { useEffect, useState } from "react";
import { getRooms, getThermostats, type Room, type ThermostatConfig } from "../api";
import { RoomSettings } from "../pages/Rooms";

/**
 * Test support: a room's Fine Tuning form on its own, without the Rooms page
 * around it. Lists a Change button per room and opens the form for it.
 */
export default function TuningHarness() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [zones, setZones] = useState<ThermostatConfig[]>([]);
  const [open, setOpen] = useState<Room | null>(null);
  const load = async () => {
    const [r, z] = await Promise.all([getRooms(), getThermostats()]);
    setRooms(r);
    setZones(z);
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      {rooms.map((r) => (
        <button key={r.id} type="button" onClick={() => setOpen(r)}>
          {`Change ${r.name}`}
        </button>
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
            setRooms(rooms.map((r) => (r.id === saved.id ? { ...r, ...saved } : r)));
            void load();
          }}
        />
      )}
    </>
  );
}
