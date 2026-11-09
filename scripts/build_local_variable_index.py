#!/usr/bin/env python3
"""Build a complete, metadata-only variable index from the saved MIMIC catalog snapshot."""
import argparse, hashlib, json
from datetime import datetime, timezone

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default=".local/mimic-iv-catalog.snapshot.json")
    parser.add_argument("--output", default=".local/mimic-iv-variable-index.json")
    args = parser.parse_args()
    raw = open(args.catalog, "rb").read()
    snapshot = json.loads(raw)
    catalog = snapshot["catalog"]
    variables = []
    for relation in catalog["relations"]:
        for column in relation["columns"]:
            variables.append({
                "variable_id": f"{relation['schema']}.{relation['name']}.{column['name']}",
                "schema": relation["schema"], "table": relation["name"], "column": column["name"],
                "relation_type": relation["relation_type"], "data_type": column["data_type"],
                "nullable": column["nullable"],
                "clinical_meaning": None,
                "mapping_status": "uninterpreted",
            })
    result = {
        "schema_version": "1.0.0", "index_id": "mimic-iv.catalog-variable-index.v1",
        "source_catalog_integrity_id": snapshot.get("integrity_id"),
        "source_catalog_sha256": f"sha256:{hashlib.sha256(raw).hexdigest()}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "data_model": catalog["data_model"], "variable_count": len(variables),
        "relation_count": len(catalog["relations"]), "variables": variables,
        "note": "Metadata-only index. Clinical meaning is intentionally unresolved until a study-specific mapping is verified.",
    }
    with open(args.output, "w", encoding="utf-8") as target:
        json.dump(result, target, ensure_ascii=False, indent=2); target.write("\n")
    print(json.dumps({"output": args.output, "relation_count": result["relation_count"], "variable_count": result["variable_count"]}, ensure_ascii=False))

if __name__ == "__main__": main()
