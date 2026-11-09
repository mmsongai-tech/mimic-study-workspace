"""Build the Charlson comorbidity index seed mapping (Quan et al., Med Care 2005;43:1130-9).

Groups are written in the paper's range notation and expanded to dot-free ICD prefixes as stored in MIMIC-IV.
With --dictionary <d_icd_diagnoses.csv>, every prefix must match at least one code of its ICD version, so a
transcription typo cannot silently drop a group. Prints one mapping JSON object for config/mappings.

Usage: python3 scripts/build-charlson-seed.py [--dictionary path/to/d_icd_diagnoses.csv]
Status: transcribed by the coding agent on 2026-09-24; pending clinical review.
"""
import csv
import json
import sys

# (group_id, label, weight, supersedes, ICD-9-CM items, ICD-10 items). Items: "410", "425.4-425.9", "I42.5-I42.9".
GROUPS = [
    ("mi", "Myocardial infarction", 1, [], ["410", "412"], ["I21", "I22", "I25.2"]),
    ("chf", "Congestive heart failure", 1, [],
     ["398.91", "402.01", "402.11", "402.91", "404.01", "404.03", "404.11", "404.13", "404.91", "404.93", "425.4-425.9", "428"],
     ["I09.9", "I11.0", "I13.0", "I13.2", "I25.5", "I42.0", "I42.5-I42.9", "I43", "I50", "P29.0"]),
    ("pvd", "Peripheral vascular disease", 1, [],
     ["093.0", "437.3", "440", "441", "443.1-443.9", "447.1", "557.1", "557.9", "V43.4"],
     ["I70", "I71", "I73.1", "I73.8", "I73.9", "I77.1", "I79.0", "I79.2", "K55.1", "K55.8", "K55.9", "Z95.8", "Z95.9"]),
    ("cvd", "Cerebrovascular disease", 1, [], ["362.34", "430-438"], ["G45", "G46", "H34.0", "I60-I69"]),
    ("dementia", "Dementia", 1, [], ["290", "294.1", "331.2"], ["F00-F03", "F05.1", "G30", "G31.1"]),
    ("cpd", "Chronic pulmonary disease", 1, [],
     ["416.8", "416.9", "490-505", "506.4", "508.1", "508.8"],
     ["I27.8", "I27.9", "J40-J47", "J60-J67", "J68.4", "J70.1", "J70.3"]),
    ("rheum", "Rheumatic disease", 1, [],
     ["446.5", "710.0-710.4", "714.0-714.2", "714.8", "725"],
     ["M05", "M06", "M31.5", "M32-M34", "M35.1", "M35.3", "M36.0"]),
    ("pud", "Peptic ulcer disease", 1, [], ["531-534"], ["K25-K28"]),
    ("mild_liver", "Mild liver disease", 1, [],
     ["070.22", "070.23", "070.32", "070.33", "070.44", "070.54", "070.6", "070.9", "570", "571", "573.3", "573.4", "573.8", "573.9", "V42.7"],
     ["B18", "K70.0-K70.3", "K70.9", "K71.3-K71.5", "K71.7", "K73", "K74", "K76.0", "K76.2-K76.4", "K76.8", "K76.9", "Z94.4"]),
    ("diabetes", "Diabetes without chronic complication", 1, [],
     ["250.0-250.3", "250.8", "250.9"],
     ["E10.0", "E10.1", "E10.6", "E10.8", "E10.9", "E11.0", "E11.1", "E11.6", "E11.8", "E11.9", "E12.0", "E12.1", "E12.6", "E12.8", "E12.9",
      "E13.0", "E13.1", "E13.6", "E13.8", "E13.9", "E14.0", "E14.1", "E14.6", "E14.8", "E14.9"]),
    ("diabetes_complicated", "Diabetes with chronic complication", 2, ["diabetes"],
     ["250.4-250.7"],
     ["E10.2-E10.5", "E10.7", "E11.2-E11.5", "E11.7", "E12.2-E12.5", "E12.7", "E13.2-E13.5", "E13.7", "E14.2-E14.5", "E14.7"]),
    ("paralysis", "Hemiplegia or paraplegia", 2, [],
     ["334.1", "342", "343", "344.0-344.6", "344.9"],
     ["G04.1", "G11.4", "G80.1", "G80.2", "G81", "G82", "G83.0-G83.4", "G83.9"]),
    ("renal", "Renal disease", 2, [],
     ["403.01", "403.11", "403.91", "404.02", "404.03", "404.12", "404.13", "404.92", "404.93", "582", "583.0-583.7", "585", "586", "588.0", "V42.0", "V45.1", "V56"],
     ["I12.0", "I13.1", "N03.2-N03.7", "N05.2-N05.7", "N18", "N19", "N25.0", "Z49.0-Z49.2", "Z94.0", "Z99.2"]),
    ("malignancy", "Any malignancy, including lymphoma and leukemia", 2, [],
     ["140-172", "174-194", "195.0-195.8", "200-208", "238.6"],
     ["C00-C26", "C30-C34", "C37-C41", "C43", "C45-C58", "C60-C76", "C81-C85", "C88", "C90-C97"]),
    ("severe_liver", "Moderate or severe liver disease", 3, ["mild_liver"],
     ["456.0-456.2", "572.2-572.8"],
     ["I85.0", "I85.9", "I86.4", "I98.2", "K70.4", "K71.1", "K72.1", "K72.9", "K76.5", "K76.6", "K76.7"]),
    ("metastatic", "Metastatic solid tumor", 6, ["malignancy"], ["196-199"], ["C77-C80"]),
    ("aids", "AIDS/HIV", 6, [], ["042-044"], ["B20-B22", "B24"]),
]


