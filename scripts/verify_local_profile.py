#!/usr/bin/env python3
"""Recompute and verify a previously generated aggregate-only local profile."""
import argparse, hashlib, json, math

def close(a, b):
    return (a is None and b is None) or (isinstance(a, (int, float)) and isinstance(b, (int, float)) and math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-15))

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("profile"); args = parser.parse_args()
    profile = json.load(open(args.profile, encoding="utf-8")); table = profile["contingency_table"]
    ee, es = table["exposure"]["death"], table["exposure"]["survived"]
    ne, ns = table["no_exposure"]["death"], table["no_exposure"]["survived"]
    er, nr = ee / (ee + es), ne / (ne + ns)
    expected = {"exposure_mortality_risk": er, "no_exposure_mortality_risk": nr, "risk_difference": er - nr, "risk_ratio": er / nr if nr else None, "odds_ratio": ee * ns / (es * ne) if es and ne else None}
    actual = profile["crude_effects"]; mismatches = [key for key, value in expected.items() if not close(value, actual.get(key))]
    status = "passed" if not mismatches else "failed"
    result = {"status": status, "profile": args.profile, "checked_effects": list(expected), "mismatches": mismatches, "source_archive_sha256": profile.get("source", {}).get("archive_sha256"), "aggregate_only": True}
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if status == "passed" else 1)

if __name__ == "__main__": main()
