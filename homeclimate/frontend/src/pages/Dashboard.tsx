import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  getStatus,
  getRooms,
  getThermostats,
  getVacationMode,
  getOverrides,
  clearOverride,
  clearPresenceHoldover,
  connectWS,
  getEntityStates,
  getRoom,
  getSensorHealth,
  type ZoneStatus,
  type Room,
  type RoomOverrideHold,
  type ThermostatConfig,
  type VacationMode,
} from "../api";
import { vacationState } from "../vacation";
import {
  getBuildings,
  getZones,
  groupByBuilding,
  type Building,
  type ZoneProfile,
} from "../zonesApi";
import { bandText } from "../bands";
import BuildingModeControl from "../components/BuildingModeControl";
import { getBuildingModes, type BuildingMode } from "../buildingModeApi";
import TodayCard from "../components/TodayCard";
import ConfirmDialog from "../components/ConfirmDialog";
import HouseBandCard from "../components/HouseBandCard";
import RoomFollowDialog from "../components/RoomFollowDialog";
import { calendarFor, getHouse, switchesFor, type House } from "../houseApi";
import { getSmartControl, type SmartControl } from "../smartControlApi";
import { useSystem, useTimeZone, useUnit } from "../contexts";
import { onStateChanged } from "../stateEvents";
import { Frozen, FROZEN } from "../ci";
import AirflowConfigBanner from "../components/AirflowConfigBanner";
import StaleSensorsBanner from "../components/StaleSensorsBanner";
import UnavailableThermostatsBanner from "../components/UnavailableThermostatsBanner";
import VacationModeModal from "../components/VacationModeModal";
import EcoSuspendModal from "../components/EcoSuspendModal";
import HoldModal from "../components/HoldModal";
import { formatCountdown } from "../countdown";
import Time from "../components/Time";

/**
 * A room's temperature (°F) the way the engine works it out: the mean of its
 * fresh sensor readings, plus the thermostat's own reading when the room
 * includes it. Null when nothing has reported.
 */
