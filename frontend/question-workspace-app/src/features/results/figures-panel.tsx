import { api } from "@/lib/api";
import { Explain } from "@/components/detail/explain";
import type { StudyMethodResult } from "@/lib/api-types";

export function FiguresPanel({ runId, run }: { runId: string; run: StudyMethodResult | undefined }) {
  if (!run?.figures.length) return <p className="text-sm text-muted-foreground">–</p>;
  return (
    <div className="space-y-2">
    <Explain id="figures" />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {run.figures.map((figure, index) => (
        <figure key={index} className="rounded-md border p-2">
          <img loading="lazy" src={api.figureUrl(runId, run.output_dir, figure.file)} alt={figure.title} className="w-full rounded" />
          <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">{figure.title}</figcaption>
          <div className="flex justify-center"><Explain id={figure.file} /></div>
        </figure>
      ))}
    </div>
    </div>
  );
}
