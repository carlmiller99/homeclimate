import { afterEach, describe, expect, it, vi } from "vitest";
import { getPeakHours, updatePeakHours } from "./peakApi";

afterEach(() => vi.unstubAllGlobals());

describe("peakApi requests", () => {
  it("calls the Peak Hours endpoints, sending the depth as given", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getPeakHours();
    await updatePeakHours({ peak_depth: 1.5 });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/peak-hours", "GET", undefined],
      ["/api/peak-hours", "PUT", JSON.stringify({ peak_depth: 1.5 })],
    ]);
  });
});
