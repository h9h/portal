import { createRoot } from "react-dom/client";
import { App } from "./shell-entry";

const container = document.getElementById("portal-root");
if (container) createRoot(container).render(<App />);
