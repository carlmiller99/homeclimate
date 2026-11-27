import { useEntityName } from "../entityNames";

/** An entity by its friendly name, with the entity ID on hover. */
export default function EntityName({ id, className }: { id: string; className?: string }) {
  const name = useEntityName(id);
  return (
    <span className={className} title={id}>
      {name}
    </span>
  );
}
