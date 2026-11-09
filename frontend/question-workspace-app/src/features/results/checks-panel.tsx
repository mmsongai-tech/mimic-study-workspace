import { useLang } from "@/hooks/use-lang";
import { Badge } from "@/components/ui/badge";
import { Explain } from "@/components/detail/explain";
import type { ResultQuality } from "@/lib/api-types";

const ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2 };
const VARIANT: Record<string, "destructive" | "warning" | "success"> = { fail: "destructive", warn: "warning", pass: "success" };

export function ChecksPanel({ quality }: { quality: ResultQuality | undefined }) {
  const { t, lang } = useLang();
  if (!quality) return <p className="text-sm text-muted-foreground">–</p>;
  const label: Record<string, string> = { pass: t.checkPass, warn: t.checkWarn, fail: t.checkFail };
  const rows = [...quality.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((check, index) => (
              <tr key={index} className="border-b align-top last:border-0">
                <td className="whitespace-nowrap px-3 py-2">
                  <Badge variant={VARIANT[check.status]}>{label[check.status]}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{check.title[lang]}</div>
                  <div className="text-xs text-muted-foreground">{check.message[lang]}</div>
                  <Explain id={check.check_id} />
                </td>
                <td className="px-3 py-2 text-xs">
                  {check.observed}
                  <div className="text-muted-foreground">{check.expected}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">rules {quality.rules_version}</p>
    </div>
  );
}
