import { prettyEntity } from "../entityNames";
import { useEffect, useRef, useState } from "react";
import { getHAEntities, type HAEntity, type RoomDeviceKind } from "../api";

interface Props {
  domain: string | string[];
  placeholder?: string;
  hasAttribute?: string;
  excludeIcon?: string;
  /** Only entities of this kind of room device (a temperature sensor, a vent…). */
  kind?: RoomDeviceKind;
  /** A room name: entities in the Home Assistant area of that name are listed first. */
  room?: string;
  onSelect: (entityId: string) => void;
}

/** Where a device is, said the way the room's own list would say it. */
function placeOf(e: HAEntity): string {
  if (e.in_room_area) return "In This Room";
  if (e.named_for_room) return "Named for This Room";
  return e.area_name ?? "";
}

export default function EntityPicker({
  domain,
  placeholder,
  hasAttribute,
  excludeIcon,
  kind,
  room,
  onSelect,
}: Props) {
  const [query, setQuery] = useState("");
  const [entities, setEntities] = useState<HAEntity[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The backend returns the room's own area first; that order is kept below.
    getHAEntities(domain, { hasAttribute, excludeIcon, kind, room })
      .then(setEntities)
      .catch(() => {});
  }, [domain, hasAttribute, excludeIcon, kind, room]);

  const needle = query.toLowerCase();
  const filtered = entities
    .filter(
      (e) =>
        e.entity_id.toLowerCase().includes(needle) ||
        e.friendly_name.toLowerCase().includes(needle) ||
        (e.area_name ?? "").toLowerCase().includes(needle)
    )
    .slice(0, 30);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="entity-picker" ref={ref}>
      <input
        className="form-control"
        placeholder={
          placeholder ?? `Search ${Array.isArray(domain) ? domain.join(" / ") : domain} entities…`
        }
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && filtered.length > 0 && (
        <div className="entity-dropdown">
          {filtered.map((e) => (
            <div
              key={e.entity_id}
              className="entity-option"
              onMouseDown={() => {
                onSelect(e.entity_id);
                setQuery("");
                setOpen(false);
              }}
            >
              <div title={e.entity_id}>{e.friendly_name || prettyEntity(e.entity_id)}</div>
              {(e.area_name || e.named_for_room) && <div className="entity-id">{placeOf(e)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
