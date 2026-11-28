import { useEffect, useRef, useState } from "react";
import { useUnit } from "../contexts";
import { Frozen } from "../ci";
import {
  SWITCHING_LABELS,
  THRESHOLD_MAX_F,
  THRESHOLD_MIN_F,
  getBuildingModes,
  setBuildingMode,
  type BuildingMode,
  type Switching,
} from "../buildingModeApi";
import {
  GAP_CHOICES,
  describeBalance,
  getZoneBalance,
  setZoneBalance,
  type BalanceBuilding,
} from "../zoneBalanceApi";
import Segmented from "../components/Segmented";
import { Switch } from "../components/SmartControlControls";

/** How often the zones' temperatures are looked at again. */
const REFRESH_MS = 30_000;

const SWITCHING_HELP: Record<Switching, string> = {
  often:
    "At least 4 hours apart, and no more than twice a day. For days that need heat in the morning and cooling in the afternoon.",
  daily: "Once in any 24 hours. A zone heats or cools for the day, and the other one waits.",
  weekly:
    "Once in any 7 days. It also waits until the forecast for the coming days calls for the switch, so one odd day does not use it up.",
  monthly:
    "Once in any 30 days: a change of season. It also waits until the forecast for the coming days calls for the switch.",
};

type Patch = Parameters<typeof setBuildingMode>[1];

/**
 * How far past its target a room must be before Auto considers changing sides.
 * Holds display-unit text; the backend converts on write (#231). Re-derived
 * during render, keyed on the stored content (pitfall 9). Saves on blur or
 * Enter; anything outside the limits goes back to what is stored.
 */
function ThresholdField({
  building,
  busy,
  onSave,
}: {
  building: BuildingMode;
  busy: boolean;
  onSave: (patch: Patch) => void;
}) {
  const { toDisplayDelta, displayBound, unitLabel } = useUnit();
  const stored = String(toDisplayDelta(building.switch_threshold));
  const [text, setText] = useState(stored);
  const [derived, setDerived] = useState(stored);
  if (derived !== stored) {
    setDerived(stored);
    setText(stored);
  }
  // Bounds the backend will accept once converted back (5.55 °C, not 5.56).
  const low = displayBound(THRESHOLD_MIN_F, "min", "delta");
  const high = displayBound(THRESHOLD_MAX_F, "max", "delta");
  const value = text.trim() === "" ? NaN : Number(text);
  const valid = Number.isFinite(value) && value >= low && value <= high;
  const commit = () => {
    if (!valid) setText(stored);
    else if (text !== stored) onSave({ switch_threshold: value });
  };
  return (
    <div className="field-stack auto-value">
      <span className="threshold-row">
        <input
          className="form-control house-band-input"
          type="number"
          inputMode="decimal"
          step="any"
          min={low}
          max={high}
          aria-label={`Switching threshold for ${building.name} (${unitLabel})`}
          title={`Between ${low} and ${high}${unitLabel}.`}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <span className="minutes-unit">{unitLabel}</span>
      </span>
      {!valid && <span className="form-error">{`Between ${low} and ${high}${unitLabel}.`}</span>}
    </div>
  );
}

/** One setting on a building's card: what it is, what it does, and its control. */
function AutoRow({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="auto-row">
      <div className="auto-row-text">
        <span className="auto-row-title">{title}</span>
        <p className="rule-help">{help}</p>
      </div>
      <div className="auto-row-value">{children}</div>
    </div>
  );
}

/**
 * A building's zones right now: each on a line from the coolest reading to the
 * warmest, so how far apart they are can be seen as well as read.
 */
function BalanceNow({
  building: b,
  notes,
  fmtTemp,
  fmtDelta,
}: {
  building: BalanceBuilding;
  /** Why a zone has not switched yet, by thermostat. */
  notes: string[];
  fmtTemp: (f: number) => string;
  fmtDelta: (f: number) => string;
}) {
  const temps = b.zones.map((z) => z.temp).filter((t): t is number => t !== null);
  const low = Math.min(...temps);
  const high = Math.max(...temps);
  // Half the line is always in use, so two zones a degree apart do not sit
  // at opposite ends of it.
  const span = Math.max(high - low, b.zone_gap);
  const mid = (high + low) / 2;
  const at = (t: number) => 50 + ((t - mid) / span) * 80;
  return (
    <div className="balance-now">
      <div className="balance-now-head">
        <strong>Right Now</strong>
        <span className="balance-now-gap">
          {b.spread === null
            ? "Waiting for two readings"
            : `Gap ${fmtDelta(b.spread)} of ${fmtDelta(b.zone_gap)} allowed`}
        </span>
      </div>
      {b.zones.map((z) => (
        <div key={z.thermostat_entity_id} className="balance-zone">
          <span className="balance-zone-name">{z.name}</span>
          <span className="balance-track" aria-hidden="true">
            {z.temp !== null && (
              <span
                className={`balance-dot${z.target !== null ? ` balance-${b.direction ?? "heating"}` : ""}`}
                style={{ left: `${at(z.temp).toFixed(1)}%` }}
              />
            )}
          </span>
          <strong className="balance-zone-temp">
            {z.temp === null ? "No reading" : fmtTemp(z.temp)}
          </strong>
        </div>
      ))}
      <p className="balance-now-say">
        {[describeBalance(b, fmtTemp, fmtDelta), ...notes].join(" ")}
      </p>
    </div>
  );
}

