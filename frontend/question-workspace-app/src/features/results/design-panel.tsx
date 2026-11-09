import { useLang } from "@/hooks/use-lang";
import { formatNumber, formatPValue } from "@/lib/utils";
import { pickPair } from "@/lib/domain";
import { MEASURE } from "@/lib/i18n";
import { ProtocolTable } from "@/components/detail/protocol-table";
import { Explain } from "@/components/detail/explain";
import { MappingTable } from "@/components/detail/mapping-table";
import { AssumptionsList } from "@/components/detail/assumptions-list";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DesignOptionsBlock } from "@/components/detail/design-options-block";
import type { DesignOptions, PlanOptionChoice, PlanOutcome } from "@/lib/api-types";

export function DesignPanel({
  plan,
  selectedMethod,
  onChangeMethod,
  designOptions,
  optionChoice,
  onSetOption,
}: {
  plan: PlanOutcome;
  selectedMethod: string;
  onChangeMethod: (methodId: string) => void;
  designOptions?: DesignOptions;
  optionChoice?: PlanOptionChoice;
  onSetOption: (patch: Partial<PlanOptionChoice>) => void;
}) {
  const { t, lang } = useLang();
  const run = plan.result;
  const options = plan.method_options || [];

  return (
    <div className="space-y-4">
      <Explain id="design_variables" />
      <ProtocolTable protocol={plan.protocol} />

      {run && (
        <div className="space-y-2">
          <h5 className="text-sm font-semibold">{t.estimates}</h5>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium"></th>
                  <th className="px-3 py-2 font-medium">{t.measure}</th>
                  <th className="px-3 py-2 font-medium">{t.value}</th>
                  <th className="px-3 py-2 font-medium">{t.ci}</th>
                  <th className="px-3 py-2 font-medium">{t.p}</th>
                </tr>
              </thead>
              <tbody>
                {run.estimates.map((row, index) => (
                  <tr key={index} className="border-t">
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2">{pickPair(lang, MEASURE[row.measure]) || row.measure}</td>
                    <td className="px-3 py-2">{formatNumber(row.estimate)}</td>
                    <td className="px-3 py-2">{row.ci_low !== null ? `${formatNumber(row.ci_low)}–${formatNumber(row.ci_high)}` : "–"}</td>
                    <td className="px-3 py-2">{formatPValue(row.p_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!!run?.warnings?.length && (
        <div className="space-y-2">
          <h5 className="text-sm font-semibold">{t.cautions}</h5>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <MappingTable mapping={plan.mapping} />
      <AssumptionsList assumptions={plan.study_spec.assumptions} />

      {options.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-sm font-semibold">{t.changeMethod}</h5>
          <SegmentedControl
            name={`re-${plan.plan_id}`}
            value={selectedMethod}
            onChange={onChangeMethod}
            options={options.map((o) => ({ value: o.method_id, label: o.label[lang], disabled: o.readiness?.available === false }))}
          />
        </div>
      )}

      {designOptions && (
        <div className="space-y-2">
          <h5 className="text-sm font-semibold">{t.changeDesign}</h5>
          <DesignOptionsBlock
            frameId={plan.plan_id}
            options={designOptions}
            landmarkOn={optionChoice?.landmark ?? designOptions.landmark?.default}
            severityOn={optionChoice?.severity_on ?? designOptions.severity?.default_on ?? []}
            onSetLandmark={(_frameId, on) => onSetOption({ landmark: on })}
            onSetSeverity={(_frameId, names) => onSetOption({ severity_on: names })}
            time={optionChoice?.time}
            onSetTime={(_frameId, patch) => onSetOption({ time: { ...optionChoice?.time, ...patch } })}
          />
        </div>
      )}
    </div>
  );
}
