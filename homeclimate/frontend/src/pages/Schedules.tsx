import DayChips from "../components/DayChips";
import Segmented from "../components/Segmented";
import RoomInUse from "../components/RoomInUse";
import { calendarFor, getHouse, switchesFor, type House } from "../houseApi";
import { useEffect, useState } from "react";
import {
  getRooms,
  getSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  copySchedule,
  getOverrides,
  getThermostats,
  type Room,
  type RoomOverrideHold,
  type Schedule,
  type ScheduleCopyResult,
  type ThermostatConfig,
} from "../api";
import OccupiedTargets from "../components/OccupiedTargets";
import { entityName } from "../entityNames";
import { RoomSettings } from "./Rooms";
import { useUnit } from "../contexts";
import { Frozen } from "../ci";
import ConfirmDialog from "../components/ConfirmDialog";
import { bandText, coolToValue } from "../bands";
import CoolToField from "../components/CoolToField";
import { formatCountdown } from "../countdown";
import { HouseTime, ZoneHint } from "../components/Time";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Matches schedule_rules.MAX_NAME_LENGTH on the backend (Issue #520). Capping
// the input means the only way to hit the server-side bound is an API client,
// so the form never has to render an error for it.
const MAX_NAME_LENGTH = 64;

// ---------------------------------------------------------------------------
// Overlap detection (mirrors backend logic)
// ---------------------------------------------------------------------------
function scheduleIntervals(days: number[], start: string, end: string): [number, number, number][] {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m || 0);
  };
  const sm = toMin(start),
    em = toMin(end);
  const isOvernight = em <= sm;
  const result: [number, number, number][] = [];
  for (const d of days) {
    if (!isOvernight) {
      result.push([d, sm, em]);
    } else {
      result.push([d, sm, 1440]);
      result.push([(d + 1) % 7, 0, em]);
    }
  }
  return result;
}

function schedulesOverlap(
  a: { days: number[]; start: string; end: string },
  b: { days: number[]; start: string; end: string }
): boolean {
  const aI = scheduleIntervals(a.days, a.start, a.end);
  const bI = scheduleIntervals(b.days, b.start, b.end);
  for (const [ad, as_, ae] of aI) {
    for (const [bd, bs, be] of bI) {
      if (ad === bd && as_ < be && bs < ae) return true;
    }
  }
  return false;
}

// `expires_at` from the API is a naive local ISO string ("2026-07-01T22:00:00")
// or null. `<input type="datetime-local">` wants "YYYY-MM-DDTHH:MM", so slice.
const toDatetimeLocal = (iso: string | null): string => (iso ? iso.slice(0, 16) : "");
// Compact display for the table, e.g. "Jul 1, 22:00".
const fmtExpiry = (iso: string): string => {
  return iso.slice(0, 16).replace("T", " ");
};

