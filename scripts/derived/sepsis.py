"""Sepsis-3 at ICU admission, a first-day approximation.

Sepsis-3 (Singer 2016) is a suspected infection with an acute rise of the SOFA score by 2 or more. The platform has the SOFA score of
the first 24 hours after ICU admission (icu.py) and no hourly score, so the definition is applied at ICU admission:

  suspected infection (Seymour 2016, the mimic-code convention): a systemic antibiotic ordered and a culture taken in the same admission,
    the antibiotic first and the culture within 24 hours after it (suspicion at the antibiotic), or the culture first and the antibiotic
    within 72 hours after it (suspicion at the culture);
  the suspicion falls between 24 hours before and 24 hours after the start of the ICU stay;
  first-day SOFA is 2 or more (the baseline SOFA is taken as 0).

The result is an event at ICU admission for each qualifying ICU stay. Sepsis that begins later in the stay, or an infection suspected
more than a day before ICU admission, is not counted; a patient whose first-day SOFA is 1 or less is not sepsis here, whatever the
infection. Most published MIMIC-IV studies define their sepsis cohort at ICU admission in the same way.
Antibiotic names follow the mimic-code antibiotic list; every culture counts, whatever its result.
"""
import pandas as pd
from common import read_table

ANTIBIOTICS = (
    "adoxa|ala-tet|alodox|amikacin|amikin|amoxicill|amphotericin|anidulafungin|ancef|clavulanate|ampicillin|augmentin|avelox|avycaz|azactam|azithromycin|aztreonam|"
    "axetil|bactocill|bactrim|bethkis|biaxin|bicillin|cayston|cefazolin|cedax|cefoxitin|ceftazidime|cefaclor|cefadroxil|cefdinir|cefditoren|cefepime|cefotan|cefotetan|"
    "cefotaxime|ceftaroline|cefpodoxime|cefprozil|ceftibuten|ceftin|cefuroxime|cephalexin|chloramphenicol|cipro|ciprofloxacin|claforan|clarithromycin|cleocin|clindamycin|"
    "cubicin|dicloxacillin|dirithromycin|doryx|doxycy|duricef|erythromycin|ertapenem|factive|flagyl|fortaz|furadantin|garamycin|gentamicin|kanamycin|keflex|kefzol|ketek|"
    "levaquin|levofloxacin|lincocin|linezolid|macrobid|macrodantin|maxipime|mefoxin|meropenem|metronidazole|minocin|minocycline|monurol|naftcillin|neomycin|netilmicin|"
    "nitrofurantoin|norfloxacin|noroxin|ofloxacin|omnicef|oracea|oritavancin|oxacillin|pc pen vk|penicillin|piperacillin|tazobactam|polymyxin|primaxin|quinupristin|"
    "rifadin|rifampin|rocephin|ceftriaxone|sivextro|synercid|tazicef|tedizolid|teflaro|telavancin|tetracycline|ticarcillin|timentin|tigecycline|tobramycin|trimethoprim|"
    "unasyn|vabomere|vancocin|vancomycin|vibativ|vibra-tabs|vibramycin|xenleta|zerbaxa|zithromax|zosyn|zyvox|imipenem|cilastatin|colistin"
)
# Systemic routes only; eye drops, ear drops, skin and inhaled products are not an infection treatment decision of this kind.
ROUTES = {"IV", "IV DRIP", "IV BOLUS", "PO", "PO/NG", "NG", "IM", "ORAL", "J TUBE", "G TUBE", "PEG", "GT", "NASOGASTRIC", "DUODENAL TUBE", "OG"}


def build(archive, stays, sofa, itemid):
    """Events of the stays with Sepsis-3 on ICU admission. `sofa` has stay_id and the first-day score `sofa`."""
    rx = read_table(archive, "prescriptions", usecols=["hadm_id", "starttime", "drug", "route"])
    rx = rx.dropna(subset=["hadm_id", "starttime", "drug"])
    rx = rx[rx["drug"].str.lower().str.contains(ANTIBIOTICS, regex=True, na=False) & rx["route"].astype(str).str.upper().isin(ROUTES)]
    rx["hadm_id"] = rx["hadm_id"].astype("int64"); rx["antibiotic"] = pd.to_datetime(rx["starttime"])
    rx = rx[["hadm_id", "antibiotic"]].drop_duplicates()
    cultures = read_table(archive, "microbiologyevents", usecols=["hadm_id", "chartdate", "charttime"]).dropna(subset=["hadm_id"])
    cultures["hadm_id"] = cultures["hadm_id"].astype("int64")
    cultures["culture"] = pd.to_datetime(cultures["charttime"].fillna(cultures["chartdate"]))
    cultures = cultures[["hadm_id", "culture"]].dropna().drop_duplicates()
    pairs = rx.merge(cultures, on="hadm_id", how="inner")
    gap = (pairs["culture"] - pairs["antibiotic"]).dt.total_seconds() / 3600
    # antibiotic first, culture within 24 hours: suspicion at the antibiotic; culture first, antibiotic within 72 hours: suspicion at the culture
    suspicion = pd.concat([
        pairs.loc[(gap >= 0) & (gap <= 24), ["hadm_id", "antibiotic"]].rename(columns={"antibiotic": "suspected"}),
        pairs.loc[(gap < 0) & (gap >= -72), ["hadm_id", "culture"]].rename(columns={"culture": "suspected"}),
    ]).drop_duplicates()
    joined = stays[["stay_id", "subject_id", "hadm_id", "intime"]].merge(suspicion, on="hadm_id", how="inner")
    around = (joined["suspected"] - joined["intime"]).dt.total_seconds() / 3600
    qualifying = set(joined.loc[(around >= -24) & (around <= 24), "stay_id"])
    scored = sofa[sofa["sofa"] >= 2]["stay_id"]
    keep = stays[stays["stay_id"].isin(qualifying) & stays["stay_id"].isin(set(scored))]
    summary = {"suspected_infection_stays": len(qualifying), "sepsis3_stays": len(keep), "sepsis3_share_of_stays": round(len(keep) / len(stays), 3)}
    out = pd.DataFrame({"subject_id": keep["subject_id"].astype("int64"), "hadm_id": keep["hadm_id"], "stay_id": keep["stay_id"], "itemid": itemid, "charttime": keep["intime"], "valuenum": 1.0})
    return out, summary