def expand(item):
    """'425.4-425.9' -> ['4254', ..., '4259']; 'C00-C26' -> ['C00', ..., 'C26']; '410' -> ['410']."""
    if "-" not in item:
        return [item.replace(".", "")]
    start, end = item.split("-")
    start, end = start.replace(".", ""), end.replace(".", "")
    head = 0
    while head < len(start) and not start[head].isdigit():
        head += 1
    prefix, first, last = start[:head], start[head:], end[head:]
    if end[:head] != prefix or len(first) != len(last):
        raise ValueError(f"unsupported range {item}")
    return [f"{prefix}{number:0{len(first)}d}" for number in range(int(first), int(last) + 1)]


def main():
    dictionary = None
    if "--dictionary" in sys.argv:
        with open(sys.argv[sys.argv.index("--dictionary") + 1], encoding="utf-8") as handle:
            dictionary = [(row["icd_code"], int(row["icd_version"])) for row in csv.DictReader(handle)]
    groups, missing = [], []
    for group_id, label, weight, supersedes, icd9, icd10 in GROUPS:
        prefixes = [{"prefix": p, "version": 9} for item in icd9 for p in expand(item)] + [{"prefix": p, "version": 10} for item in icd10 for p in expand(item)]
        if dictionary is not None:
            for entry in prefixes:
                if not any(code.startswith(entry["prefix"]) and version == entry["version"] for code, version in dictionary):
                    missing.append(f"{group_id}: ICD-{entry['version']} {entry['prefix']}")
        groups.append({"group_id": group_id, "label": label, "weight": weight, "code_prefixes": prefixes, **({"supersedes": supersedes} if supersedes else {})})
    mapping = {
        "mapping_id": "mimic-iv.charlson-comorbidity-index.v1", "concept_id": "charlson_comorbidity_index", "mapping_version": "1.0.0",
        "labels": {"en": "Charlson comorbidity index", "zh": "查尔森合并症指数"},
        "synonyms": ["Charlson comorbidity index", "Charlson index", "Charlson score", "CCI", "comorbidity index", "comorbidity burden", "查尔森合并症指数", "合并症指数", "合并症"],
        "category": "score", "value_type": "continuous",
        "definition": {
            "summary": "Charlson comorbidity index from the index admission's ICD diagnosis codes (Quan 2005 ICD-9-CM/ICD-10 algorithms, original Charlson weights, hierarchical groups).",
            "temporal_rule": "Diagnosis codes of the index admission (assigned at discharge).",
            "value_rule": "Sum of weights of groups with at least one matching code; a superseding group replaces the one it supersedes.",
            "missingness_rule": "An admission without qualifying codes scores 0.",
        },
        "sources": [{"kind": "diagnosis_code_score", "schema": "mimiciv_hosp", "table": "diagnoses_icd", "columns": ["subject_id", "hadm_id", "icd_code", "icd_version"], "score_groups": groups}],
        "status": "validated",
    }
    if missing:
        sys.stderr.write("Prefixes with no matching dictionary code:\n  " + "\n  ".join(missing) + "\n")
    sys.stdout.write(json.dumps(mapping, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stderr.write(f"{len(groups)} groups, {sum(len(g['code_prefixes']) for g in groups)} prefixes, {len(missing)} unmatched\n")


if __name__ == "__main__":
    main()
