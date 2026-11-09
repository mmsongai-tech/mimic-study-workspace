# Prompt lifecycle

Prompts are versioned source assets, not chat transcripts.

## Current prompt format

Each prompt lives in an owner and capability directory:

```text
prompts/<owner>/<capability>/current.md
prompts/<owner>/<capability>/cases.md
```

`product` prompts are runtime product assets. `governance` prompts support project planning and delivery. Each `current.md` contains:

- identifier and version;
- purpose and activation boundary;
- required inputs;
- stable instructions;
- expected output contract;
- safety and domain constraints;
- representative test cases;
- observed results and current status.

Project-specific values belong in configuration or task input, not in the stable instruction body.

## Change process

1. Search for an existing prompt with the same purpose.
2. Change one behavior at a time when practical.
3. Run the sibling `cases.md`.
4. Record observed results separately from expected results.
5. Copy the superseded body to a sibling `history/` directory with the version, date, and reason. Create that directory only when the first historical version exists.
6. Keep one current version.

Do not store secrets, patient data, copyrighted private material, or environment-specific absolute paths in prompts or test cases.
