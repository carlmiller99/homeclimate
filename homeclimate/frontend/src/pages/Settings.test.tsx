import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import Settings from "./Settings";
import * as api from "../api";
import {
  McpContext,
  AuthContext,
  TimeZoneContext,
  buildTimeZoneContext,
  type AuthContextValue,
} from "../contexts";

vi.mock("../api");
// Each of these has its own suite; here they only show which section they are in.
vi.mock("./Logs", () => ({ default: () => <p>logs page</p> }));
vi.mock("./DevMode", () => ({ default: () => <p>dev mode page</p> }));
vi.mock("./NotificationsSection", () => ({ default: () => <p>notifications section</p> }));
vi.mock("./Thermostats", () => ({ SensorStalenessCard: () => <p>staleness card</p> }));

const mqttStatus = (over: Partial<api.MqttStatus> = {}): api.MqttStatus => ({
  enabled: false,
  configured: false,
  connected: false,
  host: null,
  port: null,
  topic_prefix: "homeclimate",
  prefix_is_fallback: false,
  discovery: true,
  discovery_prefix: "homeassistant",
  last_error: null,
  ...over,
});

const authValue = (over: Partial<AuthContextValue> = {}): AuthContextValue => ({
  requireAuth: false,
  method: "open",
  logout: vi.fn(),
  ...over,
});

function renderSettings({
  mcpEnabled = false,
  toggleMcp = vi.fn().mockResolvedValue(undefined),
  auth = authValue(),
  section,
}: {
  section?: string;
  mcpEnabled?: boolean;
  toggleMcp?: () => Promise<void>;
  auth?: AuthContextValue;
} = {}) {
  return render(
    <AuthContext.Provider value={auth}>
      <McpContext.Provider value={{ mcpEnabled, toggleMcp }}>
        <MemoryRouter initialEntries={[section ? `/settings?section=${section}` : "/settings"]}>
          <Settings />
        </MemoryRouter>
      </McpContext.Provider>
    </AuthContext.Provider>
  );
}

