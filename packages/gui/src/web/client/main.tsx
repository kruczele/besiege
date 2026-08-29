import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../renderer/src/App.js";
import { webApi } from "./api.js";
import "../../renderer/src/App.css";

window.api = webApi;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App chrome={false} />
  </StrictMode>,
);
