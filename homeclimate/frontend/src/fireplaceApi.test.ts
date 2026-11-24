import { afterEach, describe, expect, it, vi } from "vitest";
import { addFireplace, deleteFireplace, getFireplaces, saveFireplace } from "./fireplaceApi";

afterEach(() => vi.unstubAllGlobals());

describe("fireplaceApi", () => {
  it("calls the fireplace endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getFireplaces();
    await addFireplace({ name: "Hearth" });
    await saveFireplace("f 1", { control: "on" });
    await deleteFireplace("f 1");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", i?.body])).toEqual([
      ["/api/fireplaces", "GET", undefined],
      ["/api/fireplaces", "POST", JSON.stringify({ name: "Hearth" })],
      ["/api/fireplaces/f%201", "PUT", JSON.stringify({ control: "on" })],
      ["/api/fireplaces/f%201", "DELETE", undefined],
    ]);
  });
});