describe("Settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listMcpTokens).mockResolvedValue([]);
    vi.mocked(api.downloadBackup).mockReturnValue(undefined);
    // The MQTT card polls on mount (#519). Default to "no broker configured",
    // which is what a stock install reports.
    vi.mocked(api.getMqttStatus).mockResolvedValue(mqttStatus());
  });

  it("opens on General with the side menu, and Backup & Restore", () => {
    renderSettings();
    expect(screen.getByText(/Settings/i, { selector: ".page-title" })).toBeInTheDocument();
    expect(screen.getByText(/Backup & Restore/i)).toBeInTheDocument();
    expect(screen.queryByText("MCP server")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    for (const [label, id] of [
      ["Sensors", "sensors"],
      ["Integrations", "integrations"],
      ["Logs", "logs"],
      ["Dev Mode", "dev-mode"],
    ]) {
      const link = within(nav).getByRole("link", { name: label });
      expect(link).toHaveAttribute("href", `/settings?section=${id}`);
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("falls back to General for an unknown section", () => {
    renderSettings({ section: "nope" });
    expect(screen.getByText(/Backup & Restore/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the sensors used everywhere under Sensors", () => {
    renderSettings({ section: "sensors" });
    // The outside sensors are hardware: they are in My Home, not here.
    expect(screen.queryByText(/Outside temperature sensors/)).toBeNull();
    expect(screen.getByText("staleness card")).toBeInTheDocument();
    expect(screen.queryByText(/Backup & Restore/i)).toBeNull();
  });

  it("puts Logs and Dev Mode inside Settings", () => {
    const logs = renderSettings({ section: "logs" });
    expect(screen.getByText("logs page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Logs" })).toHaveAttribute("aria-current", "page");
    logs.unmount();
    renderSettings({ section: "dev-mode" });
    expect(screen.getByText("dev mode page")).toBeInTheDocument();
    expect(screen.queryByText("logs page")).toBeNull();
  });

  it("has a Notifications section", () => {
    renderSettings({ section: "notifications" });
    expect(screen.getByText("notifications section")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("renders the MCP server card and inline setup guidance under Integrations", () => {
    renderSettings({ section: "integrations" });
    expect(screen.getByText("MCP server")).toBeInTheDocument();
    // The setup steps render inline (readable) instead of being buried in the modal.
    expect(screen.getByText(/Home Assistant OS \/ Supervised/i)).toBeInTheDocument();
    expect(screen.getByText(/Docker \(standalone\)/i)).toBeInTheDocument();
  });

  it("shows the house time zone card, loading until the zone arrives (#729)", () => {
    renderSettings();
    expect(screen.getByTestId("timezone-card")).toHaveTextContent("Loading…");
    expect(screen.getByTestId("timezone-card")).toHaveTextContent(/timezone/);
  });

  it("names the house zone and its current short name (#729)", () => {
    render(
      <TimeZoneContext.Provider value={buildTimeZoneContext("America/New_York")}>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </TimeZoneContext.Provider>
    );
    const card = screen.getByTestId("timezone-card");
    expect(card).toHaveTextContent(/America\/New_York \(currently E[SD]T\)/);
    expect(card).not.toHaveTextContent(/missing or invalid/);
  });

  it("hides the token card and shows the unauthenticated note when auth is off", () => {
    renderSettings({ section: "integrations", auth: authValue({ requireAuth: false }) });
    expect(screen.queryByText(/MCP access tokens/i)).not.toBeInTheDocument();
    expect(screen.getByText(/unauthenticated/i)).toBeInTheDocument();
  });

  it("shows the token card and the bearer-token note when auth is required", async () => {
    renderSettings({ section: "integrations", auth: authValue({ requireAuth: true }) });
    expect(await screen.findByText(/MCP access tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/mint a bearer token below/i)).toBeInTheDocument();
  });

  it("confirms enabling the MCP server", async () => {
    const toggleMcp = vi.fn().mockResolvedValue(undefined);
    renderSettings({ section: "integrations", mcpEnabled: false, toggleMcp });
    expect(screen.getByText("Off")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Turn on/i }));
    expect(await screen.findByText(/Turn on MCP server\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => expect(toggleMcp).toHaveBeenCalled());
  });

  it("notes that a token is needed when enabling with auth on", async () => {
    renderSettings({
      section: "integrations",
      mcpEnabled: false,
      auth: authValue({ requireAuth: true }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Turn on/i }));
    expect(await screen.findByText(/mint a bearer token after enabling/i)).toBeInTheDocument();
  });

  it("cancels disabling the MCP server without toggling", async () => {
    const toggleMcp = vi.fn();
    renderSettings({ section: "integrations", mcpEnabled: true, toggleMcp });
    expect(screen.getByText("Running")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Turn off/i }));
    expect(await screen.findByText(/Turn off MCP server\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect(toggleMcp).not.toHaveBeenCalled();
  });

  it("downloads a backup", () => {
    renderSettings();
    fireEvent.click(screen.getByText("Download backup"));
    expect(api.downloadBackup).toHaveBeenCalled();
  });

  it("restores from a backup file", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.restoreBackup).mockResolvedValue(undefined);
    const { container } = renderSettings();

    const fileInput = container.querySelector("#restore-backup-input") as HTMLInputElement;
    const file = new File(["x"], "homeclimate.db", { type: "application/x-sqlite3" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Identity, not `toHaveBeenCalledWith(file)`. A jsdom `File` exposes no
    // enumerable own properties, so vitest's structural comparison treats
    // EVERY File as equal to every other one — `toHaveBeenCalledWith` would
    // still pass if the handler uploaded a blank file it made up. `toBe` is
    // the only comparison that actually pins the operator's chosen file.
    await waitFor(() => expect(api.restoreBackup).toHaveBeenCalled());
    const [uploaded] = vi.mocked(api.restoreBackup).mock.calls[0];
    expect(uploaded).toBe(file);
    expect(uploaded.name).toBe("homeclimate.db");
    expect(uploaded.size).toBe(1);

    expect(await screen.findByText(/Restore complete/i)).toBeInTheDocument();
  });

  it("shows an error badge when the restore fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.restoreBackup).mockRejectedValue(new Error("corrupt database file"));
    const { container } = renderSettings();

    const fileInput = container.querySelector("#restore-backup-input") as HTMLInputElement;
    const file = new File(["x"], "homeclimate.db", { type: "application/x-sqlite3" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("corrupt database file")).toBeInTheDocument();
    expect((await screen.findByText("corrupt database file")).className).toContain("badge-red");
  });

  it("opens the hidden file input when Restore from backup is clicked", () => {
    const { container } = renderSettings();
    const fileInput = container.querySelector("#restore-backup-input") as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, "click");
    fireEvent.click(screen.getByRole("button", { name: /Restore from backup/i }));
    expect(clickSpy).toHaveBeenCalled();
  });

  it("aborts a restore when the user cancels the confirm prompt", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container } = renderSettings();

    const fileInput = container.querySelector("#restore-backup-input") as HTMLInputElement;
    const file = new File(["x"], "homeclimate.db", { type: "application/x-sqlite3" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(api.restoreBackup).not.toHaveBeenCalled();
  });
});
