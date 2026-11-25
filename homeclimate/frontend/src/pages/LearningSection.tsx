import { useEffect, useState } from "react";
import { Frozen } from "../ci";
import ConfirmDialog from "../components/ConfirmDialog";
import Time from "../components/Time";
import { RuleRow } from "../components/SmartControlControls";
import { useUnit } from "../contexts";
import {
  describeModel,
  EARLY_START_LABELS,
  describeCoasting,
  fitLearning,
  GRADE_LABELS,
  describeCollected,
  getLearning,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  TEMPERATURE_WARN_BELOW_PCT,
  updateLearningSettings,
  type Learning,
  type LearningRoom,
  type LearningSettings,
} from "../learningApi";

/** A whole-day input that saves on blur or Enter. */
function DaysInput({
  value,
  disabled,
  attempt,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  /** Bumped when a change was refused or cancelled, to put the stored value back. */
  attempt: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState({ value, attempt });
  if (shown.value !== value || shown.attempt !== attempt) {
    // A save changed the stored value, or a change did not go through: show
    // what is stored (adjust during render).
    setShown({ value, attempt });
    setDraft(String(value));
  }
  const commit = () => {
    const n = Number(draft);
    if (
      draft.trim() === "" ||
      !Number.isInteger(n) ||
      n < RETENTION_MIN_DAYS ||
      n > RETENTION_MAX_DAYS
    ) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <span className="minutes-field">
      <input
        id="learning-retention-min"
        className="form-control minutes-input"
        type="number"
        inputMode="numeric"
        min={RETENTION_MIN_DAYS}
        max={RETENTION_MAX_DAYS}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="minutes-unit">days</span>
    </span>
  );
}

function RoomRow({ room }: { room: LearningRoom }) {
  const patchy = room.samples > 0 && room.with_temperature_pct < TEMPERATURE_WARN_BELOW_PCT;
  return (
    <li className="learning-room">
      <span className="sensor-title">{room.name}</span>
      <span className="learning-collected">
        <Frozen>{describeCollected(room)}</Frozen>
      </span>
      {/* Whether a room is flagged changes as readings arrive, so the whole note is frozen. */}
      <Frozen frozen={null}>
        {patchy && (
          <span className="learning-note">
            {`No room temperature in ${100 - room.with_temperature_pct}% of readings. Check this room's sensors.`}
          </span>
        )}
      </Frozen>
    </li>
  );
}

export default function LearningSection() {
  const [data, setData] = useState<Learning | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [shorten, setShorten] = useState<number | null>(null);
  const [fitting, setFitting] = useState(false);
  const [fitErr, setFitErr] = useState<string | null>(null);
  const { toDisplayDelta, unitLabel } = useUnit();

  useEffect(() => {
    let cancelled = false;
    getLearning()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadFailed) return <p className="form-error">Could not load Smart Learning.</p>;
  if (!data) return <p className="page-subtitle">Loading Smart Learning…</p>;

  const set = async (patch: Partial<LearningSettings>) => {
    if (saving) return;
    setErr(null);
    setSaving(true);
    try {
      setData(await updateLearningSettings(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the setting");
      setAttempt((n) => n + 1);
    } finally {
      setSaving(false);
    }
  };
  const fit = async () => {
    setFitErr(null);
    setFitting(true);
    try {
      setData(await fitLearning());
    } catch (e) {
      setFitErr(e instanceof Error ? e.message : "Could not work it out");
    } finally {
      setFitting(false);
    }
  };
  const s = data.settings;

  return (
    <>
      <section className="sc-section" id="smart-learning">
        <h2 className="sc-section-title">Smart Learning</h2>
        <p className="sc-section-lead">
          HomeClimate records how each room heats and cools, and each night works out how fast each
          room warms, cools and drifts. The one thing that uses it so far is Start Rooms Early,
          below, which is off until you turn it on.
        </p>
        <RuleRow
          id="learning-sampling"
          title="Collect Room Data"
          help={`Records each room's temperature, vents, occupancy, doors and windows, and equipment state every ${data.sample_every_min} minutes.`}
          enabled={s.sampling_enabled}
          onToggle={(v) => void set({ sampling_enabled: v })}
        >
          {null}
        </RuleRow>
        <RuleRow
          id="learning-retention"
          title="Keep Room Data For"
          help={`Older readings are deleted. ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS} days.`}
        >
          <DaysInput
            value={s.sample_retention_days}
            disabled={saving}
            attempt={attempt}
            onCommit={(n) =>
              // Shortening deletes readings for good, so it asks first.
              n < s.sample_retention_days ? setShorten(n) : void set({ sample_retention_days: n })
            }
          />
        </RuleRow>
        {err && <p className="form-error">{err}</p>}
        {shorten !== null && (
          <ConfirmDialog
            title={`Keep room data for ${shorten} days?`}
            message={`Readings older than ${shorten} days will be deleted within 5 minutes. This can't be undone.`}
            confirmLabel="Delete Older Readings"
            onCancel={() => {
              setShorten(null);
              setAttempt((n) => n + 1);
            }}
            onConfirm={() => {
              const days = shorten;
              setShorten(null);
              void set({ sample_retention_days: days });
            }}
          />
        )}
      </section>

      <section className="sc-section" id="learning-data">
        <h2 className="sc-section-title">Data Collected</h2>
        <p className="sc-section-lead">
          {s.sampling_enabled
            ? "How much each room has recorded so far."
            : "Collection is off. Rooms keep the readings they already have until they age out."}{" "}
          <Frozen frozen={null}>
            {data.last_sample_at && (
              <>
                Last reading <Time value={data.last_sample_at} />.
              </>
            )}
          </Frozen>
        </p>
        {data.rooms.length === 0 ? (
          <p className="page-subtitle">Add rooms in My Home to start collecting.</p>
        ) : (
          <ul className="learning-rooms">
            {data.rooms.map((r) => (
              <RoomRow key={r.room_id} room={r} />
            ))}
          </ul>
        )}
      </section>

      <section className="sc-section" id="learning-models">
        <div className="sc-section-head">
          <h2 className="sc-section-title">What Each Room Has Taught</h2>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={fitting}
            onClick={() => void fit()}
          >
            {fitting ? "Working It Out…" : "Work It Out Now"}
          </button>
        </div>
        <p className="sc-section-lead">
          Worked out each night at 3:20 AM from the last 30 days, leaving out any time a door or
          window was open, a fire was lit or auxiliary heat ran. A room is Ready after about six
          days of usable readings across a spread of weather.
        </p>
        <RuleRow
          id="learning-early-start"
          title="Start Rooms Early"
          help="Starts heating or cooling a room ahead of its next schedule block, by as long as the room has taught it takes in this weather (15 minutes to 3 hours), so it is ready on time. Only for rooms whose rate has been learned, and only when the weather agrees: a setback is never started early. Watch Only logs what it would do."
        >
          <select
            className="form-control"
            aria-label="Start Rooms Early"
            value={s.early_start_level}
            disabled={saving}
            onChange={(e) => void set({ early_start_level: Number(e.target.value) as 0 | 1 | 2 })}
          >
            {EARLY_START_LABELS.map((label, level) => (
              <option key={label} value={level}>
                {label}
              </option>
            ))}
          </select>
        </RuleRow>
        <RuleRow
          id="learning-coast"
          title="Let Rooms Coast"
          help={`When a room is a little short of its target but will drift there on its own soon, the call waits instead of starting the equipment: up to 45 minutes, or three times that for electric strip heat. Never for a hold, and never once a room is 2° off. ${describeCoasting(data.coasting)}`}
        >
          <select
            className="form-control"
            aria-label="Let Rooms Coast"
            value={s.coast_level}
            disabled={saving}
            onChange={(e) => void set({ coast_level: Number(e.target.value) as 0 | 1 | 2 })}
          >
            {EARLY_START_LABELS.map((label, level) => (
              <option key={label} value={level}>
                {label}
              </option>
            ))}
          </select>
        </RuleRow>
        {fitErr && <p className="form-error">{fitErr}</p>}
        {data.rooms.length === 0 && (
          <p className="page-subtitle">Add rooms in My Home to start collecting.</p>
        )}
        {data.rooms.length > 0 && (
          <ul className="learning-rooms">
            {data.rooms.map((r) => (
              <li key={r.room_id} className="learning-room" aria-label={`${r.name} model`}>
                <span className="sensor-title">{r.name}</span>
                {r.model ? (
                  <>
                    <span
                      className={`badge ${r.model.grade === "ready" ? "badge-green" : "badge-gray"}`}
                    >
                      {GRADE_LABELS[r.model.grade]}
                    </span>
                    <span className="shade-why">
                      {describeModel(r.model, toDisplayDelta, unitLabel).join(". ")}.
                    </span>
                  </>
                ) : (
                  <span className="shade-why">Not worked out yet.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
