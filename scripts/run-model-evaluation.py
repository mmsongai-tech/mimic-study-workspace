#!/usr/bin/env python3
"""Runs the platform's published-question tests with whatever model the workspace is started with, and compares the outcome with the 7B baseline.

119 questions: the three held-out literature sets (34 + 31 + 34) and the 20 tuning questions, taken with their text from
backend/src/validation-fixtures/model-comparison/baseline-7b-*.json. For each question it submits a run, waits, and records aggregate facts only:
plan statuses, what the frame read (population, exposure, outcome, index event), the mapping options and the choice made, the
primary estimate, n and blockers. No patient-level data is read from or written to the output.

The model only changes the reading of the question and the mapping; the statistics do not depend on it. So `--mode plan` (the default)
plans every question without reading patient data, and `--full-keys` runs chosen questions to the end to confirm that the numbers equal the
baseline's when the plan is the same.

  # workspace started with the model under test:  MIMIC_LOCAL_MODEL_PROFILE=<model> bash scripts/start-workspace.sh
  python3 scripts/run-model-evaluation.py --out results/eval-24b --model-label mistral-small:24b
  python3 scripts/run-model-evaluation.py --out results/eval-24b --model-label mistral-small:24b --full-keys H-A01,H-B03,H2-A03,L01,L04   # adds full runs
  python3 scripts/run-model-evaluation.py --out results/eval-24b --resume     # continue after an interruption
"""
import argparse, glob, json, os, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASELINE = sorted(glob.glob(os.path.join(HERE, "..", "backend", "src", "validation-fixtures", "model-comparison", "baseline-7b-*.json")))[-1:]


def call(base, path, body=None, timeout=120):
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(request, timeout=timeout))


def summarize(plans, frames, unanswered, clarifications, mapping_clarifications):
    out = []
    for plan in plans:
        spec = plan.get("study_spec") or {}
        result = plan.get("result") or {}
        estimates = [e for e in result.get("estimates", []) if e.get("estimate") is not None]
        e = estimates[0] if estimates else None
        round_ = lambda v: None if v is None else round(v, 4)
        out.append({
            "status": plan.get("status"), "stage": plan.get("stage_reached"), "blocker": (plan.get("blockers") or [{}])[0].get("code"),
            "population": (spec.get("population") or {}).get("description"), "exposure": ((spec.get("exposure_or_predictors") or [{}])[0] or {}).get("name"),
            "outcome": (spec.get("outcome") or {}).get("name"), "index": (spec.get("index_time") or {}).get("event"),
            "method": result.get("method_id"), "n": result.get("n_analysed"),
            "estimate": round_(e["estimate"]) if e else None, "ci": [round_(e.get("ci_low")), round_(e.get("ci_high"))] if e else None,
        })
    return {"plans": out, "unanswered": [x["reasons"][0]["en"][:120] for x in unanswered],
            "mapping_clarifications": [{"term": c["term"], "chosen": (c.get("chosen") or {}).get("option_id"), "options": [o["option_id"] for o in c["options"]]} for c in mapping_clarifications]}


def plan_summary(draft):
    plans = [{"status": p["status"], "stage_reached": "mapping" if p["status"] == "blocked" else None, "blockers": (p.get("blocked_outcome") or {}).get("blockers", []), "study_spec": p["plan"]["study_spec"]} for p in draft["plans"]]
    return summarize(plans, draft["frame_set"]["frames"], draft["unanswered_frames"], draft.get("clarifications", []), draft.get("mapping_clarifications", []))


