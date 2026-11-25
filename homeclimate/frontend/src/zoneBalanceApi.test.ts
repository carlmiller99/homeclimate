import { afterEach, describe, expect, it, vi } from "vitest";
import { getZoneBalance, setZoneBalance } from "./zoneBalanceApi";

afterEach(() => vi.unstubAllGlobals());

describe("zoneBalanceApi requests", () => {
  it("calls the Zone Balance endpoints, sending the gap as given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getZoneBalance();
    await setZoneBalance("b 1", { level: "on", zone_gap: 2.5 });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/zone-balance", "GET", undefined],
      ["/api/zone-balance/b%201", "PUT", JSON.stringify({ level: "on", zone_gap: 2.5 })],
    ]);
  });
});
