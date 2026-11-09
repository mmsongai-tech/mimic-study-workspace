import { useLang } from "@/hooks/use-lang";

export function AssumptionsList({ assumptions }: { assumptions: string[] | undefined }) {
  const { t } = useLang();
  if (!assumptions?.length) return null;
  return (
    <div className="space-y-2">
      <h5 className="text-sm font-semibold">{t.assumptions}</h5>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {assumptions.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
