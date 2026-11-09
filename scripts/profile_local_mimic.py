#!/usr/bin/env python3
"""Stream a focused, aggregate-only profile from a local MIMIC-IV ZIP archive."""

import argparse
import csv
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone


def member(archive: zipfile.ZipFile, suffix: str) -> str:
    matches = [name for name in archive.namelist() if name.endswith(suffix)]
    if len(matches) != 1:
        raise ValueError(f"Expected one archive member ending with {suffix!r}, found {len(matches)}")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("--output", default=".local/mimic-iv-local-profile.json")
    parser.add_argument("--exposure-pattern", required=True, help="Regex applied to d_icd_diagnoses.long_title")
    parser.add_argument("--exposure-label", required=True, help="Human-readable label supplied by the reviewed study definition")
    parser.add_argument("--profile-id", required=True, help="Versioned profile identifier supplied by the workflow")
    args = parser.parse_args()

    archive_sha256 = hashlib.sha256()
    with open(args.archive, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            archive_sha256.update(chunk)

    with zipfile.ZipFile(args.archive) as archive:
        diagnosis_dictionary = member(archive, "/hosp/d_icd_diagnoses.csv.gz")
        diagnoses = member(archive, "/hosp/diagnoses_icd.csv.gz")
        admissions = member(archive, "/hosp/admissions.csv.gz")

        exposure_codes: set[tuple[str, str]] = set()
        dictionary_rows = 0
        with archive.open(diagnosis_dictionary) as compressed:
            import gzip

            with gzip.open(compressed, mode="rt", newline="", encoding="utf-8") as stream:
                for row in csv.DictReader(stream):
                    dictionary_rows += 1
                    if re.search(args.exposure_pattern, row["long_title"], re.IGNORECASE):
                        exposure_codes.add((row["icd_code"], row["icd_version"]))

        exposure_hadm: set[str] = set()
        diagnosis_rows = 0
        with archive.open(diagnoses) as compressed:
            import gzip

            with gzip.open(compressed, mode="rt", newline="", encoding="utf-8") as stream:
                for row in csv.DictReader(stream):
                    diagnosis_rows += 1
                    if (row["icd_code"], row["icd_version"]) in exposure_codes:
                        exposure_hadm.add(row["hadm_id"])

        totals = {"admissions": 0, "exposure_admissions": 0, "deaths": 0, "exposure_deaths": 0}
        with archive.open(admissions) as compressed:
            import gzip

            with gzip.open(compressed, mode="rt", newline="", encoding="utf-8") as stream:
                for row in csv.DictReader(stream):
                    totals["admissions"] += 1
                    expired = row["hospital_expire_flag"] == "1"
                    if expired:
                        totals["deaths"] += 1
                    if row["hadm_id"] in exposure_hadm:
                        totals["exposure_admissions"] += 1
                        if expired:
                            totals["exposure_deaths"] += 1

    non_exposure_admissions = totals["admissions"] - totals["exposure_admissions"]
    non_exposure_deaths = totals["deaths"] - totals["exposure_deaths"]
    exposure_survived = totals["exposure_admissions"] - totals["exposure_deaths"]
    non_exposure_survived = non_exposure_admissions - non_exposure_deaths
    exposure_risk = totals["exposure_deaths"] / totals["exposure_admissions"]
    non_exposure_risk = non_exposure_deaths / non_exposure_admissions
    profile = {
        "schema_version": "1.0.0",
        "profile_id": args.profile_id,
        "data_mode": "local_mimic_archive",
        "source": {
            "archive_sha256": f"sha256:{archive_sha256.hexdigest()}",
            "tables": [
                "hosp/d_icd_diagnoses.csv.gz",
                "hosp/diagnoses_icd.csv.gz",
                "hosp/admissions.csv.gz",
            ],
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "definition": {
            "exposure": f"Admission is exposed when hadm_id has an ICD diagnosis whose dictionary long_title matches /{args.exposure_pattern}/i.",
            "mortality": "admissions.hospital_expire_flag = 1.",
            "scope": "Hospital admissions represented in admissions.csv.gz.",
            "exposure_label": args.exposure_label,
            "caveat": "This is a reproducible pattern-derived candidate phenotype, not a clinically approved ICD code set.",
        },
        "scan_counts": {
            "diagnosis_dictionary_rows": dictionary_rows,
            "exposure_dictionary_codes": len(exposure_codes),
            "diagnosis_rows": diagnosis_rows,
            "exposure_hadm_ids": len(exposure_hadm),
        },
        "contingency_table": {
            "exposure": {"death": totals["exposure_deaths"], "survived": exposure_survived},
            "no_exposure": {"death": non_exposure_deaths, "survived": non_exposure_survived},
        },
        "crude_effects": {
            "exposure_mortality_risk": exposure_risk,
            "no_exposure_mortality_risk": non_exposure_risk,
            "risk_difference": exposure_risk - non_exposure_risk,
            "risk_ratio": exposure_risk / non_exposure_risk if non_exposure_risk else None,
            "odds_ratio": (totals["exposure_deaths"] * non_exposure_survived) / (exposure_survived * non_exposure_deaths) if exposure_survived and non_exposure_deaths else None,
        },
        "totals": totals,
        "status": "candidate_profile_ready",
    }
    with open(args.output, "w", encoding="utf-8") as target:
        json.dump(profile, target, ensure_ascii=False, indent=2)
        target.write("\n")
    print(json.dumps({"output": args.output, "status": profile["status"], "totals": totals}, ensure_ascii=False))


if __name__ == "__main__":
    main()
