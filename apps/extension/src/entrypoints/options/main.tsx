import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "@/lib/theme";
import { initUiI18n } from "@/i18n/ui";
import { i18n } from "@/i18n";
import "./style.css";

initTheme();

void initUiI18n(() => i18n.t("settings.pageTitle")).then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
