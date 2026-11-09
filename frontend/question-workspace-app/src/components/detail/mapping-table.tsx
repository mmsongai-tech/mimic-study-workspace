import { useLang } from "@/hooks/use-lang";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDefineVariable } from "@/features/variables/define-context";
import type { MappingSummaryVariable } from "@/lib/api-types";

export function MappingTable({ mapping }: { mapping: MappingSummaryVariable[] | undefined }) {
  const { t, lang } = useLang();
  const define = useDefineVariable();
  if (!mapping?.length) return null;
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-semibold">{t.variables}</h5>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">{t.role}</th>
              <th className="px-3 py-2 font-medium">{t.variable}</th>
              <th className="px-3 py-2 font-medium">{t.source}</th>
            </tr>
          </thead>
          <tbody>
            {mapping.map((variable, index) => (
              <tr key={index} className="border-t align-top">
                {/* A description's characteristic is mapped with an outcome's or covariate's rules but is only described. */}
                <td className="px-3 py-2">{variable.characteristic ? "characteristic" : variable.role}</td>
                <td className="px-3 py-2">
                  {variable.requested_term}
                  {variable.status !== "resolved" && variable.reason && <div className="mt-1 text-xs font-normal text-muted-foreground">{variable.reason}</div>}
                  {variable.status !== "resolved" && (
                    <Badge variant="destructive" className="ml-1.5 align-middle">
                      {variable.status}
                    </Badge>
                  )}
                  {variable.status !== "resolved" && define && (
                    <Button variant="outline" size="sm" className="ml-2 h-6 px-2 text-xs" onClick={() => define(variable.requested_term)}>{lang === "zh" ? "定义这个变量" : "Define this variable"}</Button>
                  )}
                </td>
                <td className="px-3 py-2">
                  {variable.selected ? `${variable.selected.label} (${variable.selected.table})` : variable.candidates.map((c) => `${c.label}?`).join("; ") || "–"}
                  {!!variable.selected?.values?.length && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        {/* The summary keeps at most 60 values; `identifiers` counts every code, item id and label actually used. */}
                        {t.codesUsed} ({Math.max(variable.selected.values.length, variable.selected.identifiers)})
                      </summary>
                      <div className="mt-1 text-xs text-muted-foreground">{variable.selected.values.join(", ")}{variable.selected.identifiers > variable.selected.values.length ? ", …" : ""}</div>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
