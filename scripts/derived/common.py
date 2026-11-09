"""Shared loaders for the derived-variable layer.

The layer is computed once from the raw MIMIC-IV archive into a long table of events,
    subject_id, hadm_id, stay_id, itemid, charttime, valuenum
where `itemid` is a derived concept id (9000000 and up, see ITEMS in each family module). The platform reads the table like any
other MIMIC table, so its time windows, options and checks apply unchanged. Only aggregate-free event rows keyed by
patient and time are written: the output is MIMIC-derived and stays under the same access rules as the archive.
"""
import gzip, hashlib, json, os, zipfile
import pandas as pd

DERIVED_BASE = 9_000_000


def member(archive, name):
    zf = zipfile.ZipFile(archive)
    return next(n for n in zf.namelist() if n.endswith(f"/{name}.csv.gz")), zf


def read_table(archive, name, usecols=None, filters=None, chunksize=2_000_000, **kwargs):
    """Reads one archive table, keeping only rows where filters[column] contains the value (a set), in chunks."""
    path, zf = member(archive, name)
    parts = []
    with zf.open(path) as raw:
        reader = pd.read_csv(gzip.GzipFile(fileobj=raw), usecols=usecols, chunksize=chunksize, low_memory=False, **kwargs)
        for chunk in reader:
            for column, allowed in (filters or {}).items():
                chunk = chunk[chunk[column].isin(allowed)]
            if len(chunk): parts.append(chunk)
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=usecols or [])


def events(frame, itemid, time_column, value=None, hadm="hadm_id", stay=None, subject="subject_id"):
    """Builds the event rows of one derived concept from a frame; `value` is a column name or a constant."""
    out = pd.DataFrame({
        "subject_id": frame[subject].astype("int64"),
        "hadm_id": frame[hadm] if hadm in frame else pd.NA,
        "stay_id": frame[stay] if stay and stay in frame else pd.NA,
        "itemid": itemid,
        "charttime": frame[time_column],
        "valuenum": frame[value] if isinstance(value, str) else (1.0 if value is None else value),
    })
    return out


def write_events(frame, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    frame = frame.sort_values(["subject_id", "charttime", "itemid"])
    frame["charttime"] = pd.to_datetime(frame["charttime"]).dt.strftime("%Y-%m-%d %H:%M:%S")
    path = os.path.join(out_dir, "derived_events.csv.gz")
    frame.to_csv(path, index=False, compression="gzip")
    return path


def diagnosis_fingerprint(pack_path, order_path):
    """Short hash of the coded diagnosis concepts the layer was built from (their order and code sets).

    The readmission and history items of the layer are numbered by the position of a diagnosis concept and computed from its
    codes, so a layer built from other definitions would answer a question with another meaning. The platform compares this
    value with the one it computes from the same files and refuses a layer that differs (backend/src/clinical-data/derived-layer.ts).
    """
    pack = json.load(open(pack_path, encoding="utf-8")); order = json.load(open(order_path, encoding="utf-8"))["order"]
    codes = {m["concept_id"]: m["sources"][0]["codes"] for m in pack["mappings"] if m["sources"][0].get("kind") == "diagnosis_code" and m["sources"][0].get("codes")}
    lines = [f"{concept}:" + ",".join(sorted(f"{c['version']}:{c['code']}" for c in codes[concept])) for concept in order if concept in codes]
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()[:16]
