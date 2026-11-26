import { useEffect, useRef, useState } from "react";
import { RuleRow } from "../components/SmartControlControls";
import {
  getNotifications,
  hourLabel,
  sendTestNotification,
  updateNotifySettings,
  type Notifications,
  type NotifySettings,
} from "../notifyApi";

const SERVICE_SHAPE = /^notify\.[a-z0-9_]+$/i;

/** Settings → Notifications: which events are sent, and where. */
export default function NotificationsSection() {
  const [data, setData] = useState<Notifications | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The service is typed, then saved on blur or Enter.
  const [service, setService] = useState("");
  const [shownService, setShownService] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getNotifications()
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

  if (loadFailed) return <p className="form-error">Could not load notifications.</p>;
  if (!data) return <p className="page-subtitle">Loading notifications…</p>;

  const s = data.settings;
  if (shownService !== s.service) {
    // What is stored changed (first load, or a save): show it.
    setShownService(s.service);
    setService(s.service);
  }

  // One request at a time, in the order they were asked for: a click made
  // while a save is on its way waits its turn rather than being lost.
  const run = (call: () => Promise<Notifications>, done?: string) => {
    pending.current += 1;
    setBusy(true);
    queue.current = queue.current.then(async () => {
      setErr(null);
      setNote(null);
      try {
        setData(await call());
        if (done) setNote(done);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not save");
      } finally {
        pending.current -= 1;
        if (pending.current === 0) setBusy(false);
      }
    });
  };
  const set = (patch: Partial<NotifySettings>) => run(() => updateNotifySettings(patch));
  const commitService = () => {
    const typed = service.trim();
    if (typed === s.service) return;
    if (typed !== "" && !SERVICE_SHAPE.test(typed)) {
      setErr("A notify service looks like notify.mobile_app_my_phone");
      return;
    }
    set({ service: typed });
  };

  return (
    <>
      <section className="sc-section" id="notifications">
        <h2 className="sc-section-title">Notifications</h2>
        <p className="sc-section-lead">
          HomeClimate can send the problems it logs to your phone through Home Assistant. Each
          message is sent once, and no more than six warnings and six errors in an hour.
        </p>
        <RuleRow
          id="notify-enabled"
          title="Send Notifications"
          help="Nothing is sent until this is on and a notify service is chosen."
          enabled={s.enabled}
          onToggle={(v) => set({ enabled: v })}
        >
          {null}
        </RuleRow>
        <div className="rule-row">
          <span className="switch-spacer" />
          <div className="rule-text">
            <label className="rule-title" htmlFor="notify-service">
              Notify Service
            </label>
            <p className="rule-help">
              The Home Assistant service to send through, such as notify.mobile_app_my_phone. Find
              yours in Home Assistant under Developer Tools, Actions.
            </p>
          </div>
          <div className="rule-value">
            <input
              id="notify-service"
              className="form-control"
              value={service}
              disabled={busy}
              placeholder="notify.mobile_app_my_phone"
              onChange={(e) => setService(e.target.value)}
              onBlur={commitService}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitService();
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !s.service}
              onClick={() => run(sendTestNotification, "Test sent. Check your phone.")}
            >
              Send a Test
            </button>
          </div>
        </div>
        {data.last_send_failed && !err && (
          <p className="fireplace-note">
            The last notification could not be sent. Check the service name and send a test.
          </p>
        )}
        {note && (
          <p className="shade-why" role="status">
            {note}
          </p>
        )}
        {err && <p className="form-error">{err}</p>}
      </section>

      <section className="sc-section" id="notify-what">
        <h2 className="sc-section-title">What to Send</h2>
        <div className="rule-row">
          <span className="switch-spacer" />
          <div className="rule-text">
            <label className="rule-title" htmlFor="notify-level">
              How Serious
            </label>
            <p className="rule-help">Warnings include things that fixed themselves.</p>
          </div>
          <div className="rule-value">
            <select
              id="notify-level"
              className="form-control"
              value={s.level}
              disabled={busy}
              onChange={(e) => set({ level: e.target.value as NotifySettings["level"] })}
            >
              <option value="warning">Warnings and Errors</option>
              <option value="error">Errors Only</option>
            </select>
          </div>
        </div>
        <fieldset className="notify-categories" disabled={busy}>
          <legend className="rule-title">About</legend>
          {data.categories.map((c) => (
            <label key={c.id} className="notify-category">
              <input
                type="checkbox"
                checked={s.categories.includes(c.id)}
                onChange={(e) =>
                  set({
                    categories: e.target.checked
                      ? [...s.categories, c.id]
                      : s.categories.filter((x) => x !== c.id),
                  })
                }
              />
              <span>{c.label}</span>
            </label>
          ))}
        </fieldset>
        <RuleRow
          id="notify-summary"
          title="Daily Summary"
          help="One message a day: how long heating and cooling ran yesterday, and how many warnings were logged."
          enabled={s.daily_summary}
          onToggle={(v) => set({ daily_summary: v })}
        >
          <select
            className="form-control"
            aria-label="Send the daily summary at"
            value={s.summary_hour}
            disabled={busy || !s.daily_summary}
            onChange={(e) => set({ summary_hour: Number(e.target.value) })}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </RuleRow>
        <RuleRow
          id="notify-dev"
          title="Also Send in Dev Mode"
          help="Dev Mode commands nothing, so its warnings are usually noise. Leave this off unless you are testing notifications."
          enabled={s.in_dev_mode}
          onToggle={(v) => set({ in_dev_mode: v })}
        >
          {null}
        </RuleRow>
      </section>
    </>
  );
}