def wait(base, run_id, timeout):
    started = time.time()
    while time.time() - started < timeout:
        state = call(base, f"/api/runs/{run_id}")
        if state["status"] in ("awaiting_confirmation", "completed", "failed"): return state
        time.sleep(5)
    return {"status": "timeout"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:9000")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model-label", default="unnamed")
    parser.add_argument("--baseline", default=DEFAULT_BASELINE[0] if DEFAULT_BASELINE else None)
    parser.add_argument("--sets", default="heldout1,heldout2,heldout3,lit20")
    parser.add_argument("--mode", choices=["plan", "full"], default="plan")
    parser.add_argument("--full-keys", default="", help="comma list of question keys to run to the end even in plan mode")
    parser.add_argument("--clarify", choices=["ask", "first", "random"], default="random", help="what the platform does when a variable only partly matches (the baseline used random)")
    parser.add_argument("--timeout", type=int, default=5400, help="seconds to wait for one question")
    parser.add_argument("--limit", type=int, default=0, help="only the first N questions (a smoke test)")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    baseline = json.load(open(args.baseline))
    wanted = set(args.sets.split(","))
    keys = [k for k, v in baseline["questions"].items() if v["set"] in wanted]
    if args.limit: keys = keys[:args.limit]
    full = set(filter(None, args.full_keys.split(",")))
    os.makedirs(args.out, exist_ok=True)
    progress = os.path.join(args.out, "progress.jsonl")
    done = {}
    if args.resume and os.path.exists(progress):
        for line in open(progress):
            row = json.loads(line); done[row["key"]] = row
    started = time.time()
    for position, key in enumerate(keys, 1):
        if key in done: continue
        item = baseline["questions"][key]
        run_full = args.mode == "full" or key in full
        t0 = time.time()
        try:
            body = {"question": item["question"], "auto_confirm": run_full, **({"clarify": args.clarify} if args.clarify != "ask" else {})}
            run = call(args.base_url, "/api/runs", body)
            state = wait(args.base_url, run["id"], args.timeout)
            if state["status"] == "awaiting_confirmation": summary = plan_summary(call(args.base_url, f"/api/runs/{run['id']}/plan"))
            elif state["status"] == "completed":
                result = call(args.base_url, f"/api/runs/{run['id']}/result")
                summary = summarize(result["plans"], result["frame_set"]["frames"], result.get("unanswered_frames", []), [], [])
                try: summary["mapping_clarifications"] = plan_summary(call(args.base_url, f"/api/runs/{run['id']}/plan"))["mapping_clarifications"]
                except Exception: pass
            else: summary = {"plans": [], "unanswered": [], "mapping_clarifications": [], "error": (state.get("error") or state["status"])[:300]}
            row = {"key": key, "run": run["id"], "status": state["status"], "full_run": run_full, "seconds": round(time.time() - t0), **summary}
        except Exception as error:  # a failure of one question must not stop the batch
            row = {"key": key, "status": "harness_error", "full_run": run_full, "seconds": round(time.time() - t0), "plans": [], "unanswered": [], "mapping_clarifications": [], "error": str(error)[:300]}
        done[key] = row
        with open(progress, "a") as handle: handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"[{position}/{len(keys)}] {key} {row['status']} {row['seconds']}s  elapsed {round((time.time() - started) / 60)} min", flush=True)
    write_report(args, baseline, keys, done)


def same_plan(a, b):
    """Same reading: the same number of plans, statuses, outcome and index event, and the same exposure."""
    if len(a) != len(b): return False
    ok = lambda status: "ready" if status in ("ready", "completed") else status   # a planned question and a finished one read the same
    return all(ok(x["status"]) == ok(y["status"]) and (x.get("outcome") or "").lower() == (y.get("outcome") or "").lower() and x.get("index") == y.get("index") and (x.get("exposure") or "").lower() == (y.get("exposure") or "").lower() for x, y in zip(a, b))