function ScheduleModal({
  schedule,
  roomId,
  roomDeadbandOverride,
  existingSchedules,
  onClose,
  onSave,
}: {
  schedule: Schedule | null;
  roomId: string;
  /** The room's own deadband override in °F, or null when it inherits the
   *  thermostat's. Display-only: it names the value this block REPLACES so the
   *  control cannot be read as additive. */
  roomDeadbandOverride: number | null;
  existingSchedules: Schedule[];
  onClose: () => void;
  onSave: () => void;
}) {
  const { toDisplay, toDisplayDelta, displayBound, unitLabel } = useUnit();
  // Bounds the backend will actually accept, in display units. See
  // displayBound: converting a °F limit for display rounds, and rounding can
  // move the bound outward, so the raw conversion advertises values that 400.
  const minTemp = displayBound(40, "min");
  const maxTemp = displayBound(90, "max");
  const maxDeadband = displayBound(10, "max", "delta");
  // The band this block would replace, in display units — null when the room
  // inherits the thermostat's deadband, which this modal does not load.
  const inheritedDeadband =
    roomDeadbandOverride != null ? toDisplayDelta(roomDeadbandOverride) : null;
  // Optional display name (Issue #520). Blank means unnamed — the block is then
  // identified by its id, which the list shows on the ID chip either way.
  const [name, setName] = useState(schedule?.name ?? "");
  const [days, setDays] = useState<number[]>(schedule?.days_of_week ?? [0, 1, 2, 3, 4]);
  const [start, setStart] = useState(schedule?.start_time ?? "22:00");
  const [end, setEnd] = useState(schedule?.end_time ?? "07:00");
  const [temp, setTemp] = useState(
    schedule?.target_temp != null ? String(toDisplay(schedule.target_temp)) : String(toDisplay(72))
  );
  // An optional Cool To makes the target a band. Display units, sent as typed.
  const [coolTo, setCoolTo] = useState(
    schedule?.cool_to != null ? String(toDisplay(schedule.cool_to)) : ""
  );
  // Per-block deadband override (Issue #517). "inherit" (default) sends null;
  // "custom" sends the raw DISPLAY delta — the backend's _delta_to_f converts.
  const [deadbandMode, setDeadbandMode] = useState<"inherit" | "custom">(
    schedule?.deadband_override != null ? "custom" : "inherit"
  );
  // Clamp what a STORED band displays as, not just what the user may type.
  // 10 °F is the documented maximum and the backend accepts it inclusively, but
  // it has no 2dp °C form that survives the round trip: toDisplayDelta(10) is
  // 5.56, which converts back to 10.01 and is refused. Without this clamp a
  // °C household that opens such a block gets 5.56 in a field capped at 5.55,
  // and EVERY save is rejected — including edits to the days or the target,
  // fields the user did touch — naming a band they never touched. Clamping
  // shows 5.55 (9.99 °F on save); 0.01 °F is far below anything a thermostat
  // resolves, and it is the only value in 0–10 affected.
  const [deadband, setDeadband] = useState(
    schedule?.deadband_override != null
      ? String(Math.min(toDisplayDelta(schedule.deadband_override), maxDeadband))
      : ""
  );
  // Expiry: "never" (default) or "at" a specific local datetime.
  const [expiryMode, setExpiryMode] = useState<"never" | "at">(
    schedule?.expires_at ? "at" : "never"
  );
  const [expiresAt, setExpiresAt] = useState(toDatetimeLocal(schedule?.expires_at ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (days.length === 0) {
      setError("Select at least one day");
      return;
    }
    if (!temp) {
      setError("Temperature required");
      return;
    }

    const t = parseFloat(temp);
    if (isNaN(t) || t < minTemp || t > maxTemp) {
      setError(
        // 1dp to match fmtTemp, which every other temperature in the UI uses.
        // The VALUE comes from displayBound so it is one the backend accepts;
        // only the formatting is borrowed.
        `Target temperature must be between ${minTemp.toFixed(1)}${unitLabel} and ` +
          `${maxTemp.toFixed(1)}${unitLabel}`
      );
      return;
    }

    // Deadband override is a DELTA in display units; bound 0–10 °F, matching
    // the backend's _validate_deadband_override.
    if (deadbandMode === "custom") {
      const db = parseFloat(deadband);
      if (deadband.trim() === "" || isNaN(db) || db < 0 || db > maxDeadband) {
        setError(`Deadband must be between 0${unitLabel} and ${maxDeadband}${unitLabel}`);
        return;
      }
    }

    if (expiryMode === "at" && !expiresAt) {
      setError("Pick the date and time this block ends, or choose Never");
      return;
    }

    // Whether this block is (will remain) enabled. New blocks start enabled;
    // editing preserves the current state (the row toggle changes it).
    const enabled = schedule?.enabled ?? true;

    // Client-side overlap check — only enabled blocks reserve their slot, and
    // only matters when this block is itself enabled (mirrors the backend).
    if (enabled) {
      const candidate = { days, start, end };
      for (const e of existingSchedules) {
        if (schedule && e.id === schedule.id) continue; // skip self when editing
        if (!e.enabled) continue; // parked blocks don't reserve their slot
        const existing = { days: e.days_of_week, start: e.start_time, end: e.end_time };
        if (schedulesOverlap(candidate, existing)) {
          const daysStr = e.days_of_week.map((d) => DAYS[d]).join(", ");
          setError(`Overlaps with existing block on ${daysStr} ${e.start_time}–${e.end_time}`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      // target_temp is sent in DISPLAY units; the backend converts to °F on the
      // write boundary via _to_f. deadband_override is a DELTA, also sent raw —
      // the backend's _delta_to_f converts it (never toStorageDelta here, #231).
      // expires_at is a datetime — sent as-is, no unit conversion (Issue #359).
      // `name` is sent trimmed, with blank collapsing to null (= unnamed) so a
      // user clearing the field really clears the stored name rather than
      // storing "". The backend normalizes again — this just keeps the payload
      // honest about intent.
      const payload = {
        days_of_week: days,
        start_time: start,
        end_time: end,
        target_temp: parseFloat(temp),
        enabled,
        deadband_override: deadbandMode === "custom" ? parseFloat(deadband) : null,
        expires_at: expiryMode === "at" ? expiresAt : null,
        name: name.trim() || null,
        // Sent when there is one, or when one is being taken away.
        ...(coolTo.trim() !== "" || schedule?.cool_to != null
          ? { cool_to: coolToValue(coolTo) }
          : {}),
      };
      if (schedule) await updateSchedule(roomId, schedule.id, payload);
      else await createSchedule(roomId, payload);
      onSave();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">{schedule ? "Edit Schedule" : "New Schedule"}</div>
        {error && (
          <div className="badge badge-red" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        <div className="form-group">
          <label className="form-label" htmlFor="schedule-name">
            Name
          </label>
          <input
            id="schedule-name"
            className="form-control"
            type="text"
            maxLength={MAX_NAME_LENGTH}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
          />
        </div>

        <div className="form-group">
          <span className="form-label">Days</span>
          <DayChips
            label="Days"
            selected={days}
            onToggle={(d) =>
              setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort())
            }
          />
        </div>

        {/* flex-basis 10rem (not 0) lets the pair wrap to stacked rows on
            narrow phones instead of squeezing the time inputs (#458). */}
        <div className="flex gap-md">
          <div className="form-group" style={{ flex: "1 1 10rem" }}>
            <label className="form-label" htmlFor="schedule-start">
              Start Time
            </label>
            <input
              id="schedule-start"
              className="form-control"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
            <ZoneHint />
          </div>
          <div className="form-group" style={{ flex: "1 1 10rem" }}>
            <label className="form-label" htmlFor="schedule-end">
              End Time
            </label>
            <input
              id="schedule-end"
              className="form-control"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
            <ZoneHint />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="schedule-temp">
            {coolTo.trim() === "" ? "Target Temperature" : "Heat To"} ({unitLabel})
          </label>
          <input
            id="schedule-temp"
            className="form-control"
            type="number"
            step="0.5"
            min={minTemp}
            max={maxTemp}
            value={temp}
            onChange={(e) => setTemp(e.target.value)}
            placeholder={`e.g. ${Math.round(toDisplay(68))}`}
          />
        </div>

        <CoolToField id="schedule-cool-to" value={coolTo} onChange={setCoolTo} />

        <div className="form-group">
          <span className="form-label">Allowed Drift</span>
          <Segmented
            label="Allowed Drift"
            value={deadbandMode}
            options={[
              { value: "inherit", label: "Room\u2019s Usual" },
              { value: "custom", label: "Custom" },
            ]}
            onChange={setDeadbandMode}
          />
          {deadbandMode === "custom" && (
            <input
              id="schedule-deadband"
              className="form-control"
              type="number"
              step="0.5"
              min={0}
              max={maxDeadband}
              aria-label={`Deadband (${unitLabel})`}
              value={deadband}
              onChange={(e) => setDeadband(e.target.value)}
            />
          )}
          <div className="text-sm text-muted" style={{ marginTop: ".3rem" }}>
            {deadbandMode === "custom"
              ? `How far the room may drift from its target during this block. It replaces the room\u2019s usual${
                  inheritedDeadband != null ? ` \u00b1${inheritedDeadband}${unitLabel}` : " drift"
                }.`
              : `The room keeps its usual drift${
                  inheritedDeadband != null ? ` of \u00b1${inheritedDeadband}${unitLabel}` : ""
                }.`}
          </div>
        </div>

        <div className="form-group">
          <span className="form-label">Ends</span>
          <Segmented
            label="Ends"
            value={expiryMode}
            options={[
              { value: "never", label: "Never" },
              { value: "at", label: "On a Date" },
            ]}
            onChange={setExpiryMode}
          />
          {expiryMode === "at" && (
            <input
              id="schedule-expires-at"
              className="form-control"
              type="datetime-local"
              aria-label="End date and time"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          )}
          {expiryMode === "at" && <ZoneHint />}
          <div className="text-sm text-muted" style={{ marginTop: ".3rem" }}>
            A block with an end date turns itself off then. It is kept, not deleted.
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyModal({
  schedule,
  sourceRoomId,
  rooms,
  onClose,
  onDone,
}: {
  schedule: Schedule;
  sourceRoomId: string;
  rooms: Room[];
  onClose: () => void;
  onDone: (results: ScheduleCopyResult[]) => void;
}) {
  const targets = rooms.filter((r) => r.id !== sourceRoomId);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const copy = async () => {
    if (selected.length === 0) {
      setError("Select at least one room");
      return;
    }
    setSaving(true);
    try {
      const results = await copySchedule(sourceRoomId, schedule.id, selected);
      onDone(results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Copy failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-title">Copy schedule to other rooms</div>
        <div className="text-sm text-muted" style={{ marginBottom: "1rem" }}>
          Copies the name, days, times and temperature. A copy that overlaps a block already in a
          room is added switched off.
        </div>
        {error && (
          <div className="badge badge-red" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        )}
        {targets.length === 0 ? (
          <p className="text-muted text-sm">No other rooms to copy to.</p>
        ) : (
          <div className="form-group">
            {targets.map((r) => (
              <label
                key={r.id}
                className="flex gap-sm"
                style={{ alignItems: "center", padding: ".25rem 0" }}
              >
                <input
                  type="checkbox"
                  checked={selected.includes(r.id)}
                  onChange={() => toggle(r.id)}
                />
                {r.name}
              </label>
            ))}
          </div>
        )}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={copy}
            disabled={saving || targets.length === 0}
          >
            {saving ? "Copying…" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoomSchedules({
  room,
  allRooms,
  thermostats,
  hold,
  house,
  onHouse,
  onRoomSaved,
}: {
  room: Room;
  allRooms: Room[];
  thermostats: ThermostatConfig[];
  /** The room was changed here: its own temperatures or its fine tuning. */
  onRoomSaved: (saved: Room) => void;
  /** Null when the home's layout could not be read: no In Use control. */
  house: House | null;
  onHouse: (h: House) => void;
  // Temporary hold (#576): this room's live hold, if any. Holds are not
  // schedule blocks — they take precedence over every block below and are
  // never conflict-checked against them.
  hold: RoomOverrideHold | undefined;
}) {
  const { fmtTemp, toDisplayDelta, unitLabel } = useUnit();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [copySource, setCopySource] = useState<Schedule | null>(null);
  const [actionError, setActionError] = useState("");
  const [copyResults, setCopyResults] = useState<ScheduleCopyResult[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Schedule | null>(null);
  // Which block, if any, is currently showing its full id (#520). One at a
  // time: the id is long, and revealing several at once just adds noise.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const toggleRevealedId = (id: string) => setRevealedId((cur) => (cur === id ? null : id));

  const load = async () => {
    const s = await getSchedules(room.id);
    setSchedules(s);
  };

  // Load on mount for the count badge, reload when expanded for fresh data
  useEffect(() => {
    load();
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (expanded) load();
    // Re-run only when expanded toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const del = async () => {
    if (!confirmDelete) return;
    const s = confirmDelete;
    setConfirmDelete(null);
    await deleteSchedule(room.id, s.id);
    load();
  };

  const toggleEnabled = async (s: Schedule) => {
    setActionError("");
    try {
      await updateSchedule(room.id, s.id, { enabled: !s.enabled });
      await load();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Could not change schedule status");
    }
  };

  const activeCount = schedules.filter((s) => s.enabled).length;
  const inactiveCount = schedules.length - activeCount;

  const zone = thermostats.find((t) => t.thermostat_entity_id === room.thermostat_entity_id);
  const zoneName = zone?.name || entityName(room.thermostat_entity_id);
  const inUse = house
    ? calendarFor(house, room.id)
      ? "On a calendar"
      : switchesFor(house, room.id).in_use
        ? "Always in use"
        : "Never in use"
    : "";
  const blocks =
    schedules.length === 0
      ? "No blocks"
      : `${activeCount} ${activeCount === 1 ? "block" : "blocks"}${inactiveCount ? `, ${inactiveCount} off` : ""}`;

  return (
    <div className="card room-plan">
      <button
        type="button"
        className="room-plan-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span>
          <strong className="room-plan-name">{room.name}</strong>
          <span className="rule-help" title={room.thermostat_entity_id}>
            {zoneName}
          </span>
        </span>
        <span className="room-plan-summary">
          {inUse && <span>{inUse}</span>}
          <span>{blocks}</span>
        </span>
      </button>

      {expanded && (
        <div className="room-plan-body">
          {house && <RoomInUse room={room} house={house} onHouse={onHouse} />}
          <OccupiedTargets room={room} onSaved={onRoomSaved} />
          <div>
            <h4 className="room-details-title">Schedule</h4>
            <WeekStrip schedules={schedules} />
          </div>
          {actionError && (
            <div className="badge badge-red" style={{ marginBottom: "1rem" }}>
              {actionError}
            </div>
          )}
          {copyResults && (
            <div className="card" style={{ marginBottom: "1rem", padding: ".75rem" }}>
              <div className="text-sm" style={{ marginBottom: ".4rem" }}>
                <strong>Copy results</strong>
              </div>
              {copyResults.map((r) => {
                const roomName = allRooms.find((x) => x.id === r.room_id)?.name ?? r.room_id;
                return (
                  <div key={r.schedule_id} className="text-sm" style={{ padding: ".15rem 0" }}>
                    {r.status === "created" ? (
                      <span className="badge badge-green">Copied</span>
                    ) : (
                      <span className="badge badge-orange">Copied (disabled)</span>
                    )}{" "}
                    {roomName}
                    {r.conflict_with ? ` — conflicts with ${r.conflict_with}` : ""}
                  </div>
                );
              })}
              <button
                className="btn btn-secondary btn-sm"
                style={{ marginTop: ".5rem" }}
                onClick={() => setCopyResults(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          {/* Temporary hold (#576): visually distinct from the block table —
              a hold is not a schedule block, wins over every block below, and
              is never conflict-checked against them. */}
          {hold && (
            <div
              className="card"
              data-testid={`hold-card-${room.id}`}
              style={{ marginBottom: "1rem", padding: ".75rem" }}
            >
              <div className="text-sm" style={{ marginBottom: ".4rem" }}>
                <span className="badge badge-purple" style={{ marginRight: ".5rem" }}>
                  Temporary hold
                </span>
                held at <strong>{bandText(fmtTemp, hold.target_temp, hold.cool_to)}</strong> · ends
                in <Frozen>{formatCountdown(hold.ends_in_seconds)}</Frozen> ·{" "}
                {hold.respect_eco ? "Eco may relax" : "ignores Eco"}
              </div>
              <div className="text-sm text-muted">
                A hold comes ahead of the time blocks below until it ends. Change or cancel it from
                the Dashboard.
              </div>
            </div>
          )}
          {schedules.length === 0 ? (
            <p className="text-muted text-sm">No blocks yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table-cards">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Days</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.id} style={s.enabled ? undefined : { opacity: 0.55 }}>
                      {/* Name and ID chip share one inline wrapper so the mobile
                          card layout (td[data-label] is a flex row) keeps them
                          together on the right of the label instead of spreading
                          them apart. */}
                      <td data-label="Name">
                        <span>
                          {s.name ? s.name : <span className="text-muted">Unnamed</span>}{" "}
                          {/* The block's GUID stays reachable whether or not it
                              has a name — it is what addresses this block from
                              the REST and MCP APIs, and a name is only a label
                              (#520). It is NOT rendered as cell text: a GUID is
                              minted per install, so drawing it would churn every
                              golden on every CI run. Hover shows it (desktop);
                              tapping reveals it as selectable text, because a
                              `title` tooltip never opens on a touch screen and
                              "discoverable without dev tools" has to hold on a
                              phone too. No spec clicks this chip, so the
                              revealed state stays out of the goldens — keep it
                              that way. */}
                          <span
                            className="badge badge-gray font-mono"
                            style={{ cursor: "help" }}
                            data-testid="schedule-id"
                            role="button"
                            tabIndex={0}
                            aria-expanded={revealedId === s.id}
                            title={`Schedule ID: ${s.id}`}
                            onClick={() => toggleRevealedId(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleRevealedId(s.id);
                              }
                            }}
                          >
                            ID
                          </span>
                        </span>
                        {revealedId === s.id && (
                          <span
                            className="text-sm text-muted font-mono"
                            style={{ display: "block", wordBreak: "break-all" }}
                          >
                            {s.id}
                          </span>
                        )}
                      </td>
                      <td data-label="Days">{s.days_of_week.map((d) => DAYS[d][0]).join("")}</td>
                      <td data-label="Start">
                        <HouseTime>{s.start_time}</HouseTime>
                      </td>
                      <td data-label="End">
                        <HouseTime>{s.end_time}</HouseTime>
                      </td>
                      <td data-label="Target">
                        <strong>{bandText(fmtTemp, s.target_temp, s.cool_to)}</strong>
                        {/* Wide-band blocks are identifiable without opening the
                            editor — no extra column, so the 7-col layout holds. */}
                        {s.deadband_override != null && (
                          <span className="badge badge-gray" style={{ marginLeft: ".35rem" }}>
                            ±{toDisplayDelta(s.deadband_override)}
                            {unitLabel} drift
                          </span>
                        )}
                      </td>
                      <td data-label="Status">
                        {s.enabled ? (
                          <span className="badge badge-green">Active</span>
                        ) : (
                          <span className="badge badge-gray">Disabled</span>
                        )}
                      </td>
                      <td data-label="Expires" className="text-sm">
                        {s.expires_at ? <HouseTime>{fmtExpiry(s.expires_at)}</HouseTime> : "Never"}
                      </td>
                      <td>
                        <div className="flex gap-sm">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => toggleEnabled(s)}
                          >
                            {s.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setCopyResults(null);
                              setCopySource(s);
                            }}
                          >
                            Copy
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setEditSchedule(s);
                              setShowModal(true);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => setConfirmDelete(s)}
                          >
                            Del
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: ".75rem" }} className="flex gap-sm">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setEditSchedule(null);
                setShowModal(true);
              }}
            >
              Add Block
            </button>
          </div>
          <button type="button" className="advanced-open" onClick={() => setTuning(true)}>
            <strong>Fine Tuning</strong>
            <span>{tuningSummary(room, toDisplayDelta, unitLabel)}</span>
          </button>
        </div>
      )}

      {tuning && (
        <RoomSettings
          room={room}
          part="tuning"
          rooms={allRooms}
          thermostats={thermostats}
          onCancel={() => setTuning(false)}
          onSaved={(saved) => {
            setTuning(false);
            onRoomSaved(saved);
          }}
        />
      )}

      {showModal && (
        <ScheduleModal
          schedule={editSchedule}
          roomId={room.id}
          roomDeadbandOverride={room.deadband_override ?? null}
          existingSchedules={schedules}
          onClose={() => setShowModal(false)}
          onSave={() => {
            setShowModal(false);
            load();
          }}
        />
      )}

      {copySource && (
        <CopyModal
          schedule={copySource}
          sourceRoomId={room.id}
          rooms={allRooms}
          onClose={() => setCopySource(null)}
          onDone={(results) => {
            setCopySource(null);
            setCopyResults(results);
            load();
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete schedule?"
          message="Delete this schedule? This cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => void del()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** What a room has changed from its zone's settings, in a few words. */
function tuningSummary(room: Room, delta: (f: number) => number, unitLabel: string): string {
  const parts: string[] = [];
  if (room.temp_offset) parts.push(`offset ${delta(room.temp_offset)}${unitLabel}`);
  if (room.deadband_override != null)
    parts.push(`own deadband ${delta(room.deadband_override)}${unitLabel}`);
  if (room.ambient_suppression_enabled) parts.push("waits on the weather");
  if (room.eco_mode_enabled != null) parts.push(room.eco_mode_enabled ? "Eco on" : "Eco off");
  return parts.length ? parts.join(", ") : "Uses its zone's settings";
}

const hourOf = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;

/** A room's week at a glance: a bar per day, filled where a block is on. */
function WeekStrip({ schedules }: { schedules: Schedule[] }) {
  const on = schedules.filter((s) => s.enabled);
  // Each day's stretches as [start hour, end hour]; a block past midnight
  // carries into the next day.
  const days: [number, number][][] = DAYS.map(() => []);
  for (const s of on) {
    const start = hourOf(s.start_time);
    const end = hourOf(s.end_time);
    for (const d of s.days_of_week) {
      if (end > start) days[d].push([start, end]);
      else {
        days[d].push([start, 24]);
        if (end > 0) days[(d + 1) % 7].push([0, end]);
      }
    }
  }
  return (
    <div
      className="week-strip"
      role="img"
      aria-label={
        on.length === 0
          ? "No blocks are on"
          : `${on.length} ${on.length === 1 ? "block" : "blocks"} across the week`
      }
    >
      {DAYS.map((day, d) => (
        <div className="week-strip-day" key={day}>
          <span>{day}</span>
          <div className="week-strip-bar">
            {days[d].map(([from, to], i) => (
              <i
                key={i}
                style={{ left: `${(from / 24) * 100}%`, width: `${((to - from) / 24) * 100}%` }}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="week-strip-axis">
        <span>12 AM</span>
        <span>6 AM</span>
        <span>Noon</span>
        <span>6 PM</span>
        <span>12 AM</span>
      </div>
    </div>
  );
}

/** Smart Control → Rooms: when each room is in use and what temperature it gets. */
export default function Schedules() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  // Temporary holds (#576), keyed by room_id — one page-level fetch feeds
  // every room card and the shared hold modal.
  const [holds, setHolds] = useState<Record<string, RoomOverrideHold>>({});
  const [house, setHouse] = useState<House | null>(null);
  const [thermostats, setThermostats] = useState<ThermostatConfig[]>([]);

  const refreshHolds = async () => {
    try {
      const list = await getOverrides();
      setHolds(Object.fromEntries(list.map((h) => [h.room_id, h])));
    } catch {
      // supplementary — the page still renders without hold info
    }
  };

  useEffect(() => {
    getRooms().then((r) => {
      setRooms(r);
      setLoading(false);
    });
    refreshHolds();
    // Zone names, and what fine tuning starts from. Supplementary.
    void (async () => {
      try {
        setThermostats((await getThermostats()) ?? []);
      } catch {
        setThermostats([]);
      }
    })();
    // Whether each room is in use. Supplementary: the time blocks still show
    // without it.
    void (async () => {
      try {
        setHouse((await getHouse()) ?? null);
      } catch {
        setHouse(null);
      }
    })();
  }, []);

  if (loading)
    return (
      <div className="loading">
        <div className="spinner" /> Loading…
      </div>
    );

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Rooms</div>
          <div className="page-subtitle">
            When each room is in use, and what temperature it gets. A room that is not in use asks
            for no heating or cooling.
          </div>
        </div>
      </div>

      {rooms.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <p>
              No rooms yet. Add them in <strong>My Home</strong> first.
            </p>
          </div>
        </div>
      ) : (
        rooms.map((r) => (
          <RoomSchedules
            key={r.id}
            room={r}
            allRooms={rooms}
            thermostats={thermostats}
            onRoomSaved={(saved) =>
              setRooms((all) => all.map((x) => (x.id === saved.id ? { ...x, ...saved } : x)))
            }
            hold={holds[r.id]}
            house={house}
            onHouse={setHouse}
          />
        ))
      )}
    </div>
  );
}
