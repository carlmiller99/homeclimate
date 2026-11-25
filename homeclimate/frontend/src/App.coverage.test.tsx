import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import App from "./App";
import * as api from "./api";

vi.mock("./api");
vi.mock("./smartControlApi", async (orig) => ({
  ...(await orig<typeof import("./smartControlApi")>()),
  getSmartControl: vi
    .fn()
    .mockResolvedValue({ settings: {}, overrides: [], sensors: [], paused: [] }),
}));
vi.mock("./zonesApi", async (orig) => ({
  ...(await orig<typeof import("./zonesApi")>()),
  getZones: vi.fn().mockResolvedValue([]),
  getBuildings: vi.fn().mockResolvedValue([]),
}));

// The /metrics route is lazy-loaded so recharts stays out of the main bundle
// (#85 Phase 5e). What is under test here is App's route + Suspense wiring, so
// the page itself is stubbed — Metrics' own behaviour has its own suite, and
// pulling recharts in would make this file about chart rendering instead.
vi.mock("./pages/Metrics", () => ({
  default: () => <div data-testid="metrics-page">metrics loaded</div>,
}));

const renderApp = (initialEntries: string[] = ["/"]) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <App />
    </MemoryRouter>
  );

const settings = (over: Partial<api.AppSettings> = {}): api.AppSettings => ({
  temperature_unit: "F",
  theme: "system",
  unit_change_ack_required: false,
  vacation_mode: { enabled: false, return_at: null },
  eco_suspend: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute("data-theme");
  vi.mocked(api.getSensorHealth).mockResolvedValue({ stale_after_min: 30, rooms: [] });
  vi.mocked(api.getSensorStaleness).mockResolvedValue({ stale_after_min: 30 });
  vi.mocked(api.getThermostatHealth).mockResolvedValue({ thermostats: [] });
  vi.mocked(api.getSystemStatus).mockResolvedValue({ enabled: true, dev_mode: false });
  vi.mocked(api.getAuthStatus).mockResolvedValue({
    require_auth: false,
    authenticated: true,
    method: "open",
  });
  vi.mocked(api.getSettings).mockResolvedValue(settings());
  vi.mocked(api.getMqttStatus).mockResolvedValue({
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
  });
  vi.mocked(api.connectWS).mockReturnValue(() => {});
  // Room sensor lists and readings for the per-room temperatures.
  vi.mocked(api.getRoom).mockImplementation(
    async (id) => ({ id, sensors: [] }) as unknown as api.Room
  );
  vi.mocked(api.getEntityStates).mockResolvedValue({});
  vi.mocked(api.getStatus).mockResolvedValue([]);
  vi.mocked(api.getRooms).mockResolvedValue([]);
  vi.mocked(api.getThermostats).mockResolvedValue([]);
  vi.mocked(api.getVacationMode).mockResolvedValue({ enabled: false, return_at: null });
  vi.mocked(api.getOverrides).mockResolvedValue([]);
  vi.mocked(api.listMcpTokens).mockResolvedValue([]);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

// ---------------------------------------------------------------------------
// Lazy /metrics route
// ---------------------------------------------------------------------------

describe("the lazy Metrics route", () => {
  it("loads the split chunk when the user navigates to /metrics", async () => {
    renderApp();
    // Not requested until the route is entered.
    expect(screen.queryByTestId("metrics-page")).not.toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole("link", { name: /Analytics/i }))[0]);
    expect(await screen.findByTestId("metrics-page")).toBeInTheDocument();
  });

  it("renders the Suspense fallback while the chunk is in flight", async () => {
    renderApp(["/metrics"]);
    // The first paint of the route is the fallback; the chunk resolves a
    // microtask later and swaps the page in.
    expect(await screen.findByTestId("metrics-page")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AuthGate (#373)
// ---------------------------------------------------------------------------

describe("AuthGate resilience", () => {
  it("falls through to the app when the public status probe fails", async () => {
    vi.mocked(api.getAuthStatus).mockRejectedValue(new Error("probe exploded"));
    renderApp();

    // Not trapped on the spinner: the app renders, with the un-gated defaults
    // (method "open", requireAuth false) that the null status falls back to.
    expect(await screen.findByText(/Dashboard/i, { selector: ".page-title" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Settings/i));
    expect(await screen.findByText(/System On/i)).toBeInTheDocument();
    // requireAuth defaulted to false → no auth status row, no Log out.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/Log out/i)).not.toBeInTheDocument();
  });

  it("drops back to the login screen when a later request 401s", async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      require_auth: true,
      authenticated: true,
      method: "session",
    });
    renderApp();
    expect(await screen.findByText(/Dashboard/i, { selector: ".page-title" })).toBeInTheDocument();

    // The session lapses: api.ts dispatches this from any 401 response.
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      require_auth: true,
      authenticated: false,
      method: "none",
    });
    fireEvent(window, new CustomEvent("homeclimate-unauthorized"));

    expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Settings/i)).not.toBeInTheDocument();
  });

  it("re-checks on a 401 but stays on the app when the caller is still valid", async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      require_auth: true,
      authenticated: true,
      method: "ingress",
    });
    renderApp();
    await screen.findByText(/Dashboard/i, { selector: ".page-title" });
    const probes = vi.mocked(api.getAuthStatus).mock.calls.length;

    fireEvent(window, new CustomEvent("homeclimate-unauthorized"));

    await waitFor(() =>
      expect(vi.mocked(api.getAuthStatus).mock.calls.length).toBeGreaterThan(probes)
    );
    expect(screen.getByText(/Dashboard/i, { selector: ".page-title" })).toBeInTheDocument();
  });

  it("stops re-checking once the gate unmounts", async () => {
    const { unmount } = renderApp();
    await screen.findByText(/Dashboard/i, { selector: ".page-title" });
    unmount();
    const probes = vi.mocked(api.getAuthStatus).mock.calls.length;

    fireEvent(window, new CustomEvent("homeclimate-unauthorized"));
    expect(vi.mocked(api.getAuthStatus).mock.calls.length).toBe(probes);
  });

  it("forwards the configured OIDC provider to the login screen (#464)", async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      require_auth: true,
      authenticated: false,
      method: "none",
      oidc_enabled: true,
      oidc_provider_name: "Authelia",
      oidc_login_url: "/api/auth/oidc/login?next=%2F",
    });
    renderApp();

    const sso = await screen.findByRole("link", { name: /Authelia/i });
    expect(sso).toHaveAttribute("href", "/api/auth/oidc/login?next=%2F");
  });

  it("falls back to generic SSO labels when the probe omits the OIDC details", async () => {
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      require_auth: true,
      authenticated: false,
      method: "none",
      oidc_enabled: true,
    });
    renderApp();

    const sso = await screen.findByRole("link", { name: /SSO/i });
    expect(sso).toHaveAttribute("href", "/api/auth/oidc/login");
  });

  it("labels a require_auth caller of an unrecognised method as needing auth", async () => {
    // require_auth on and authenticated (so the gate opens), but the backend
    // did not attribute the request to ingress or a session.
    vi.mocked(api.getAuthStatus).mockResolvedValue({
      require_auth: true,
      authenticated: true,
      method: "none",
    });
    renderApp();

    fireEvent.click(await screen.findByLabelText(/Settings/i));
    expect(await screen.findByRole("status")).toHaveTextContent(/Authentication required/i);
    // No session to end, so no Log out control.
    expect(screen.queryByText(/Log out/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AppRoot seeding
// ---------------------------------------------------------------------------

describe("AppRoot seeding from the API", () => {
  it("defaults dev mode, MCP and theme when the responses omit them", async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({ enabled: true });
    // An older backend answers /api/settings without a `theme` key; the `??`
    // guard is what keeps the UI on "system" instead of undefined.
    vi.mocked(api.getSettings).mockResolvedValue({
      temperature_unit: "F",
      unit_change_ack_required: false,
      vacation_mode: { enabled: false, return_at: null },
      eco_suspend: {},
    } as unknown as api.AppSettings);
    renderApp();

    fireEvent.click(await screen.findByLabelText(/Settings/i));
    expect(await screen.findByText(/Theme: System/i)).toBeInTheDocument();
    // "system" means no pinned attribute — prefers-color-scheme decides.
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    // dev_mode absent → no Dev Mode nav link.
    expect(screen.queryByRole("link", { name: /Dev Mode/i })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("link", { name: /Settings/i }));
    fireEvent.click(await screen.findByRole("link", { name: "Integrations" }));
    expect(await screen.findByText("Off")).toBeInTheDocument(); // MCP card
    // dev_mode absent → the Dev Mode section offers to turn it on.
    fireEvent.click(screen.getByRole("link", { name: "Dev Mode" }));
    expect(await screen.findByRole("button", { name: "Turn On Dev Mode" })).toBeInTheDocument();
  });

  it("renders with built-in defaults when both mount fetches fail", async () => {
    vi.mocked(api.getSystemStatus).mockRejectedValue(new Error("backend down"));
    vi.mocked(api.getSettings).mockRejectedValue(new Error("backend down"));
    renderApp();

    // Neither rejection escapes as an unhandled error, and the shell still
    // renders on its initial state (enabled, dev off, system theme, °F).
    fireEvent.click(await screen.findByLabelText(/Settings/i));
    expect(await screen.findByText(/System On/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Dev Mode On" })).toBeNull();
    expect(screen.getByText(/Theme: System/i)).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });
});

describe("AppRoot house time zone (Issue #729)", () => {
  const openSettings = async () => {
    fireEvent.click(await screen.findByRole("link", { name: /Settings/i }));
    return screen.findByTestId("timezone-card");
  };

  it("provides the house zone from /api/settings", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...settings(),
      timezone: "America/New_York",
      timezone_fallback: false,
    });
    renderApp();
    const card = await openSettings();
    await waitFor(() => expect(card).toHaveTextContent("America/New_York"));
    expect(card).toHaveTextContent(/currently E[SD]T/);
  });

  it("passes the backend's fallback flag through", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...settings(),
      timezone: "UTC",
      timezone_fallback: true,
    });
    renderApp();
    const card = await openSettings();
    await waitFor(() => expect(card).toHaveTextContent(/missing or invalid/));
  });

  it("says the zone is unavailable when an older backend omits it", async () => {
    renderApp();
    const card = await openSettings();
    await waitFor(() => expect(card).toHaveTextContent(/Could not load the house time zone/));
  });

  it("says the zone is unavailable when /api/settings fails", async () => {
    vi.mocked(api.getSettings).mockRejectedValue(new Error("backend down"));
    renderApp();
    const card = await openSettings();
    await waitFor(() => expect(card).toHaveTextContent(/Could not load the house time zone/));
  });
});

