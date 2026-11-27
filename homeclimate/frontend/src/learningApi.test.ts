import { afterEach, describe, expect, it, vi } from "vitest";
import { fitLearning, getHindcast, getLearning, updateLearningSettings } from "./learningApi";

afterEach(() => vi.unstubAllGlobals());

describe("learningApi requests", () => {
  it("calls the Smart Learning endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getLearning();
    await updateLearningSettings({ sample_retention_days: 90 });
    await fitLearning();
    await getHindcast("a room/1");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/learning", "GET", undefined],
      ["/api/learning/settings", "PUT", JSON.stringify({ sample_retention_days: 90 })],
      ["/api/learning/fit", "POST", undefined],
      ["/api/learning/rooms/a%20room%2F1/hindcast", "GET", undefined],
    ]);
  });
});
