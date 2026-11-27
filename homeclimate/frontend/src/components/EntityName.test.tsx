import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import EntityName, {
  entityName,
  forgetEntityNames,
  prettyEntity,
  useEntityName,
} from "./EntityName";
import * as api from "../api";

vi.mock("../api");

const state = (name: unknown) =>
  ({ attributes: { friendly_name: name } }) as unknown as api.EntityState;

function Sentence({ id }: { id: string }) {
  return <p>{`${useEntityName(id)} is not reporting`}</p>;
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetEntityNames();
});

describe("Friendly names for entities", () => {
  it("shows what Home Assistant calls it, with the entity ID on hover only", async () => {
    vi.mocked(api.getEntityStates).mockResolvedValue({
      "sensor.porch_temp": state("Front Porch"),
      "sensor.no_name": state(""),
      "sensor.gone": null,
    });
    render(
      <>
        <EntityName id="sensor.porch_temp" className="x" />
        <EntityName id="sensor.no_name" />
        <EntityName id="sensor.gone" />
        <EntityName id="sensor.porch_temp" />
        <Sentence id="sensor.porch_temp" />
        <EntityName id="" />
      </>
    );
    // Until the name is known, the ID tidied up stands in.
    expect(screen.getAllByText("Porch Temp")).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText("Front Porch")).toHaveLength(2));
    expect(screen.getAllByText("Front Porch")[0]).toHaveAttribute("title", "sensor.porch_temp");
    expect(screen.getAllByText("Front Porch")[0]).toHaveClass("x");
    expect(screen.getByText("Front Porch is not reporting")).toBeInTheDocument();
    expect(screen.getByText("No Name")).toBeInTheDocument();
    expect(screen.getByText("Gone")).toBeInTheDocument();
    expect(screen.queryByText(/sensor\./)).not.toBeInTheDocument();
    // Every name wanted at once is asked for together, and only once.
    expect(api.getEntityStates).toHaveBeenCalledTimes(1);
    expect(api.getEntityStates).toHaveBeenCalledWith([
      "sensor.porch_temp",
      "sensor.no_name",
      "sensor.gone",
    ]);
    expect(entityName("sensor.porch_temp")).toBe("Front Porch");
    expect(entityName("sensor.other_one")).toBe("Other One");
  });

  it("stands the tidied ID in when names cannot be read, and asks again later", async () => {
    vi.mocked(api.getEntityStates).mockRejectedValueOnce(new Error("down"));
    const first = render(<EntityName id="climate.north_wing" />);
    expect(screen.getByText("North Wing")).toBeInTheDocument();
    await waitFor(() => expect(api.getEntityStates).toHaveBeenCalledTimes(1));
    first.unmount();
    vi.mocked(api.getEntityStates).mockResolvedValue({ "climate.north_wing": state("Hallway") });
    render(<EntityName id="climate.north_wing" />);
    expect(await screen.findByText("Hallway")).toBeInTheDocument();
  });

  it("tidies an ID with no dot, doubled underscores or nothing in it", () => {
    expect(prettyEntity("front__yard_")).toBe("Front Yard");
    expect(prettyEntity("")).toBe("");
  });
});
