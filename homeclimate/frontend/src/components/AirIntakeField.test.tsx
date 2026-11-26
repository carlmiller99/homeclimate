import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AirIntakeField from "./AirIntakeField";
import * as fanApi from "../fanApi";
import { buildUnitContext, UnitContext } from "../contexts";

vi.mock("../fanApi", async (orig) => ({
  ...(await orig<typeof import("../fanApi")>()),
  getFan: vi.fn(),
  testFan: vi.fn(),
}));

const UP: fanApi.FanZone = {
  thermostat_entity_id: "climate.up",
  name: "Upstairs",
  level: "off",
  air_intake: "unsure",
  supported: true,
  running: false,
  testing: false,
  note: "",
  minutes_last_hour: 0,
  test: null,
};
const fan = (...zones: fanApi.FanZone[]): fanApi.Fan => ({ zones, test_minutes: 10 });
const TEST = "Test Upstairs for an outside air intake";

function show(onChange = vi.fn(), unit: "F" | "C" = "F") {
  render(
    <UnitContext.Provider value={buildUnitContext(unit)}>
      <AirIntakeField
        entityId="climate.up"
        zoneName="Upstairs"
        value="unsure"
        onChange={onChange}
      />
    </UnitContext.Provider>
  );
  return onChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fanApi.getFan).mockResolvedValue(fan(UP));
});
afterEach(() => vi.useRealTimers());

describe("Outside air intake", () => {
  it("offers the three answers and hands the choice to the zone's form", async () => {
    const onChange = show();
    const select = screen.getByLabelText("Outside air intake for Upstairs");
    expect(select).toHaveValue("unsure");
    expect(screen.getByText(/Not Sure is treated as No/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "yes" } });
    expect(onChange).toHaveBeenCalledWith("yes");
    expect(await screen.findByText("Not tested yet.")).toBeInTheDocument();
    expect(screen.getByText(/It gives a hint, not an answer/)).toBeInTheDocument();
  });

  it("runs the test, waits for it, and shows the hint in the house's unit", async () => {
    vi.useFakeTimers();
    vi.mocked(fanApi.testFan).mockResolvedValue(fan({ ...UP, testing: true }));
    show(vi.fn(), "C");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    vi.mocked(fanApi.getFan).mockResolvedValue(fan({ ...UP, testing: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: TEST }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fanApi.testFan).toHaveBeenCalledWith("climate.up");
    expect(screen.getByRole("button", { name: TEST })).toBeDisabled();
    expect(screen.getByRole("button", { name: TEST })).toHaveTextContent("Testing…");
    expect(screen.getByText(/Running the fan alone for 10 minutes/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    // It looks again while the test runs, and shows the result when it is done.
    vi.mocked(fanApi.getFan).mockResolvedValue(
      fan({
        ...UP,
        test: {
          at: "2026-01-05T18:10:00+00:00",
          interrupted: false,
          difference: 27,
          moved: 0.9,
          hint: "possible",
        },
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      /With inside and outside 15°C apart, the rooms moved 0.5°C toward the outside temperature\. That could be/
    );
    expect(screen.getByRole("button", { name: TEST })).toBeEnabled();
  });

  it("says why a test could not start", async () => {
    show();
    const button = await screen.findByRole("button", { name: TEST });
    vi.mocked(fanApi.testFan).mockRejectedValueOnce(new Error("Inside and outside are too close"));
    fireEvent.click(button);
    expect(await screen.findByText("Inside and outside are too close")).toBeInTheDocument();
    vi.mocked(fanApi.testFan).mockRejectedValueOnce("x");
    fireEvent.click(button);
    expect(await screen.findByText("Could not start the test")).toBeInTheDocument();
  });

  it("cannot test a thermostat with no fan setting, or a zone it cannot find", async () => {
    vi.mocked(fanApi.getFan).mockResolvedValueOnce(fan({ ...UP, supported: false }));
    const { unmount } = render(
      <AirIntakeField entityId="climate.up" zoneName="Upstairs" value="no" onChange={vi.fn()} />
    );
    expect(await screen.findByText(/so it cannot be tested/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: TEST })).toBeDisabled();
    unmount();
    // A zone with no rooms yet has no fan state: the setting is still there.
    vi.mocked(fanApi.getFan).mockResolvedValueOnce(fan());
    const second = render(
      <AirIntakeField entityId="climate.up" zoneName="Upstairs" value="no" onChange={vi.fn()} />
    );
    await waitFor(() => expect(fanApi.getFan).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Outside air intake for Upstairs")).toHaveValue("no");
    expect(screen.queryByRole("button", { name: TEST })).toBeNull();
    second.unmount();
    // Nor does a failed load take the setting away, or a late answer land.
    let fail: (e: Error) => void = () => {};
    vi.mocked(fanApi.getFan).mockReturnValueOnce(new Promise((_r, j) => (fail = j)));
    const third = render(
      <AirIntakeField entityId="climate.up" zoneName="Upstairs" value="no" onChange={vi.fn()} />
    );
    expect(screen.getByLabelText("Outside air intake for Upstairs")).toBeInTheDocument();
    let late: (f: fanApi.Fan) => void = () => {};
    vi.mocked(fanApi.getFan).mockReturnValueOnce(new Promise((r) => (late = r)));
    third.unmount();
    fail(new Error("down"));
    const fourth = render(
      <AirIntakeField entityId="climate.up" zoneName="Upstairs" value="no" onChange={vi.fn()} />
    );
    fourth.unmount();
    late(fan(UP));
    await Promise.resolve();
  });
});
