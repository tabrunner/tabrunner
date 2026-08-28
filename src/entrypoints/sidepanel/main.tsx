import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "@/lib/theme";
import { initUiI18n } from "@/i18n/ui";
import { mark } from "./boot";
import "./style.css";

// Every chunk is fetched, parsed and evaluated by the time this line runs —
// performance.now() is measured from navigation start, so it is that whole cost.
mark("eval");

initTheme();

void initUiI18n().then(() => {
  mark("i18n");
  createRoot(document.getElementById("root")!).render(<App />);
});
