import type { Metadata } from "next";
import { ConnectView } from "@/components/extension/connect-view";

export const metadata: Metadata = { title: "Connect the extension" };

/**
 * Where the extension's popup sends you to connect it (docs/plan/4-chrome-extension.md, "Connect
 * flow"). Outside the sidebar layout, like /login. Signed out, src/proxy.ts sends the browser to
 * /login?next=/extension/connect first. Everything happens in the browser: the page reads no data
 * on the server.
 */
export default function ExtensionConnectPage() {
  return <ConnectView />;
}