def write_report(args, baseline, keys, done):
    rows = []
    for key in keys:
        new, base = done.get(key), baseline["questions"][key]
        if not new: continue
        np_, bp = new["plans"], base["plans"]
        answered_new = any(p["estimate"] is not None for p in np_)
        ready_new = sum(1 for p in np_ if p["status"] in ("ready", "completed")); ready_base = sum(1 for p in bp if p["status"] == "completed")
        row = {"key": key, "set": base["set"], "category": base.get("category"), "our_class_7b": base.get("our_class"), "status": new["status"], "plans": len(np_), "plans_7b": len(bp),
               "ready_plans": ready_new, "completed_plans_7b": ready_base, "same_reading_as_7b": same_plan(np_, bp), "new_exposure": [p.get("exposure") for p in np_][:3], "baseline_exposure": [p.get("exposure") for p in bp][:3],
               "new_outcome": [p.get("outcome") for p in np_][:3], "baseline_outcome": [p.get("outcome") for p in bp][:3], "blockers_new": [p.get("blocker") for p in np_ if p.get("blocker")], "blockers_7b": [p.get("blocker") for p in bp if p.get("blocker")],
               "unanswered_new": new.get("unanswered"), "unanswered_7b": base.get("unanswered"), "mapping_clarifications_new": new.get("mapping_clarifications"), "mapping_clarifications_7b": base.get("mapping_clarifications"),
               "seconds": new["seconds"], "full_run": new["full_run"]}
        # A public copy of the baseline carries the readings but not the numbers (MIMIC-derived results stay with credentialed people).
        if new["full_run"] and answered_new and baseline.get("numbers_included", True):
            row["estimate_new"] = [p["estimate"] for p in np_ if p["estimate"] is not None][:2]; row["estimate_7b"] = [p["estimate"] for p in bp if p["estimate"] is not None][:2]
            row["identical_numbers"] = [(p["n"], p["estimate"]) for p in np_] == [(p["n"], p["estimate"]) for p in bp]
        rows.append(row)
    total = len(rows)
    summary = {
        "model": args.model_label, "baseline_model": baseline["model"], "questions": total, "mode": args.mode, "clarify": args.clarify,
        "harness_errors": sum(1 for r in rows if r["status"] == "harness_error"), "timeouts": sum(1 for r in rows if r["status"] == "timeout"), "failed": sum(1 for r in rows if r["status"] == "failed"),
        "same_reading_as_7b": sum(1 for r in rows if r["same_reading_as_7b"]),
        "ready_or_completed_new": sum(1 for r in rows if r["ready_plans"] > 0), "completed_7b": sum(1 for r in rows if r["completed_plans_7b"] > 0),
        "full_runs": sum(1 for r in rows if r["full_run"]), "full_runs_identical_numbers": sum(1 for r in rows if r.get("identical_numbers")) if baseline.get("numbers_included", True) else "not compared (public baseline has no numbers)",
        "median_seconds_per_question": sorted(r["seconds"] for r in rows)[total // 2] if total else None,
    }
    json.dump({"summary": summary, "questions": rows}, open(os.path.join(args.out, "evaluation.json"), "w"), ensure_ascii=False, indent=1)
    lines = [f"# Model evaluation: {args.model_label} against {baseline['model']}", "", *[f"- {k}: {v}" for k, v in summary.items()], "", "## Questions whose reading differs from the 7B baseline", ""]
    for r in rows:
        if r["same_reading_as_7b"]: continue
        lines.append(f"- **{r['key']}** ({r['set']}, 7B class: {r['our_class_7b']}): plans {r['plans_7b']} → {r['plans']}; exposure {r['baseline_exposure']} → {r['new_exposure']}; outcome {r['baseline_outcome']} → {r['new_outcome']}; blockers {r['blockers_7b']} → {r['blockers_new']}")
    differ = [r for r in rows if r["full_run"] and r.get("identical_numbers") is False]
    if differ:
        lines += ["", "## Full runs whose numbers differ from the baseline (read the plans above first: a different plan explains it)", ""]
        lines += [f"- {r['key']}: {r['estimate_7b']} → {r['estimate_new']}" for r in differ]
    open(os.path.join(args.out, "evaluation.md"), "w").write("\n".join(lines) + "\n")
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    sys.exit(main())
