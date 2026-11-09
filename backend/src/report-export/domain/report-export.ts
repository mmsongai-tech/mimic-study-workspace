export type ReportExportFormat = "docx" | "pdf";
export type ReportExportLanguage = "en" | "zh";

export interface ReportExport {
  filename: string;
  content_type: string;
  content: Buffer;
}

export class ReportExportError extends Error {
  constructor(
    public readonly code: "REPORT_NOT_FOUND" | "REPORT_EXPORT_INVALID" | "REPORT_EXPORT_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ReportExportError";
  }
}
