#!/usr/bin/env python3
"""Builds the dictionary index that variable definitions are searched and checked against.

One pass over the MIMIC-IV archive writes, for every laboratory item, chart item, input item, diagnosis code, procedure code and
prescription label: its name, how many rows and how many admissions carry it, and, for numeric items, a sampled distribution
(median, 1st and 99th percentile) and the commonest units. A researcher searching "anion gap" then sees at once which items exist
and how much data each has; a definition that names an item with no rows is rejected before it is used.

Aggregate counts only: no patient-level rows are written.

  python3 scripts/build-dictionary-index.py --archive ~/Desktop/mimic-iv-3.1.zip --out .local/dictionary-index.json
"""
import argparse, collections, gzip, json, sys, zipfile
import numpy as np
import pandas as pd

SAMPLE = 0.01


def member(zf, suffix):
    return next(name for name in zf.namelist() if name.endswith(suffix))


def chunks(zf, suffix, usecols, size=2_000_000):
    with zf.open(member(zf, suffix)) as raw:
        yield from pd.read_csv(gzip.GzipFile(fileobj=raw), usecols=usecols, chunksize=size, low_memory=False)


class Counter:
    """Rows and distinct admissions per key, plus a sample of numeric values and units."""
    def __init__(self):
        self.rows = collections.Counter(); self.pairs = []; self.sample = collections.defaultdict(list); self.units = collections.defaultdict(collections.Counter)

    def add(self, keys, admissions, values=None, units=None, rng=None):
        for key, count in keys.value_counts().items(): self.rows[key] += int(count)
        # One 64-bit number per (item, admission) pair, so duplicates are found with a fast one-dimensional unique.
        self.pairs.append(np.unique((keys.to_numpy(dtype="int64") << 32) | admissions.to_numpy(dtype="int64")))
        if len(self.pairs) >= 12: self.compact()
        if values is not None:
            take = rng.random(len(keys)) < SAMPLE
            for key, value in zip(keys[take], values[take]):
                if value == value: self.sample[key].append(float(value))
            if units is not None:
                for key, unit in zip(keys[take], units[take]):
                    if isinstance(unit, str): self.units[key][unit] += 1

    def compact(self):
        if len(self.pairs) > 1: self.pairs = [np.unique(np.concatenate(self.pairs))]

    def result(self, key):
        self.compact()
        record = {"rows": self.rows.get(key, 0)}
        if self.pairs:
            if not hasattr(self, "by_key"): self.by_key = dict(zip(*[column.tolist() for column in np.unique(self.pairs[0] >> 32, return_counts=True)]))
            record["admissions"] = int(self.by_key.get(key, 0))
        values = self.sample.get(key)
        if values and len(values) >= 20:
            record["median"], record["p01"], record["p99"] = [round(float(np.percentile(values, q)), 3) for q in (50, 1, 99)]
        if self.units.get(key): record["units"] = [[unit, count] for unit, count in self.units[key].most_common(4)]
        return record


def numeric_table(zf, suffix, key_column, admission_column, value_column, unit_column, rng, label):
    counter = Counter(); usecols = [key_column, admission_column] + ([value_column] if value_column else []) + ([unit_column] if unit_column else [])
    for i, frame in enumerate(chunks(zf, suffix, usecols), 1):
        frame = frame.dropna(subset=[key_column, admission_column])
        counter.add(frame[key_column].astype("int64"), frame[admission_column].astype("int64"),
                    pd.to_numeric(frame[value_column], errors="coerce") if value_column else None, frame[unit_column] if unit_column else None, rng)
        print(f"  {label}: chunk {i}", file=sys.stderr, flush=True)
    return counter


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True); parser.add_argument("--out", required=True)
    args = parser.parse_args()
    zf = zipfile.ZipFile(args.archive); rng = np.random.default_rng(7); out = {"schema_version": "1.0.0", "source": "mimic-iv-3.1", "sections": {}}
    read = lambda suffix: pd.read_csv(gzip.GzipFile(fileobj=zf.open(member(zf, suffix))), low_memory=False)

    lab = read("hosp/d_labitems.csv.gz"); counter = numeric_table(zf, "hosp/labevents.csv.gz", "itemid", "hadm_id", "valuenum", "valueuom", rng, "labevents")
    out["sections"]["lab"] = [{"id": int(r.itemid), "label": str(r.label), "fluid": str(r.fluid), "category": str(r.category), "table": "labevents", **counter.result(int(r.itemid))} for r in lab.itertuples()]

    items = read("icu/d_items.csv.gz")
    chart = numeric_table(zf, "icu/chartevents.csv.gz", "itemid", "hadm_id", "valuenum", "valueuom", rng, "chartevents")
    inputs = numeric_table(zf, "icu/inputevents.csv.gz", "itemid", "hadm_id", "amount", "amountuom", rng, "inputevents")
    outputs = numeric_table(zf, "icu/outputevents.csv.gz", "itemid", "hadm_id", "value", "valueuom", rng, "outputevents")
    section = []
    for r in items.itertuples():
        table = str(r.linksto); source = {"chartevents": chart, "inputevents": inputs, "outputevents": outputs}.get(table)
        if source is not None: section.append({"id": int(r.itemid), "label": str(r.label), "category": str(r.category), "table": table, **source.result(int(r.itemid))})
    out["sections"]["item"] = [row for row in section if row["rows"] > 0]

    drug = collections.Counter(); drug_adm = collections.defaultdict(set)
    for frame in chunks(zf, "hosp/prescriptions.csv.gz", ["hadm_id", "drug", "route"]):
        frame = frame.dropna(subset=["drug", "hadm_id"])
        for name, count in frame["drug"].value_counts().items(): drug[name] += int(count)
        for name, group in frame.groupby("drug")["hadm_id"]: drug_adm[name].update(group.astype("int64").tolist())
    out["sections"]["drug"] = [{"label": name, "rows": rows, "admissions": len(drug_adm[name]), "table": "prescriptions"} for name, rows in drug.most_common()]

    for table, dictionary, section_name in (("diagnoses_icd", "d_icd_diagnoses", "diagnosis"), ("procedures_icd", "d_icd_procedures", "procedure")):
        names = read(f"hosp/{dictionary}.csv.gz"); rows = collections.Counter(); adm = collections.defaultdict(set)
        for frame in chunks(zf, f"hosp/{table}.csv.gz", ["hadm_id", "icd_code", "icd_version"]):
            frame = frame.dropna(); frame["key"] = frame["icd_code"].astype(str).str.strip() + "|" + frame["icd_version"].astype(int).astype(str)
            for key, count in frame["key"].value_counts().items(): rows[key] += int(count)
            for key, group in frame.groupby("key")["hadm_id"]: adm[key].update(group.astype("int64").tolist())
        out["sections"][section_name] = [{"code": str(r.icd_code).strip(), "version": int(r.icd_version), "label": str(r.long_title), "table": table,
                                           "rows": rows.get(f"{str(r.icd_code).strip()}|{int(r.icd_version)}", 0), "admissions": len(adm.get(f"{str(r.icd_code).strip()}|{int(r.icd_version)}", ()))} for r in names.itertuples()]
    json.dump(out, open(args.out, "w"), ensure_ascii=False, separators=(",", ":"))
    print({name: len(rows) for name, rows in out["sections"].items()})


if __name__ == "__main__":
    main()
