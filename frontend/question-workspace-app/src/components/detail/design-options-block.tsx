import { useLang } from "@/hooks/use-lang";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ChipCheckbox } from "@/components/ui/chip-checkbox";
import type { DesignOptions, TimeChoice } from "@/lib/api-types";

/** Landmark and severity-adjustment pickers — shown both when first confirming a plan and, unchanged, when
 * choosing new design options for a re-analysis. */
export function DesignOptionsBlock({
  frameId,
  options,
  landmarkOn,
  severityOn,
  onSetLandmark,
  onSetSeverity,
  time,
  onSetTime,
}: {
  frameId: string;
  options: DesignOptions;
  landmarkOn: boolean | undefined;
  severityOn: string[];
  onSetLandmark: (frameId: string, on: boolean) => void;
  onSetSeverity: (frameId: string, names: string[]) => void;
  time?: TimeChoice | undefined;
  onSetTime?: (frameId: string, patch: TimeChoice) => void;
}) {
  const { t } = useLang();
  const severityName = (value: string) => t.severityNames[value] || value;

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.designOptions}</div>

      {options.time && onSetTime && (
        <div className="space-y-2">
          <span className="text-sm font-medium">{t.timeTitle}</span>
          {([
            ["exposure", options.time.exposure, time?.exposure_hours, "exposure_hours", t.timeExposure, t.timeExposureWhy],
            ["follow_up_end", options.time.follow_up_end, time?.follow_up_end_hours, "follow_up_end_hours", t.timeFollowUp, t.timeFollowUpWhy],
            ["outcome_horizon", options.time.outcome_horizon, time?.outcome_horizon_hours, "outcome_horizon_hours", t.timeHorizon, t.timeHorizonWhy],
          ] as const).map(([name, offer, chosen, field, label, why]) => offer && (
            <div key={name} className="space-y-1">
              <span className="text-xs text-muted-foreground">{label}</span>
              <SegmentedControl
                name={`time-${name}-${frameId}`}
                value={String(chosen ?? offer.default_hours)}
                onChange={(value) => onSetTime(frameId, { [field]: Number(value) })}
                options={offer.choices.map((hours) => ({ value: String(hours), label: t.hoursOption(hours, offer.default_hours) }))}
              />
              <p className="text-xs text-muted-foreground">{why(chosen ?? offer.default_hours)}</p>
            </div>
          ))}
        </div>
      )}

      {options.landmark && (
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t.followUpStart}</span>
          <SegmentedControl
            name={`landmark-${frameId}`}
            value={landmarkOn ? "on" : "off"}
            onChange={(value) => onSetLandmark(frameId, value === "on")}
            options={[
              { value: "on", label: t.landmarkOn(options.landmark.hours) },
              { value: "off", label: t.landmarkOff },
            ]}
          />
          <p className="text-xs text-muted-foreground">{t.landmarkWhy(options.landmark.hours)}</p>
        </div>
      )}

      {!!options.severity?.names.length && (
        <div className="space-y-1.5">
          <span className="text-sm font-medium">{t.severity}</span>
          <div className="flex flex-wrap gap-1.5">
            {options.severity.names.map((value) => (
              <ChipCheckbox
                key={value}
                checked={severityOn.includes(value)}
                onChange={(checked) => onSetSeverity(frameId, checked ? [...severityOn, value] : severityOn.filter((v) => v !== value))}
              >
                {severityName(value)}
              </ChipCheckbox>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t.severityWhy}</p>
        </div>
      )}
    </div>
  );
}