/** Smart Control → Auto Mode: the limits each building's zones keep to. */
export default function BuildingAutoCard() {
  const { unit, unitLabel, fmtTemp, toDisplayDelta } = useUnit();
  const [buildings, setBuildings] = useState<BuildingMode[] | null>(null);
  const [balance, setBalance] = useState<BalanceBuilding[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getBuildingModes()
      .then((b) => {
        if (!cancelled) setBuildings(b);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    const loadBalance = () =>
      getZoneBalance()
        .then((d) => {
          // Not over a change being saved: its answer is the newer one.
          if (!cancelled && !saving.current) setBalance(d.buildings);
        })
        // A failed read keeps what is shown; without it the gap is not offered.
        .catch(() => {});
    void loadBalance();
    // The gap moves with the house: look again every half minute.
    const timer = setInterval(() => void loadBalance(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const run = async (work: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    saving.current = true;
    try {
      await work();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const change = (id: string, patch: Patch) =>
    run(async () => setBuildings(await setBuildingMode(id, patch)));
  const changeGap = (id: string, patch: { level?: "off" | "on"; zone_gap?: number }) =>
    run(async () => setBalance((await setZoneBalance(id, patch)).buildings));

  const fmtDelta = (f: number) => `${toDisplayDelta(f).toFixed(1)}${unitLabel}`;

  return (
    <section className="sc-section" id="auto-mode">
      <h2 className="sc-section-title">Auto Mode</h2>
      <p className="sc-section-lead">
        How the zones in each building heat and cool when its mode on the Dashboard is Auto.
      </p>
      {loadFailed && <p className="form-error">Could not load the buildings.</p>}
      {!loadFailed && !buildings && <p className="page-subtitle">Loading the buildings…</p>}
      {buildings && buildings.length === 0 && (
        <p className="page-subtitle">Add a building in My Home and put zones in it to use this.</p>
      )}
      {buildings?.map((b) => {
        // One zone has nothing to run opposite or drift away from.
        const several = b.zones.length !== 1;
        const bal = balance?.find((x) => x.building_id === b.building_id);
        const shown = bal ? Number(toDisplayDelta(bal.zone_gap).toFixed(1)) : 0;
        const choices: number[] = [...GAP_CHOICES[unit]];
        if (bal && !choices.includes(shown)) choices.push(shown);
        choices.sort((x, y) => x - y);
        const notes = b.zones
          .filter((z) => z.note.startsWith("Wants"))
          .map((z) => `${z.name} ${z.note.charAt(0).toLowerCase()}${z.note.slice(1)}.`);
        return (
          <div role="group" key={b.building_id} className="card auto-card" aria-label={b.name}>
            <h4 className="sensor-title">{b.name}</h4>
            {b.mode !== "auto" && (
              <p className="rule-help">
                Not set to Auto on the Dashboard, so these apply only to zones set to Auto there.
              </p>
            )}
            {several && (
              <AutoRow
                title="Zones May Run Opposite Each Other"
                help="When No, one zone may heat while another coasts, never while another cools. A zone in use goes first, whatever its mode."
              >
                <Segmented
                  label={`Zones in ${b.name} may run opposite each other`}
                  value={b.opposite_allowed ? "yes" : "no"}
                  disabled={busy}
                  options={[
                    { value: "yes", label: "Yes" },
                    { value: "no", label: "No" },
                  ]}
                  onChange={(v) => void change(b.building_id, { opposite_allowed: v === "yes" })}
                />
              </AutoRow>
            )}
            <AutoRow
              title="May Switch Between Heating and Cooling"
              help={SWITCHING_HELP[b.switching]}
            >
              <Segmented
                label={`How often zones in ${b.name} may switch`}
                value={b.switching}
                disabled={busy}
                options={(Object.keys(SWITCHING_LABELS) as Switching[]).map((s) => ({
                  value: s,
                  label: SWITCHING_LABELS[s],
                  title: SWITCHING_HELP[s],
                }))}
                onChange={(s) => void change(b.building_id, { switching: s })}
              />
            </AutoRow>
            <AutoRow
              title="Threshold for Switching Mode"
              help="A heating zone switches to cooling only when a room is this much warmer than its Cooling Target. The reverse works the same way."
            >
              <ThresholdField
                building={b}
                busy={busy}
                onSave={(patch) => void change(b.building_id, patch)}
              />
            </AutoRow>
            {several && bal && (
              <>
                <AutoRow
                  title="Keep Zones Within"
                  help="A zone left behind is heated or cooled to stay this close to the zones in use. It never switches a zone early."
                >
                  <span className="threshold-row">
                    <select
                      className="form-control"
                      aria-label={`Gap limit for ${b.name}`}
                      value={shown}
                      disabled={busy}
                      onChange={(e) =>
                        void changeGap(b.building_id, { zone_gap: Number(e.target.value) })
                      }
                    >
                      {choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <span className="minutes-unit">{unitLabel}</span>
                    <Switch
                      id={`gap-${b.building_id}`}
                      label={`Keep zones in ${b.name} within the gap`}
                      checked={bal.level === "on"}
                      disabled={busy}
                      onChange={(on) => void changeGap(b.building_id, { level: on ? "on" : "off" })}
                    />
                  </span>
                </AutoRow>
                {bal.zones.length > 1 && (
                  <Frozen>
                    <BalanceNow
                      building={bal}
                      notes={notes}
                      fmtTemp={fmtTemp}
                      fmtDelta={fmtDelta}
                    />
                  </Frozen>
                )}
              </>
            )}
          </div>
        );
      })}
      {err && <p className="form-error">{err}</p>}
    </section>
  );
}
