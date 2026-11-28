import { useRef, useState, type ReactNode } from "react";
import NotificationsSection from "./NotificationsSection";
import { useSearchParams } from "react-router";
import { downloadBackup, restoreBackup } from "../api";
import { useAuth, useTimeZone } from "../contexts";
import McpServerCard from "../components/McpServerCard";
import McpTokensCard from "../components/McpTokensCard";
import MqttBridgeCard from "../components/MqttBridgeCard";
import SectionLayout from "../components/SectionLayout";
import { SETTINGS_SECTIONS } from "../sections";
import DevModePage from "./DevMode";
import Logs from "./Logs";
import { SensorStalenessCard } from "./Thermostats";

// ---------------------------------------------------------------------------
// Backup / Restore card (moved from the Thermostats page in #471 — it is an
// add-on administration control, not thermostat configuration)
// ---------------------------------------------------------------------------

function BackupRestoreCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (
      !confirm("Restore this database? Current data will be replaced and the engine will restart.")
    ) {
      e.target.value = "";
      return;
    }
    setRestoring(true);
    setStatus(null);
    try {
      await restoreBackup(file);
      setStatus({ ok: true, msg: "Restore complete — configuration reloaded." });
    } catch (err) {
      setStatus({ ok: false, msg: err instanceof Error ? err.message : "Restore failed" });
    } finally {
      setRestoring(false);
      e.target.value = "";
    }
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-title" style={{ marginBottom: ".25rem" }}>
        Backup &amp; Restore
      </div>
      <div className="text-muted" style={{ fontSize: ".85rem", marginBottom: "1.25rem" }}>
        Download your configuration database or restore from a previous backup.
      </div>
      <div style={{ display: "flex", gap: ".75rem", alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-secondary" onClick={downloadBackup}>
          Download backup
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={restoring}
        >
          {restoring ? "Restoring…" : "Restore from backup"}
        </button>
        <input
          ref={fileRef}
          id="restore-backup-input"
          type="file"
          accept=".db"
          style={{ display: "none" }}
          onChange={handleRestore}
        />
        {status && (
          <span className={`badge ${status.ok ? "badge-green" : "badge-red"}`}>{status.msg}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// House time zone (Issue #729) — read-only: the zone is an add-on option, not
// something the API writes. Shown so it is visible without hovering a time.
// ---------------------------------------------------------------------------

function TimeZoneCard() {
  const tz = useTimeZone();
  let body: React.ReactNode;
  if (tz.source === "loading") {
    body = <span className="text-muted">Loading…</span>;
  } else if (tz.source === "unavailable") {
    body = (
      <span className="badge badge-red">
        {`Could not load the house time zone. Times are being shown in your browser's zone (${tz.zone}).`}
      </span>
    );
  } else {
    body = (
      <>
        <strong>{tz.zone}</strong>
        <span className="text-muted">{` (currently ${tz.zoneShort()})`}</span>
        {tz.houseFallback && (
          <div className="badge badge-orange" style={{ marginTop: ".5rem", display: "block" }}>
            {`The add-on's timezone option is missing or invalid, so HomeClimate fell back to ${tz.zone}. Schedules and every time shown here use this zone.`}
          </div>
        )}
      </>
    );
  }
  return (
    <div className="card" style={{ marginBottom: "1rem" }} data-testid="timezone-card">
      <div className="card-title" style={{ marginBottom: ".25rem" }}>
        Time zone
      </div>
      <div style={{ marginBottom: ".5rem" }}>{body}</div>
      <div className="form-hint">
        Every time in HomeClimate uses this time zone, wherever you view it from. Change it in the
        add-on&apos;s <code>timezone</code> option, then restart the add-on.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Settings() {
  const { requireAuth } = useAuth();
  const [params] = useSearchParams();
  // An unknown or planned section falls back to the first one.
  const asked = params.get("section");
  const section = (
    SETTINGS_SECTIONS.find((x) => x.id === asked && !x.planned) ?? SETTINGS_SECTIONS[0]
  ).id;

  let body: ReactNode;
  if (section === "sensors") {
    body = (
      <>
        <p className="field-help">Add sensors on the My Home tab.</p>
        <SensorStalenessCard />
      </>
    );
  } else if (section === "integrations") {
    body = (
      <>
        <McpServerCard />
        {/* The token card is gated on require_auth (with auth off, MCP is open and
            tokens are pointless). It sits directly under the MCP server toggle so
            the whole MCP feature reads as one thing. */}
        {requireAuth && <McpTokensCard />}
        <MqttBridgeCard />
      </>
    );
  } else if (section === "notifications") {
    body = <NotificationsSection />;
  } else if (section === "logs") {
    body = (
      <div className="embedded-page">
        <Logs />
      </div>
    );
  } else if (section === "dev-mode") {
    body = (
      <div className="embedded-page">
        <DevModePage />
      </div>
    );
  } else {
    body = (
      <>
        <TimeZoneCard />
        <BackupRestoreCard />
      </>
    );
  }

  return (
    <SectionLayout
      title="Settings"
      subtitle="The house time zone, sensors used everywhere, integrations, logs, and Dev Mode."
      basePath="/settings"
      sections={SETTINGS_SECTIONS}
      current={section}
    >
      {body}
    </SectionLayout>
  );
}
