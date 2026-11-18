import { readConnection, readLastOrigin, type Connection } from "../lib/storage";
import { trackerOriginOf, type TargetTab } from "../lib/tab";

/*
 * Where the popup starts: connected, or the Connect screen with an address filled in. The one
 * connected last comes first; only without one is the open tab's offered, when the tab looks like
 * the tracker. Any site can carry the tracker's <meta name="job-tracker" content="app">, so it
 * must never replace an address this browser already used.
 */

export type View =
  | { name: "starting" }
  | { name: "connect"; suggested: string; notice: string | null }
  | { name: "connected"; connection: Connection };

export async function startView(tab: TargetTab | null, notice: string | null): Promise<View> {
  const connection = await readConnection();
  if (connection) return { name: "connected", connection };
  const suggested = (await readLastOrigin()) ?? (tab && (await trackerOriginOf(tab))) ?? "";
  return { name: "connect", suggested, notice };
}
