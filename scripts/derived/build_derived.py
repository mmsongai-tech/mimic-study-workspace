#!/usr/bin/env python3
"""Builds the derived-variable layer from the raw MIMIC-IV archive (once per machine; a few minutes to an hour).

Output folder: derived_events.csv.gz (the events), derived_items.csv (what each derived item id means) and
mimic-iv-<version>-derived.zip (the two files in the layout the platform reads next to the archive). MIMIC-derived: keep it
with the archive and share it only with credentialed people.

  python3 scripts/derived/build_derived.py --archive ~/Desktop/mimic-iv-3.1.zip --out .local/derived [--only kidney,stay]
"""
import argparse, csv, json, os, sys, time, zipfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd
import common

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PACK = os.path.join(ROOT, "config", "mappings", "mimic-iv-core.json")
ORDER = os.path.join(ROOT, "config", "derived", "diagnosis-order.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True); parser.add_argument("--out", required=True); parser.add_argument("--only")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else None
    frames, items, summaries = [], {}, {}
    import icu, kidney, stay
    families = {"kidney": lambda: kidney.build(args.archive, None), "stay": lambda: stay.build(args.archive, None, PACK), "icu": lambda: icu.build(args.archive, None)}
    for name, run in families.items():
        if only and name not in only: continue
        started = time.time(); frame, summary, family_items = run()
        frames.append(frame); summaries[name] = summary; items.update(family_items)
        print(f"{name}: {len(frame):,} events in {time.time() - started:.0f}s {json.dumps(summary)[:400]}", flush=True)
    events = pd.concat(frames, ignore_index=True)
    os.makedirs(args.out, exist_ok=True)
    path = common.write_events(events, args.out)
    with open(os.path.join(args.out, "derived_items.csv"), "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle); writer.writerow(["itemid", "key", "label", "unit", "definition"])
        for key, (itemid, label, unit, definition) in sorted(items.items(), key=lambda item: item[1][0]): writer.writerow([itemid, key, label, unit, definition])
    version = os.path.basename(args.archive).replace(".zip", "")
    layer = {"diagnosis_fingerprint": common.diagnosis_fingerprint(PACK, ORDER), "items": sorted(int(value) for value in events["itemid"].unique()), "pack_version": json.load(open(PACK, encoding="utf-8"))["pack_version"], "built_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    json.dump(layer, open(os.path.join(args.out, "layer.json"), "w"), indent=1)
    with zipfile.ZipFile(os.path.join(args.out, f"{version}-derived.zip"), "w", zipfile.ZIP_STORED) as archive:
        archive.write(path, "derived/derived_events.csv.gz")
        archive.write(os.path.join(args.out, "derived_items.csv"), "derived/derived_items.csv")
        archive.write(os.path.join(args.out, "layer.json"), "derived/layer.json")
    json.dump(summaries, open(os.path.join(args.out, "build_summary.json"), "w"), indent=1)
    print("written", args.out, f"{len(events):,} events")


if __name__ == "__main__":
    main()
