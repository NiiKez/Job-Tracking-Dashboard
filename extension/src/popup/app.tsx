import { useCallback, useEffect, useState } from "react";
import { findTargetTab, type TargetTab } from "../lib/tab";
import { ConnectScreen } from "./connect-screen";
import { Connected } from "./connected";
import { startView, type View } from "./start";
import { AnnounceContext, ScreenHeader } from "./ui";

/*
 * The popup (docs/plan/4-chrome-extension.md, Popup): the Connect screen when this browser has
 * no connection, else the page read into a form. The target tab is found once, when the popup
 * opens.
 */

export function App() {
  const [tab, setTab] = useState<TargetTab | null>(null);
  const [view, setView] = useState<View>({ name: "starting" });
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    void (async () => {
      const found = await findTargetTab(location.search);
      const first = await startView(found, null);
      setTab(found);
      setView(first);
    })();
  }, []);

  const showStart = useCallback(
    (notice: string | null) => void startView(tab, notice).then(setView),
    [tab],
  );
  const onConnected = useCallback(() => showStart(null), [showStart]);

  return (
    <AnnounceContext value={setAnnouncement}>
      {view.name === "starting" && <ScreenHeader />}
      {view.name === "connect" && (
        <ConnectScreen suggested={view.suggested} notice={view.notice} onConnected={onConnected} />
      )}
      {view.name === "connected" && (
        <Connected key={view.connection.token} connection={view.connection} tab={tab} onDisconnected={showStart} />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </AnnounceContext>
  );
}