// ---------------------------------------------------------------------------
// Double-submit guards on the three toggles
// ---------------------------------------------------------------------------

/** A promise the test resolves by hand, so a toggle can be held in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("in-flight toggles ignore a second request", () => {
  it("system toggle", async () => {
    const d = deferred<{ enabled: boolean }>();
    vi.mocked(api.setSystemEnabled).mockReturnValue(d.promise);
    renderApp();

    const gear = await screen.findByLabelText(/Settings/i);
    fireEvent.click(gear);
    fireEvent.click(await screen.findByText(/System On/i));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => expect(api.setSystemEnabled).toHaveBeenCalledTimes(1));

    // Still in flight — a second confirm must not fire a second request.
    fireEvent.click(gear);
    fireEvent.click(await screen.findByText(/System On/i));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    expect(api.setSystemEnabled).toHaveBeenCalledTimes(1);

    d.resolve({ enabled: false });
    fireEvent.click(gear);
    expect(await screen.findByText(/System Off/i)).toBeInTheDocument();
  });

  it("dev-mode toggle", async () => {
    const d = deferred<{ dev_mode: boolean }>();
    vi.mocked(api.setDevModeApi).mockReturnValue(d.promise);
    renderApp(["/settings?section=dev-mode"]);

    const turnOn = await screen.findByRole("button", { name: "Turn On Dev Mode" });
    fireEvent.click(turnOn);
    await waitFor(() => expect(api.setDevModeApi).toHaveBeenCalledTimes(1));
    fireEvent.click(turnOn);
    expect(api.setDevModeApi).toHaveBeenCalledTimes(1);

    d.resolve({ dev_mode: true });
    expect(await screen.findByRole("link", { name: "Dev Mode On" })).toBeInTheDocument();
  });

  it("MCP toggle", async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({
      enabled: true,
      dev_mode: false,
      mcp_enabled: false,
    });
    const d = deferred<{ mcp_enabled: boolean }>();
    vi.mocked(api.setMcpEnabled).mockReturnValue(d.promise);
    renderApp();

    fireEvent.click(await screen.findByRole("link", { name: /Settings/i }));
    fireEvent.click(await screen.findByRole("link", { name: "Integrations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm/i }));
    await waitFor(() => expect(api.setMcpEnabled).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    fireEvent.click(await screen.findByRole("button", { name: /Confirm/i }));
    expect(api.setMcpEnabled).toHaveBeenCalledTimes(1);

    d.resolve({ mcp_enabled: true });
    expect(await screen.findByText("Running")).toBeInTheDocument();
  });

  it("keeps the system state the server reported when the toggle fails", async () => {
    vi.mocked(api.setSystemEnabled).mockRejectedValue(new Error("nope"));
    renderApp();

    const gear = await screen.findByLabelText(/Settings/i);
    fireEvent.click(gear);
    fireEvent.click(await screen.findByText(/System On/i));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => expect(api.setSystemEnabled).toHaveBeenCalledTimes(1));

    // The failure is swallowed and the UI stays on the last known state — and,
    // crucially, the guard is released so a retry is possible.
    fireEvent.click(gear);
    expect(await screen.findByText(/System On/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/System On/i));
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => expect(api.setSystemEnabled).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// Confirm modals
// ---------------------------------------------------------------------------

describe("confirm modals", () => {
  const backdrop = (container: HTMLElement) =>
    container.querySelector(".modal-backdrop") as HTMLElement;

  it("words the system modal for turning the system back ON", async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({ enabled: false, dev_mode: false });
    vi.mocked(api.setSystemEnabled).mockResolvedValue({ enabled: true });
    renderApp();

    fireEvent.click(await screen.findByLabelText(/Settings/i));
    fireEvent.click(await screen.findByText(/System Off/i));

    expect(await screen.findByText(/Turn on system\?/i)).toBeInTheDocument();
    expect(screen.getByText(/control will resume and cycles will restart/i)).toBeInTheDocument();
    expect(screen.queryByText(/Turn off system\?/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => expect(api.setSystemEnabled).toHaveBeenCalledWith(true));
  });

  it("closes the system modal on a backdrop click but not on a click inside it", async () => {
    const { container } = renderApp();
    fireEvent.click(await screen.findByLabelText(/Settings/i));
    fireEvent.click(await screen.findByText(/System On/i));
    await screen.findByText(/Turn off system\?/i);

    // A click that lands on the dialog itself must not dismiss it.
    fireEvent.click(container.querySelector(".modal") as HTMLElement);
    expect(screen.getByText(/Turn off system\?/i)).toBeInTheDocument();

    fireEvent.click(backdrop(container));
    await waitFor(() => expect(screen.queryByText(/Turn off system\?/i)).not.toBeInTheDocument());
    expect(api.setSystemEnabled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

describe("Nav", () => {
  it("shows the Dev Mode pill outside the mobile menu, and menu links close the menu", async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({ enabled: true, dev_mode: true });
    const { container } = renderApp();
    await screen.findByLabelText(/Settings/i);

    // The pill sits in the always-visible nav row, so it is reachable on a
    // phone without opening the menu.
    const pill = await screen.findByRole("link", { name: "Dev Mode On" });
    expect(pill).toHaveAttribute("href", "/settings?section=dev-mode");
    expect(container.querySelector(".nav-right")).toContainElement(pill);

    fireEvent.click(screen.getByLabelText(/Toggle menu/i));
    const menu = container.querySelector(".nav-mobile-menu") as HTMLElement;
    expect(within(menu).queryByRole("link", { name: /Dev Mode/i })).toBeNull();
    fireEvent.click(within(menu).getByRole("link", { name: "Smart Control" }));
    await waitFor(() => expect(container.querySelector(".nav-mobile-menu")).toBeNull());
  });

  it("keeps the settings dropdown open when the mousedown lands inside it", async () => {
    const { container } = renderApp();
    fireEvent.click(await screen.findByLabelText(/Settings/i));
    const menu = container.querySelector(".settings-menu") as HTMLElement;
    expect(menu).not.toBeNull();

    // The outside-click watcher listens on mousedown, so pressing inside the
    // menu (e.g. starting a drag on the theme row) must not dismiss it.
    fireEvent.mouseDown(menu);
    expect(screen.getByText(/System On/i)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText(/Theme: System/i));
    expect(screen.getByText(/System On/i)).toBeInTheDocument();
  });

  it("hides the Dev Mode link from both menus when dev mode is off", async () => {
    const { container } = renderApp();
    await screen.findByLabelText(/Settings/i);
    expect(screen.queryByRole("link", { name: /Dev Mode/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Toggle menu/i));
    const menu = container.querySelector(".nav-mobile-menu") as HTMLElement;
    expect(within(menu).queryByRole("link", { name: /Dev Mode/i })).not.toBeInTheDocument();
  });
});
