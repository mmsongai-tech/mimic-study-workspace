import type { ConfirmedStudySpec } from "./design-session.js";
import type { ResearchDesignView } from "./responses.js";

export type ProcessedDesignRequest =
  | {
      operation: "start" | "continue";
      request_id: string;
      request_fingerprint: string;
      result: ResearchDesignView;
    }
  | {
      operation: "confirm";
      request_id: string;
      request_fingerprint: string;
      result: ConfirmedStudySpec;
    };
