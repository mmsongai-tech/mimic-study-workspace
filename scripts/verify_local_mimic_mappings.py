#!/usr/bin/env python3
"""Verify versioned mapping sources against a local MIMIC-IV archive without reading patient rows."""
import argparse, csv, gzip, hashlib, json, zipfile
from datetime import datetime, timezone

def member(archive, suffix):
    matches = [name for name in archive.namelist() if name.endswith(suffix)]
    return matches[0] if len(matches) == 1 else None

def header(archive, name):
    with archive.open(name) as compressed, gzip.open(compressed, "rt", newline="", encoding="utf-8") as stream:
        return next(csv.reader(stream))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("--mapping-pack", default="config/mappings/mimic-iv-core.json")
    parser.add_argument("--output", default=".local/mimic-iv-mapping-verification.json")
    args = parser.parse_args()
    pack = json.load(open(args.mapping_pack, encoding="utf-8"))
    digest = hashlib.sha256()
    with open(args.archive, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""): digest.update(chunk)
    with zipfile.ZipFile(args.archive) as archive:
        results = []
        for mapping in pack["mappings"]:
            missing = []
            checked = []
            for source in mapping["sources"]:
                relation = member(archive, f"/{source['schema'].replace('mimiciv_', '')}/{source['table']}.csv.gz")
                if not relation:
                    missing.append(f"{source['schema']}.{source['table']}"); continue
                columns = set(header(archive, relation)); checked.append(relation)
                missing.extend(f"{source['schema']}.{source['table']}.{column}" for column in source["columns"] if column not in columns)
                dictionary = source.get("dictionary_table")
                if dictionary:
                    dictionary_name = member(archive, f"/hosp/{dictionary}.csv.gz") or member(archive, f"/icu/{dictionary}.csv.gz")
                    if not dictionary_name: missing.append(f"dictionary.{dictionary}")
                    else: checked.append(dictionary_name)
            results.append({"mapping_id": mapping["mapping_id"], "status": "verified" if not missing else "blocked", "checked_members": checked, "missing": missing})
    output = {"schema_version": "1.0.0", "archive_sha256": f"sha256:{digest.hexdigest()}", "mapping_pack": pack["pack_id"], "generated_at": datetime.now(timezone.utc).isoformat(), "results": results, "summary": {"total": len(results), "verified": sum(r["status"] == "verified" for r in results), "blocked": sum(r["status"] == "blocked" for r in results)}}
    with open(args.output, "w", encoding="utf-8") as target: json.dump(output, target, ensure_ascii=False, indent=2); target.write("\n")
    print(json.dumps({"output": args.output, "summary": output["summary"]}, ensure_ascii=False))

if __name__ == "__main__": main()
