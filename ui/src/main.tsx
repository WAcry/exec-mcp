import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ThemeProvider, applyStoredTheme } from "./context/ThemeContext";
import { AuthProvider } from "./context/AuthContext";
import { LocaleProvider } from "./context/LocaleContext";
import "./index.css";

applyStoredTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <ThemeProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ThemeProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
