import type { Connector } from "./types";
import { referenceConnector } from "./connectors/reference";

// Connector registry. Adding a provider is a single `registerConnector` call:
// no schema change, no new table, no change to the sync engine.
const registered = new Map<string, Connector>();

export function registerConnector(connector: Connector): void {
  if (!connector.id || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(connector.id)) {
    throw new Error("A connector id must be lowercase kebab-case (2-49 characters).");
  }
  registered.set(connector.id, connector);
}

export function getConnector(id: string): Connector {
  const connector = registered.get(id);
  if (!connector) throw new Error(`Unknown integration provider "${id}".`);
  return connector;
}

export function hasConnector(id: string): boolean {
  return registered.has(id);
}

export function listConnectors(): Connector[] {
  return [...registered.values()].sort((a, b) => a.label.localeCompare(b.label));
}

registerConnector(referenceConnector);