function roomAverage(
  sensorIds: string[],
  states: Record<string, { numeric?: number | null } | null>,
  stale: Set<string>,
  thermostatTemp: number | null
): number | null {
  const values = sensorIds
    .filter((id) => !stale.has(id))
    .map((id) => states[id]?.numeric)
    .filter((n): n is number => typeof n === "number");
  if (thermostatTemp != null) values.push(thermostatTemp);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** How long a room's sensor list is trusted before it is read again. */
const SENSOR_LIST_MAX_AGE_MS = 5 * 60_000;

/** The open doors and windows pausing a zone or a room, by name. */
function pausedBy(
  smart: SmartControl | null,
  scope: "zone" | "room",
  id: string,
  rooms: Room[]
): string[] | null {
  if (!smart?.paused.some((p) => p.scope === scope && p.scope_id === id)) return null;
  return smart.sensors
    .filter((c) => c.pausing && c.pauses === scope)
    .filter((c) =>
      scope === "room"
        ? c.room_id === id
        : c.thermostat_entity_id === id ||
          rooms.some((r) => r.id === c.room_id && r.thermostat_entity_id === id)
    )
    .map((c) => c.name);
}

function pausedText(names: string[]): string {
  return names.length > 0 ? `Paused: ${names.join(", ")} open` : "Paused: door or window open";
}

function modeColor(mode: string): string {
  if (mode === "cooling") return "blue";
  if (mode === "heating") return "orange";
  return "gray";
}

function modeLabel(action: string, state: string): string {
  if (action === "cooling") return "Cooling";
  if (action === "heating") return "Heating";
  if (state === "idle") return "Idle";
  if (state === "off") return "Off";
  return state;
}

/** The house band's per-room switches, and how to open a room's options. Null until loaded. */
const HouseContext = createContext<{
  house: House;
  openOptions: (room: { id: string; name: string }) => void;
} | null>(null);

function RoomRow({
  room,
  active,
  temp,
  held,
  paused,
  fireplace,
  coasting = false,
  balancing = false,
  banking = false,
  arriving = false,
  coolingEarly = false,
  onHold,
  onCancelHold,
  onClearPresence,
}: {
  room: { id: string; name: string };
  active?: ZoneStatus["rooms"][number];
  temp: number | null;
  held: boolean;
  /** Names of the open doors/windows pausing this room, or null. */
  paused: string[] | null;
  /** Name of the lit fireplace keeping this room out of demand, or null. */
  fireplace: string | null;
  /** The room's call is waiting for it to drift to its target by itself. */
  coasting?: boolean;
  /** Heated or cooled to keep its zone near another (Zone Balance). */
  balancing?: boolean;
  /** Worked into its band ahead of the peak hours (Peak Hours). */
  banking?: boolean;
  /** Got ready shortly before it is usually used (Get Rooms Ready for Usual Arrivals). */
  arriving?: boolean;
  /** Cooled a little into its band ahead of a warm afternoon (Early Cooling). */
  coolingEarly?: boolean;
  onHold: () => void;
  onCancelHold: () => void;
  onClearPresence: () => void;
}) {
  const houseCtx = useContext(HouseContext);
  const notInUse = houseCtx !== null && !switchesFor(houseCtx.house, room.id).in_use;
  const { fmtTemp } = useUnit();
  const ventEntries = Object.entries(active?.vent_states ?? {});
  const openCount = ventEntries.filter(([, s]) => s === "open").length;
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const shownTemp = active?.avg_temp ?? temp;

  const clearPresence = async () => {
    setClearing(true);
    setError("");
    try {
      await clearPresenceHoldover(room.id);
      onClearPresence();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear presence");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="dash-room" data-testid={`dash-room-${room.id}`}>
      <div className="dash-room-main">
        <span className="dash-room-name">
          {room.name}
          {held && (
            <span
              className="badge badge-purple"
              title="A temporary hold is driving this room — it overrides schedules and presence until it ends."
            >
              Hold
            </span>
          )}
          {active?.presence_active && <span className="badge badge-green">Presence</span>}
          {paused && (
            <span className="badge badge-orange" role="status" title={pausedText(paused)}>
              Paused
            </span>
          )}
          {notInUse && (
            <span
              className="badge badge-gray"
              role="status"
              title="This room is not in use: only a hold or its safety limits will heat or cool it"
            >
              Not In Use
            </span>
          )}
          {balancing && (
            <span
              className="badge badge-gray"
              role="status"
              title="Zone Balance is heating or cooling this room to keep its zone within the gap limit of another"
            >
              Zone Balance
            </span>
          )}
          {banking && (
            <span
              className="badge badge-gray"
              role="status"
              title="This room is being heated or cooled a little into its band now, so less has to run during the peak hours"
            >
              Banking
            </span>
          )}
          {arriving && (
            <span
              className="badge badge-gray"
              role="status"
              title="This room is usually used about now, so it is being brought to its occupied temperature ahead of time"
            >
              Getting Ready
            </span>
          )}
          {coolingEarly && (
            <span
              className="badge badge-gray"
              role="status"
              title="This room is being cooled a little now, because it is expected to pass its Cool To later on a warming afternoon"
            >
              Cooling Early
            </span>
          )}
          {coasting && (
            <span
              className="badge badge-gray"
              role="status"
              title="This room is a little short of its target and is expected to get there by itself, so nothing has been started for it yet"
            >
              Coasting
            </span>
          )}
          {fireplace && (
            <span
              className="badge badge-orange"
              role="status"
              title={`${fireplace} is warming this room, so it isn't calling for heating or cooling`}
            >
              Fireplace
            </span>
          )}
        </span>
        <span className="dash-room-temp">
          <span className="stat-value">{shownTemp != null ? fmtTemp(shownTemp) : "—"}</span>
          {active?.target_temp != null &&
            (active.eco_active && active.requested_target != null ? (
              <span
                className="text-sm text-muted dash-room-target"
                title="Eco Mode relaxed this room's target based on the outdoor temperature; only the setpoint sent to the thermostat is rounded to a whole degree"
              >
                {active.target_temp === active.requested_target ? (
                  <>🌿 {fmtTemp(active.target_temp)} — Eco</>
                ) : (
                  <>
                    🌿 {fmtTemp(active.target_temp)} · requested {fmtTemp(active.requested_target)}{" "}
                    — Eco
                  </>
                )}
              </span>
            ) : (
              <span
                className="text-sm text-muted dash-room-target"
                title="Temperature this room is requesting from the cycle"
              >
                🎯 requesting {fmtTemp(active.target_temp)}
              </span>
            ))}
        </span>
      </div>
      {ventEntries.length > 0 && (
        <div className="flex gap-sm" style={{ flexWrap: "wrap" }}>
          {ventEntries.map(([eid, state]) => (
            <span key={eid} className="tag">
              <span className={`vent-dot ${state}`} />
              {eid.split(".").pop()} · {state}
            </span>
          ))}
          <span className="text-sm text-muted">
            {openCount}/{ventEntries.length} open
          </span>
        </div>
      )}
      <div className="dash-room-actions">
        {held ? (
          <button
            className="btn btn-sm btn-outline-danger"
            title="End the hold now — the room returns to its schedules and presence."
            aria-label={`Cancel Hold for ${room.name}`}
            onClick={onCancelHold}
          >
            Cancel Hold
          </button>
        ) : (
          <button
            className="btn btn-sm btn-secondary"
            title="Hold this room at an exact temperature for 1–8 hours, overriding schedules and presence."
            aria-label={`Hold for ${room.name}`}
            onClick={onHold}
          >
            Hold
          </button>
        )}
        {houseCtx && (
          <button
            className="btn btn-sm btn-secondary"
            title="Choose whether this room is in use, and whether it follows its schedules and occupancy or the house band."
            aria-label={`Options for ${room.name}`}
            onClick={() => houseCtx.openOptions(room)}
          >
            Options
          </button>
        )}
        {active?.presence_active && (
          <button
            className="btn btn-sm btn-outline-danger"
            aria-label={clearing ? undefined : `Clear Presence for ${room.name}`}
            onClick={clearPresence}
            disabled={clearing}
          >
            {clearing ? "Clearing…" : "Clear Presence"}
          </button>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function roomsBlock(
  zoneRooms: { id: string; name: string }[],
  activeList: ZoneStatus["rooms"],
  temps: Record<string, number | null>,
  heldRoomIds: Set<string>,
  pausedRooms: Record<string, string[] | null>,
  fireplaceRooms: Record<string, string>,
  controls: {
    onHold: (roomId: string) => void;
    onCancelHold: (roomId: string) => void;
    onClearPresence: () => void;
  },
  coasting: string[] = [],
  balancing: string[] = [],
  banking: string[] = [],
  arriving: string[] = [],
  coolingEarly: string[] = []
) {
  // A room the cycle reports but the room list does not know yet (it was
  // added a moment ago) still gets a row, named by its id.
  const listed = [
    ...zoneRooms,
    ...activeList
      .filter((a) => !zoneRooms.some((r) => r.id === a.room_id))
      .map((a) => ({ id: a.room_id, name: a.room_id })),
  ];
  if (listed.length === 0) return null;
  return (
    <div className="dash-rooms">
      {listed.map((room) => (
        <RoomRow
          key={room.id}
          room={room}
          active={activeList.find((a) => a.room_id === room.id)}
          temp={temps[room.id] ?? null}
          held={heldRoomIds.has(room.id)}
          paused={pausedRooms[room.id] ?? null}
          fireplace={fireplaceRooms[room.id] ?? null}
          coasting={coasting.includes(room.id)}
          balancing={balancing.includes(room.id)}
          banking={banking.includes(room.id)}
          arriving={arriving.includes(room.id)}
          coolingEarly={coolingEarly.includes(room.id)}
          onHold={() => controls.onHold(room.id)}
          onCancelHold={() => controls.onCancelHold(room.id)}
          onClearPresence={controls.onClearPresence}
        />
      ))}
    </div>
  );
}

const CI_SAMPLE_ACTIVE_ROOMS: ZoneStatus["rooms"] = [
  {
    room_id: "Bedroom",
    avg_temp: 71.4,
    target_temp: 68,
    presence_active: true,
    vent_states: { "cover.bedroom_vent": "open" },
  },
  {
    room_id: "Office",
    avg_temp: 73.0,
    target_temp: 70,
    presence_active: true,
    vent_states: { "cover.office_vent": "closed" },
  },
];

function ZoneCard({
  zone,
  rooms,
  thermostats,
  heldRoomIds,
  temps,
  smart,
  onHold,
  onCancelHold,
  onClearPresence,
  onSuspendEco,
  showActiveRoomsSample,
}: {
  zone: ZoneStatus;
  rooms: Room[];
  thermostats: ThermostatConfig[];
  // #576: rooms currently driven by a temporary hold, for the per-room badge.
  heldRoomIds: Set<string>;
  temps: Record<string, number | null>;
  /** Door and window pauses; null when they could not be read. */
  smart: SmartControl | null;
  onHold: (roomId: string) => void;
  onCancelHold: (roomId: string) => void;
  onClearPresence: () => void;
  onSuspendEco: (thermostatEntityId: string) => void;
  showActiveRoomsSample: boolean;
}) {
  const { fmtTemp } = useUnit();
  const tz = useTimeZone();
  const colorClass = modeColor(zone.hvac_action);
  const label = modeLabel(zone.hvac_action, zone.hvac_mode);
  const badgeClass = `badge badge-${colorClass}`;
  const zonePaused = pausedBy(smart, "zone", zone.thermostat_entity_id, rooms);
  const tc = thermostats.find((t) => t.thermostat_entity_id === zone.thermostat_entity_id);
  const zoneRooms = rooms.filter((r) => r.thermostat_entity_id === zone.thermostat_entity_id);
  const totalRooms = zoneRooms.length;
  const pausedRooms = Object.fromEntries(
    zoneRooms.map((r) => [r.id, pausedBy(smart, "room", r.id, rooms)])
  );
  const fireplaceRooms = Object.fromEntries(
    (smart?.fireplace_rooms ?? []).map((f) => [f.room_id, f.fireplace])
  );
  const activeRooms = zone.rooms.length;
  const doneRooms = zone.rooms.filter((r) =>
    Object.values(r.vent_states).every((s) => s === "closed")
  ).length;
  const progress = activeRooms > 0 ? doneRooms / activeRooms : 0;

  return (
    <div className="card">
      <div className="flex-between" style={{ marginBottom: ".75rem" }}>
        <div>
          <div className="card-title" style={{ marginBottom: 0 }}>
            {thermostats.find((t) => t.thermostat_entity_id === zone.thermostat_entity_id)?.name ||
              zone.thermostat_entity_id.split(".").pop()?.replace(/_/g, " ")}
          </div>
          <div className="card-subtitle font-mono" style={{ marginBottom: 0, fontSize: ".75rem" }}>
            {zone.thermostat_entity_id}
          </div>
        </div>
        {/* hvac action badge flips Cooling/Heating/Idle as the engine cycles */}
        <Frozen frozen={<span className="badge badge-gray">{FROZEN}</span>}>
          <span className={badgeClass}>{label}</span>
        </Frozen>
      </div>

      <div className="stat-row">
        <span className="stat-label">Ambient</span>
        <span className="stat-value">
          {zone.current_temp != null ? fmtTemp(zone.current_temp) : "—"}
        </span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Setpoint</span>
        <span className="stat-value">{zone.setpoint != null ? fmtTemp(zone.setpoint) : "—"}</span>
      </div>
      <div className="stat-row">
        <span className="stat-label">Cycle</span>
        {/* cycle_state (running/idle) and its colour change per engine cycle */}
        <Frozen frozen={<span className="badge badge-gray">{FROZEN}</span>}>
          <span className={`badge badge-${zone.cycle_state === "running" ? "blue" : "gray"}`}>
            {zone.cycle_state}
          </span>
        </Frozen>
      </div>
      <div className="stat-row">
        <span className="stat-label">Active rooms</span>
        <span className="stat-value">
          {/* active count tracks which rooms the engine is cycling right now */}
          <Frozen>{activeRooms}</Frozen> / {totalRooms}
        </span>
      </div>

      {/* Progress bar + active-rooms list reflect live cycle membership, which
          flips between the update and verify screenshot passes. Drop them under
          CI so the card is deterministic. */}
      <Frozen frozen={null}>
        {zone.cycle_state === "running" && activeRooms > 0 && (
          <>
            <div className="progress-bar" style={{ marginTop: ".75rem" }}>
              <div
                className={`progress-fill ${colorClass === "blue" ? "cooling" : "heating"}`}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <div className="text-sm text-muted" style={{ marginTop: ".25rem" }}>
              {doneRooms}/{activeRooms} rooms at target
            </div>
          </>
        )}
      </Frozen>

      {zonePaused && (
        <div className="dash-paused" role="status">
          {pausedText(zonePaused)}
        </div>
      )}

      {/* Every room in the zone, with its manual controls. Which rooms are in
          the running cycle (and their targets and vents) changes between the
          update and verify screenshot passes, so under CI the live membership
          is replaced by a fixed sample. */}
      <Frozen
        frozen={roomsBlock(
          zoneRooms,
          !showActiveRoomsSample
            ? []
            : zoneRooms.length === 0
              ? CI_SAMPLE_ACTIVE_ROOMS
              : // Lay the sample over the zone's own first rooms.
                CI_SAMPLE_ACTIVE_ROOMS.slice(0, zoneRooms.length).map((r, i) => ({
                  ...r,
                  room_id: zoneRooms[i].id,
                })),
          temps,
          // Holds are set and cleared by the user (or a spec), not by the
          // engine, so they stay live under CI.
          heldRoomIds,
          pausedRooms,
          fireplaceRooms,
          { onHold, onCancelHold, onClearPresence }
        )}
      >
        {roomsBlock(
          zoneRooms,
          zone.rooms,
          temps,
          heldRoomIds,
          pausedRooms,
          fireplaceRooms,
          { onHold, onCancelHold, onClearPresence },
          zone.coasting_rooms,
          zone.balance_rooms,
          zone.bank_rooms,
          zone.arrival_rooms,
          zone.early_cool_rooms
        )}
      </Frozen>

      {/* Eco Suspend (Issue #500): per-zone control, shown only when Eco is in
          play for this thermostat — enabled on the thermostat, opted into by
          one of its rooms, or already suspended. Static config data — no
          <Frozen> needed. */}
      {tc &&
        (tc.eco_mode_enabled ||
          tc.eco_suspend_until ||
          zoneRooms.some((r) => r.eco_mode_enabled === true)) && (
          <div style={{ marginTop: ".75rem" }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => onSuspendEco(tc.thermostat_entity_id)}
              style={{ width: "100%" }}
              title={tc.eco_suspend_until ? tz.tooltip(tc.eco_suspend_until) : undefined}
            >
              🍃{" "}
              {tc.eco_suspend_until
                ? `Eco suspended until ${tz.format(tc.eco_suspend_until)} — manage`
                : "Suspend Eco"}
            </button>
          </div>
        )}
    </div>
  );
}

export default function Dashboard() {
  const { fmtTemp } = useUnit();
  const tz = useTimeZone();
  const [zones, setZones] = useState<ZoneStatus[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [thermostats, setThermostats] = useState<ThermostatConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [vacationMode, setVacationMode] = useState<VacationMode>({
    enabled: false,
    return_at: null,
  });
  const [showVacationModal, setShowVacationModal] = useState(false);
  // Eco Suspend modal (#500): null = closed; { thermostat } = open, optionally
  // pre-scoped to the zone card it was opened from.
  const [ecoSuspendFor, setEcoSuspendFor] = useState<{ thermostat?: string } | null>(null);
  // Temporary holds (#576): live holds for the page-level strip and the
  // per-room badges; the modal state mirrors ecoSuspendFor's shape.
  const [holds, setHolds] = useState<RoomOverrideHold[]>([]);
  const [holdModalFor, setHoldModalFor] = useState<{ room?: string } | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [profiles, setProfiles] = useState<ZoneProfile[]>([]);
  const [temps, setTemps] = useState<Record<string, number | null>>({});
  // Each room's temperature sensors, fetched once per set of rooms: the list
  // only changes when the house's structure does, unlike the readings.
  const sensorsByRoom = useRef<{ key: string; at: number; map: Record<string, string[]> }>({
    key: "",
    at: 0,
    map: {},
  });
  const [smart, setSmart] = useState<SmartControl | null>(null);
  const [house, setHouse] = useState<House | null>(null);
  const [buildingModes, setBuildingModes] = useState<BuildingMode[]>([]);
  const system = useSystem();
  const [confirmSystem, setConfirmSystem] = useState(false);
  const [optionsFor, setOptionsFor] = useState<{ id: string; name: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState("");

  const loadAll = async () => {
    const [z, r, tc, vm, hd] = await Promise.all([
      getStatus(),
      getRooms(),
      getThermostats(),
      getVacationMode(),
      // Supplementary — the dashboard must still render if the holds read fails.
      getOverrides().catch(() => [] as RoomOverrideHold[]),
    ]);
    setZones(z);
    setRooms(r);
    setThermostats(tc);
    setVacationMode(vm ?? { enabled: false, return_at: null });
    setHolds(hd);
    setLastUpdate(new Date());
    setLoading(false);
    setLoadFailed(false);
    // Building layout, pauses and idle-room temperatures are extras: a failure
    // here leaves the zone cards ungrouped and idle rooms showing "—".
    const [b, zp, sc, health, hs, bm] = await Promise.all([
      getBuildings().catch(() => [] as Building[]),
      getZones().catch(() => [] as ZoneProfile[]),
      getSmartControl().catch(() => null),
      getSensorHealth().catch(() => null),
      getHouse().catch(() => null),
      getBuildingModes().catch(() => null),
    ]);
    // A failed refresh keeps the last good house: blanking it would drop an
    // unsaved band edit and close an open Options dialog.
    if (hs) setHouse(hs);
    if (bm) setBuildingModes(bm);
    setBuildings(b);
    setProfiles(zp);
    setSmart(sc ?? null);
    const key = r.map((room) => room.id).join(",");
    const cache = sensorsByRoom.current;
    if (cache.key !== key || Date.now() - cache.at > SENSOR_LIST_MAX_AGE_MS) {
      let complete = true;
      const detailed = await Promise.all(
        r.map((room) =>
          getRoom(room.id).catch(() => {
            complete = false;
            return room;
          })
        )
      );
      sensorsByRoom.current = {
        // A list that could not be read is tried again on the next refresh.
        key: complete ? key : "",
        at: Date.now(),
        map: Object.fromEntries(
          detailed.map((d) => [d.id, d.sensors?.map((x) => x.entity_id) ?? []])
        ),
      };
    }
    const map = sensorsByRoom.current.map;
    const sensorIds = Object.values(map).flat();
    const states =
      sensorIds.length > 0
        ? await getEntityStates(sensorIds).catch(() => ({}) as Record<string, null>)
        : {};
    const stale = new Set(
      (health?.rooms ?? []).flatMap((h) => h.stale_sensors.map((x) => x.entity_id))
    );
    setTemps(
      Object.fromEntries(
        r.map((room) => [
          room.id,
          roomAverage(
            map[room.id],
            states,
            stale,
            room.include_thermostat_sensor
              ? (z.find((zone) => zone.thermostat_entity_id === room.thermostat_entity_id)
                  ?.current_temp ?? null)
              : null
          ),
        ])
      )
    );
  };

  const load = async () => {
    try {
      await loadAll();
    } catch {
      // A failed refresh keeps the last good data on screen; only a failed
      // first load has nothing to show.
      setLoadFailed(true);
    }
  };

  const cancelHold = async (roomId: string) => {
    setActionError("");
    try {
      await clearOverride(roomId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not cancel the hold");
    }
    load();
  };

  useEffect(() => {
    load();
    const cancel = connectWS((event) => {
      if (event.type === "zone_status") {
        load();
      }
    });
    const interval = setInterval(load, 30000);
    // The global banners' Manage modals change this same state; keep the
    // buttons and hint lines below in step with them (#678).
    const stopVacation = onStateChanged("vacation-mode", load);
    const stopEco = onStateChanged("eco-suspend", load);
    return () => {
      cancel();
      clearInterval(interval);
      stopVacation();
      stopEco();
    };
    // Mount-only: `load` reads nothing that changes between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && loadFailed)
    return (
      <div className="card">
        <p className="form-error">
          Could not load the dashboard. Check that HomeClimate is running.
        </p>
        <button className="btn btn-secondary" onClick={load}>
          Try Again
        </button>
      </div>
    );
  if (loading)
    return (
      <div className="loading">
        <div className="spinner" /> Loading dashboard…
      </div>
    );

  const houseCtx = house ? { house, openOptions: setOptionsFor } : null;
  const vacationScheduled = vacationState(vacationMode) === "scheduled";
  return (
    <HouseContext.Provider value={houseCtx}>
      <div>
        <div className="page-header">
          <div>
            <div className="page-title">Dashboard</div>
            <div className="page-subtitle">
              {zones.length} zone{zones.length !== 1 ? "s" : ""} · {rooms.length} room
              {rooms.length !== 1 ? "s" : ""}
              {lastUpdate && (
                <>
                  {" · Updated "}
                  <Frozen>
                    <Time value={lastUpdate} kind="time" />
                  </Frozen>
                </>
              )}
            </div>
          </div>
          <div className="dash-header-actions">
            <button
              type="button"
              role="switch"
              aria-checked={system.enabled}
              className={`btn ${system.enabled ? "btn-secondary" : "btn-danger"}`}
              title="Turn all of HomeClimate's heating and cooling control on or off"
              onClick={() => setConfirmSystem(true)}
            >
              <span
                className="system-toggle-dot"
                style={{ background: system.enabled ? "var(--green)" : "var(--gray-400)" }}
              />
              <span>System</span>
              <strong className="system-toggle-state">{system.enabled ? "On" : "Off"}</strong>
            </button>
            {/* Vacation Mode sits beside the System switch and is drawn the same
                way: a dot, the name, the state. It opens the vacation dialog. */}
            <button
              type="button"
              className={`btn ${vacationMode.enabled ? "btn-warning" : "btn-secondary"}`}
              aria-label={
                vacationMode.enabled
                  ? "Vacation mode active"
                  : vacationScheduled
                    ? "Vacation scheduled"
                    : "Enable vacation mode"
              }
              title="Set the whole house back while you are away, or plan a trip"
              onClick={() => setShowVacationModal(true)}
            >
              <span
                className="system-toggle-dot"
                style={{
                  background: vacationMode.enabled
                    ? "var(--orange)"
                    : vacationScheduled
                      ? "var(--orange)"
                      : "var(--gray-400)",
                }}
              />
              <span>Vacation</span>
              <strong className="system-toggle-state">
                {vacationMode.enabled ? "On" : vacationScheduled ? "Scheduled" : "Off"}
              </strong>
            </button>
            <button className="btn btn-secondary" onClick={load}>
              ↻ Refresh
            </button>
          </div>
        </div>
        {confirmSystem && (
          <ConfirmDialog
            title={system.enabled ? "Turn the system off?" : "Turn the system on?"}
            message={
              system.enabled
                ? "HomeClimate stops controlling every thermostat and vent until you turn it back on. Running cycles end."
                : "HomeClimate takes control of every thermostat and vent again."
            }
            confirmLabel={system.enabled ? "Turn System Off" : "Turn System On"}
            onCancel={() => setConfirmSystem(false)}
            onConfirm={() => {
              setConfirmSystem(false);
              void system.toggle();
            }}
          />
        )}

        <AirflowConfigBanner />
        <UnavailableThermostatsBanner />
        <StaleSensorsBanner />

        {house && <HouseBandCard house={house} onSaved={setHouse} />}
        <TodayCard />

        {/* Eco Suspend + Temporary hold buttons — sit above climate cards.
            Vacation Mode is in the page header, beside the System switch. */}
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
            {/* Only shown when Eco is in play somewhere: a thermostat has Eco
              enabled, a room has an explicit Eco opt-in, or a suspension is
              already active (#500). */}
            {(thermostats.some((t) => t.eco_mode_enabled || t.eco_suspend_until) ||
              rooms.some((r) => r.eco_mode_enabled === true)) && (
              <button
                className="btn btn-secondary"
                data-testid="dashboard-eco-suspend-btn"
                onClick={() => setEcoSuspendFor({})}
                style={{ display: "flex", alignItems: "center", gap: ".5rem" }}
              >
                🍃{" "}
                {thermostats.some((t) => t.eco_suspend_until)
                  ? "Eco suspended — manage"
                  : "Suspend Eco"}
              </button>
            )}
            {/* Temporary hold (#576): hold one room at an exact temperature for
              1–8 hours, overriding its schedules and presence. */}
            {rooms.length > 0 && (
              <button
                className="btn btn-secondary"
                data-testid="dashboard-hold-btn"
                onClick={() => setHoldModalFor({})}
                style={{ display: "flex", alignItems: "center", gap: ".5rem" }}
              >
                🕒{" "}
                {holds.length > 0
                  ? `${holds.length} hold${holds.length !== 1 ? "s" : ""} active — manage`
                  : "Temporary hold"}
              </button>
            )}
          </div>
          {vacationMode.enabled && vacationMode.return_at && (
            <div
              className="form-hint"
              style={{ marginTop: ".4rem" }}
              title={tz.tooltip(vacationMode.return_at)}
            >
              {`Schedules paused until ${tz.format(vacationMode.return_at)}`}
            </div>
          )}
          {actionError && <p className="form-error">{actionError}</p>}
          {/* Active holds strip (#576): every live hold — including rooms that
            are not part of a running cycle — with a cancel next to each. The
            countdown is backend-derived and time-varying, so it is frozen for
            the visual goldens; name/target/eco tag are stable and stay live. */}
          {holds.map((h) => {
            const room = rooms.find((r) => r.id === h.room_id);
            return (
              <div
                key={h.room_id}
                className="form-hint"
                data-testid={`dashboard-hold-${h.room_id}`}
                style={{ marginTop: ".4rem", display: "flex", alignItems: "center", gap: ".5rem" }}
              >
                <span>
                  🕒 <strong>{room?.name ?? h.room_id}</strong> held at{" "}
                  <strong>{bandText(fmtTemp, h.target_temp, h.cool_to)}</strong> · ends in{" "}
                  <Frozen>{formatCountdown(h.ends_in_seconds)}</Frozen> ·{" "}
                  {h.respect_eco ? "Eco may relax" : "ignores Eco"}
                </span>
                <button
                  className="btn btn-sm btn-outline-danger"
                  style={{ padding: "0 .5rem", fontSize: ".75rem" }}
                  title="End the hold now — the room returns to its schedules and presence."
                  onClick={() => cancelHold(h.room_id)}
                >
                  Cancel
                </button>
              </div>
            );
          })}
        </div>

        {zones.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <p>No zones set up yet.</p>
              <p style={{ marginTop: ".5rem" }}>
                Go to <strong>My Home</strong> to add your first zone.
              </p>
            </div>
          </div>
        ) : (
          groupByBuilding(
            buildings,
            [...zones].sort(
              (a, b) =>
                (profiles.find((p) => p.thermostat_entity_id === a.thermostat_entity_id)
                  ?.sort_order ?? 0) -
                (profiles.find((p) => p.thermostat_entity_id === b.thermostat_entity_id)
                  ?.sort_order ?? 0)
            ),
            (z) =>
              profiles.find((p) => p.thermostat_entity_id === z.thermostat_entity_id)
                ?.building_id ?? null
          )
            // A building with no zones has nothing to show here; My Home lists it.
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section
                key={group.building?.id ?? "unassigned"}
                className="dash-building"
                data-testid={`dash-building-${group.building?.id ?? "unassigned"}`}
              >
                {buildings.length > 0 && (
                  <div className="dash-building-title">{group.building?.name ?? "Other Zones"}</div>
                )}
                {buildingModes
                  .filter((m) => m.building_id === group.building?.id)
                  .map((m) => (
                    <BuildingModeControl
                      key={m.building_id}
                      building={m}
                      zoneNames={Object.fromEntries(
                        profiles.map((p) => [p.thermostat_entity_id, p.name])
                      )}
                      onSaved={setBuildingModes}
                    />
                  ))}
                <div className="card-grid">
                  {group.items.map((z) => (
                    <ZoneCard
                      key={z.thermostat_entity_id}
                      zone={z}
                      rooms={rooms}
                      thermostats={thermostats}
                      heldRoomIds={new Set(holds.map((h) => h.room_id))}
                      temps={temps}
                      smart={smart}
                      onHold={(roomId) => setHoldModalFor({ room: roomId })}
                      onCancelHold={cancelHold}
                      onClearPresence={load}
                      onSuspendEco={(tid) => setEcoSuspendFor({ thermostat: tid })}
                      showActiveRoomsSample={z === zones[0]}
                    />
                  ))}
                </div>
              </section>
            ))
        )}

        {showVacationModal && (
          <VacationModeModal
            current={vacationMode}
            onClose={() => setShowVacationModal(false)}
            onChanged={(updated) => {
              setVacationMode(updated);
              setShowVacationModal(false);
            }}
          />
        )}

        {ecoSuspendFor && (
          <EcoSuspendModal
            thermostats={thermostats}
            initialThermostat={ecoSuspendFor.thermostat}
            onClose={() => setEcoSuspendFor(null)}
            onChanged={load}
          />
        )}

        {holdModalFor && (
          <HoldModal
            rooms={rooms}
            initialRoom={holdModalFor.room}
            holds={Object.fromEntries(holds.map((h) => [h.room_id, h]))}
            onClose={() => setHoldModalFor(null)}
            onChanged={load}
          />
        )}
        {optionsFor && house && (
          <RoomFollowDialog
            roomId={optionsFor.id}
            roomName={optionsFor.name}
            switches={switchesFor(house, optionsFor.id)}
            calendar={calendarFor(house, optionsFor.id)?.entity_id ?? null}
            onSaved={setHouse}
            onClose={() => setOptionsFor(null)}
          />
        )}
      </div>
    </HouseContext.Provider>
  );
}
