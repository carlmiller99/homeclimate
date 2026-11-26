import { afterEach, describe, expect, it, vi } from "vitest";
import { getToday } from "./todayApi";

afterEach(() => vi.unstubAllGlobals());

describe("todayApi requests", () => {
  it("asks for today's plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hours: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getToday()).toEqual({ hours: [] });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET"])).toEqual([
      ["/api/today", "GET"],
    ]);
  });
});
