import { useEffect, useState } from "react";
import { Frozen } from "../ci";
import { RuleRow } from "../components/SmartControlControls";
import {
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
function DaysInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // A save changed the stored value: show it (adjust during render).
    setShown(value);
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
    <li className={`learning-room${patchy ? " is-patchy" : ""}`}>
      <span className="sensor-title">{room.name}</span>
      <span className="learning-collected">
        <Frozen>{describeCollected(room)}</Frozen>
      </span>
      {patchy && (
        <span className="learning-note">
          <Frozen>
            {`No room temperature in ${100 - room.with_temperature_pct}% of readings. Check this room's sensors.`}
          </Frozen>
        </span>
      )}
    </li>
  );
}

export default function LearningSection() {
  const [data, setData] = useState<Learning | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    setErr(null);
    try {
      setData(await updateLearningSettings(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the setting");
    }
  };
  const s = data.settings;

  return (
    <>
      <section className="sc-section" id="smart-learning">
        <h2 className="sc-section-title">Smart Learning</h2>
        <p className="sc-section-lead">
          HomeClimate records how each room heats and cools so it can learn to plan ahead. Recording
          does not change how your home is controlled.
        </p>
        <RuleRow
          id="learning-sampling"
          title="Collect Room Data"
          help={`Records each room's temperature, vents, occupancy and equipment state every ${data.sample_every_min} minutes.`}
          enabled={s.sampling_enabled}
          onToggle={(v) => set({ sampling_enabled: v })}
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
            onCommit={(n) => set({ sample_retention_days: n })}
          />
        </RuleRow>
        {err && <p className="form-error">{err}</p>}
      </section>

      <section className="sc-section" id="learning-data">
        <h2 className="sc-section-title">Data Collected</h2>
        <p className="sc-section-lead">
          {s.sampling_enabled
            ? "Learning needs about two weeks of readings from a room before it can model it."
            : "Collection is off. Rooms keep the readings they already have until they age out."}
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
    </>
  );
}
