import { afterEach, describe, expect, it, vi } from "vitest";
import { getNotifications, sendTestNotification, updateNotifySettings } from "./notifyApi";

afterEach(() => vi.unstubAllGlobals());

describe("notifyApi requests", () => {
  it("calls the notification endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getNotifications();
    await updateNotifySettings({ enabled: true });
    await sendTestNotification();
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/notifications", "GET", undefined],
      ["/api/notifications/settings", "PUT", JSON.stringify({ enabled: true })],
      ["/api/notifications/test", "POST", undefined],
    ]);
  });
});
