import { Explain } from "@/components/detail/explain";
import type { StudyMethodResult } from "@/lib/api-types";

export function Table1Panel({ run }: { run: StudyMethodResult | undefined }) {
  const rows = run?.tables.table1 || [];
  if (!rows.length) return <p className="text-sm text-muted-foreground">–</p>;
  const keys = Object.keys(rows[0]);
  return (
    <div className="space-y-2">
    <Explain id="baseline_table" />
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left">
          <tr>
            {keys.map((key) => (
              <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">{key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t">
              {keys.map((key) => (
                <td key={key} className="whitespace-nowrap px-3 py-2">{String(row[key] ?? "–")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
