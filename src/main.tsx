import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { installViewportGuards } from "./viewportGuards.ts";

installViewportGuards();

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
