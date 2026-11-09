#!/usr/bin/env python3
"""Runs the planning-batch questions against a running question workspace and summarises what was understood.

Planning step only: no analysis runs and no patient data is read. Start the workspace first, with the model under test:
  MIMIC_LOCAL_MODEL_PROFILE=<ollama model> MIMIC_LOCAL_MODEL_BASE_URL=http://127.0.0.1:11434/v1 \
  QUESTION_WORKSPACE_RUNS_DIR=<empty folder> MIMIC_LOCAL_ARCHIVE=<mimic-iv-3.1.zip> \
  node --import tsx backend/src/entrypoints/question-workspace-server.ts
Then: python3 scripts/run-planning-batch.py --out results/<model-name>
"""
import argparse, json, os, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_QUESTIONS = os.path.join(HERE, "..", "backend", "src", "validation-fixtures", "planning-batch", "questions.json")


def call(base, path, body=None):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(request, timeout=60))


def text(slot):
    return slot.get("text") if isinstance(slot, dict) else None


def summarise(draft):
    frames = [{"type": f.get("study_type"), "population": text(f.get("population")), "exposure": text(f.get("exposure")),
               "predictors": [text(x) for x in f.get("predictors", [])], "outcome": text(f.get("outcome")),
               "modifiers": [text(x) for x in f.get("modifiers", [])], "mediators": [text(x) for x in f.get("mediators", [])]}
              for f in draft.get("frame_set", {}).get("frames", [])]
    plans = [{"status": p.get("status"), "unmapped": [m.get("requested_term") for m in p.get("mapping", []) if m.get("status") != "resolved"]} for p in draft.get("plans", [])]
    return {"frames": frames, "plans": plans}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:9000")
    parser.add_argument("--questions", default=DEFAULT_QUESTIONS)
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=900, help="seconds to wait for one plan")
    args = parser.parse_args()
    questions = json.load(open(args.questions))["questions"]
    os.makedirs(args.out, exist_ok=True)
    results = []
    for item in questions:
        started = time.time()
        row = {"key": item["key"], "kind": item["kind"], "question": item["question"], "expected": item["expected"]}
        try:
            record = call(args.base_url, "/api/runs", {"question": item["question"]})
            run_id = record.get("id") or record.get("run_id")
            status = None
            while time.time() - started < args.timeout:
                time.sleep(5)
                status = call(args.base_url, "/api/runs/" + run_id).get("status")
                if status in ("awaiting_confirmation", "failed", "completed"):
                    break
            row.update({"run_id": run_id, "status": status, "seconds": round(time.time() - started)})
            if status == "awaiting_confirmation":
                row.update(summarise(call(args.base_url, "/api/runs/" + run_id + "/plan")))
        except Exception as error:  # a failed question is a result, not a reason to stop the batch
            row["error"] = str(error)
        results.append(row)
        json.dump(results, open(os.path.join(args.out, "results.json"), "w"), ensure_ascii=False, indent=1)
        plans = row.get("plans", [])
        print(f"{item['key']:4} {row.get('status')} {row.get('seconds')}s frames={[f['type'] for f in row.get('frames', [])]} plans={[p['status'] for p in plans]}", flush=True)
    print("Results:", os.path.join(args.out, "results.json"))


if __name__ == "__main__":
    main()
