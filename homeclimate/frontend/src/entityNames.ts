import { useEffect, useSyncExternalStore } from "react";
import { getEntityStates } from "./api";

/**
 * What Home Assistant calls each entity. Sensors and devices are shown by
 * that name everywhere; the entity ID is only ever a hover away.
 */
const names = new Map<string, string>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let queue: string[] = [];
let retried = false;
const RETRY_MS = 5000;

/** "sensor.front_yard_temp" as "Front Yard Temp", when Home Assistant gives no name. */
export function prettyEntity(id: string): string {
  return id
    .slice(id.lastIndexOf(".") + 1)
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

async function flush() {
  const ids = queue;
  queue = [];
  try {
    const states = (await getEntityStates(ids)) ?? {};
    for (const [id, st] of Object.entries(states)) {
      const name = st?.attributes?.friendly_name;
      if (typeof name === "string" && name) names.set(id, name);
    }
    // One Home Assistant had nothing for yet may be asked for again.
    ids.filter((id) => !states[id]).forEach((id) => asked.delete(id));
    listeners.forEach((l) => l());
  } catch {
    // The entity ID, tidied, stands in. Asked again once, shortly, for what
    // is already on screen; anything shown later asks for itself.
    ids.forEach((id) => asked.delete(id));
    if (!retried) {
      retried = true;
      setTimeout(() => ids.forEach(ask), RETRY_MS);
    }
  }
}

function ask(id: string) {
  if (!id || asked.has(id)) return;
  asked.add(id);
  // Every name wanted in one render goes in one request.
  if (queue.push(id) === 1) queueMicrotask(() => void flush());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The friendly name of an entity, or its ID tidied up until that is known. */
export function useEntityName(id: string): string {
  const known = useSyncExternalStore(subscribe, () => names.get(id));
  useEffect(() => ask(id), [id]);
  return known ?? prettyEntity(id);
}

/** Names already known, for text built outside a component's render. */
export function entityName(id: string): string {
  return names.get(id) ?? prettyEntity(id);
}

/** For tests: forget every name. */
export function forgetEntityNames() {
  names.clear();
  asked.clear();
  queue = [];
  retried = false;
}
