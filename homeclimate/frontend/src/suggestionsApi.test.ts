import { afterEach, describe, expect, it, vi } from "vitest";
import { getSuggestions } from "./suggestionsApi";

afterEach(() => vi.unstubAllGlobals());

describe("suggestionsApi requests", () => {
  it("asks for the suggestions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getSuggestions();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/learning/suggestions");
  });
});
