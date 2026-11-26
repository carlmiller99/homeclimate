import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NotificationsSection from "./NotificationsSection";
import * as na from "../notifyApi";

vi.mock("../notifyApi", async (orig) => ({
  ...(await orig<typeof import("../notifyApi")>()),
  getNotifications: vi.fn(),
  updateNotifySettings: vi.fn(),
  sendTestNotification: vi.fn(),
}));

function data(over: Partial<na.NotifySettings> = {}, failed = false): na.Notifications {
  return {
    settings: {
      enabled: true,
      service: "notify.mobile_app_phone",
      level: "warning",
      categories: ["engine", "reconcile"],
      daily_summary: false,
      summary_hour: 7,
      in_dev_mode: false,
      ...over,
    },
    categories: [
      { id: "engine", label: "Heating and cooling" },
      { id: "reconcile", label: "Outside changes" },
      { id: "fireplace", label: "Fireplace" },
    ],
    last_send_failed: failed,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(na.getNotifications).mockResolvedValue(data());
  vi.mocked(na.updateNotifySettings).mockImplementation(async (patch) => data(patch));
  vi.mocked(na.sendTestNotification).mockResolvedValue(data());
});

describe("Settings → Notifications", () => {
  it("shows what is chosen and saves each change", async () => {
    render(<NotificationsSection />);
    expect(screen.getByText("Loading notifications…")).toBeInTheDocument();
    expect(await screen.findByLabelText("Notify Service")).toHaveValue("notify.mobile_app_phone");
    expect(screen.getByRole("checkbox", { name: "Heating and cooling" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Fireplace" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Fireplace" }));
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenCalledWith({
        categories: ["engine", "reconcile", "fireplace"],
      })
    );
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Fireplace" })).toBeChecked());
    fireEvent.click(screen.getByRole("checkbox", { name: "Outside changes" }));
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenLastCalledWith({
        categories: ["engine", "fireplace"],
      })
    );
    fireEvent.change(screen.getByLabelText("How Serious"), { target: { value: "error" } });
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenLastCalledWith({ level: "error" })
    );
    fireEvent.click(screen.getByRole("switch", { name: /Send Notifications/ }));
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenLastCalledWith({ enabled: false })
    );
    fireEvent.click(screen.getByRole("switch", { name: /Also Send in Dev Mode/ }));
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenLastCalledWith({ in_dev_mode: true })
    );
  });

  it("saves a typed service on blur or Enter, and refuses one that is not a notify service", async () => {
    render(<NotificationsSection />);
    const field = await screen.findByLabelText("Notify Service");
    fireEvent.change(field, { target: { value: "light.kitchen" } });
    fireEvent.blur(field);
    expect(
      await screen.findByText("A notify service looks like notify.mobile_app_my_phone")
    ).toBeInTheDocument();
    expect(na.updateNotifySettings).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: " notify.family " } });
    fireEvent.keyDown(field, { key: "a" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenCalledWith({ service: "notify.family" })
    );
    await waitFor(() => expect(field).toHaveValue("notify.family"));
    // Unchanged: nothing to save. Emptied: cleared.
    vi.mocked(na.updateNotifySettings).mockClear();
    fireEvent.blur(field);
    expect(na.updateNotifySettings).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    await waitFor(() => expect(na.updateNotifySettings).toHaveBeenCalledWith({ service: "" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send a Test" })).toBeDisabled());
  });

  it("sends a test and says so, or says why not", async () => {
    render(<NotificationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Send a Test" }));
    expect(await screen.findByText("Test sent. Check your phone.")).toBeInTheDocument();
    vi.mocked(na.sendTestNotification).mockRejectedValueOnce(
      new Error("Home Assistant did not accept the notification. Check the service name.")
    );
    fireEvent.click(screen.getByRole("button", { name: "Send a Test" }));
    expect(await screen.findByText(/did not accept the notification/)).toBeInTheDocument();
    expect(screen.queryByText("Test sent. Check your phone.")).not.toBeInTheDocument();
    vi.mocked(na.updateNotifySettings).mockRejectedValueOnce("x");
    fireEvent.click(screen.getByRole("switch", { name: /Send Notifications/ }));
    expect(await screen.findByText("Could not save")).toBeInTheDocument();
  });

  it("warns when the last notification could not be sent", async () => {
    vi.mocked(na.getNotifications).mockResolvedValue(data({}, true));
    render(<NotificationsSection />);
    expect(await screen.findByText(/last notification could not be sent/)).toBeInTheDocument();
  });

  it("picks the hour for the daily summary once it is on", async () => {
    render(<NotificationsSection />);
    const hour = await screen.findByLabelText("Send the daily summary at");
    expect(hour).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: /Daily Summary/ }));
    await waitFor(() => expect(hour).toBeEnabled());
    fireEvent.change(hour, { target: { value: "21" } });
    await waitFor(() =>
      expect(na.updateNotifySettings).toHaveBeenLastCalledWith({ summary_hour: 21 })
    );
    expect(na.hourLabel(0)).toBe("12 AM");
    expect(na.hourLabel(7)).toBe("7 AM");
    expect(na.hourLabel(12)).toBe("12 PM");
    expect(na.hourLabel(21)).toBe("9 PM");
  });

  it("keeps a click made while a save is on its way, and sends it next", async () => {
    let finish: (d: na.Notifications) => void = () => {};
    vi.mocked(na.updateNotifySettings).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<NotificationsSection />);
    // Typing the service and then switching notifications on, without waiting.
    const field = await screen.findByLabelText("Notify Service");
    fireEvent.change(field, { target: { value: "notify.family" } });
    fireEvent.blur(field);
    expect(screen.getByLabelText("How Serious")).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: /Send Notifications/ }));
    await waitFor(() => expect(na.updateNotifySettings).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(na.updateNotifySettings).toHaveBeenCalledTimes(1);
    finish(data({ service: "notify.family" }));
    await waitFor(() => expect(na.updateNotifySettings).toHaveBeenCalledTimes(2));
    expect(na.updateNotifySettings).toHaveBeenLastCalledWith({ enabled: false });
    await waitFor(() => expect(screen.getByLabelText("How Serious")).toBeEnabled());
  });

  it("says so when it cannot load, and ignores late responses", async () => {
    vi.mocked(na.getNotifications).mockRejectedValueOnce(new Error("down"));
    const first = render(<NotificationsSection />);
    expect(await screen.findByText("Could not load notifications.")).toBeInTheDocument();
    first.unmount();
    let finish: (d: na.Notifications) => void = () => {};
    vi.mocked(na.getNotifications).mockReturnValueOnce(new Promise((r) => (finish = r)));
    render(<NotificationsSection />).unmount();
    finish(data());
    let fail: (e: Error) => void = () => {};
    vi.mocked(na.getNotifications).mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    render(<NotificationsSection />).unmount();
    fail(new Error("late"));
    await Promise.resolve();
  });
});
