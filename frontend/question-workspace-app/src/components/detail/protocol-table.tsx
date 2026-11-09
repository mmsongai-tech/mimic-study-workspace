import { useLang } from "@/hooks/use-lang";
import type { StudyProtocol } from "@/lib/api-types";

export function ProtocolTable({ protocol }: { protocol: StudyProtocol | undefined }) {
  const { t, lang } = useLang();
  if (!protocol) return null;
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-semibold">{t.trial}</h5>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <tbody>
            {protocol.elements.map((element) => (
              <tr key={element.key} className="border-b last:border-0">
                <th className="w-40 whitespace-nowrap bg-muted/40 px-3 py-2 text-left align-top font-medium">{element.label[lang]}</th>
                <td className="px-3 py-2">{lang === "zh" && element.emulation_zh ? element.emulation_zh : element.emulation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
