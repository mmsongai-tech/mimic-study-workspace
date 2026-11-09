import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { LangProvider } from "@/hooks/use-lang";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import { AccessGate } from "@/features/access/access-gate";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LangProvider>
        <TooltipProvider delayDuration={200}>
          <AccessGate>
            <App />
          </AccessGate>
        </TooltipProvider>
      </LangProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
