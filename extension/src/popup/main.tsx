import { createRoot } from "react-dom/client";
import { App } from "./app";

// The popup's entry (build.mjs bundles it into popup.js, which popup.html loads).
createRoot(document.getElementById("root")!).render(<App />);
