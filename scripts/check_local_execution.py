#!/usr/bin/env python3
"""Validate a user-supplied analysis manifest against a local MIMIC ZIP archive.

This performs header/catalog checks only; it never exports patient rows.
"""
import argparse, csv, hashlib, json, zipfile
from datetime import datetime, timezone

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("manifest", help="JSON manifest with methods[].required_members and required_columns")
    parser.add_argument("--output", default=".local/local-execution-readiness.json")
    args = parser.parse_args()
    manifest = json.load(open(args.manifest, encoding="utf-8"))
    archive_hash = hashlib.sha256()
    with open(args.archive, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""): archive_hash.update(chunk)
    with zipfile.ZipFile(args.archive) as archive:
        members = set(archive.namelist())
        methods = []
        for method in manifest.get("methods", []):
            missing_members = [member for member in method.get("required_members", []) if member not in members]
            missing_columns = {}
            for member in method.get("required_members", []):
                if member in missing_members: continue
                with archive.open(member) as stream:
                    import gzip
                    with gzip.open(stream, "rt", newline="", encoding="utf-8") as text:
                        columns = set(next(csv.reader(text)))
                required = method.get("required_columns", {}).get(member, [])
                missing = [column for column in required if column not in columns]
                if missing: missing_columns[member] = missing
            status = "ready" if not missing_members and not missing_columns else "blocked"
            methods.append({"method_id": method.get("method_id"), "status": status, "missing_members": missing_members, "missing_columns": missing_columns})
    result = {"schema_version": "1.0.0", "data_mode": "local_mimic_archive", "source": {"archive_sha256": f"sha256:{archive_hash.hexdigest()}", "checked_at": datetime.now(timezone.utc).isoformat()}, "methods": methods, "status": "ready" if all(item["status"] == "ready" for item in methods) else "needs_review"}
    with open(args.output, "w", encoding="utf-8") as target: json.dump(result, target, ensure_ascii=False, indent=2); target.write("\n")
    print(json.dumps({"output": args.output, "status": result["status"], "methods": methods}, ensure_ascii=False))

if __name__ == "__main__": main()
