# Prompt organization

Runtime product prompts live in `product/<capability>/`. Project-development prompts live in `governance/<capability>/`.

Each capability keeps its active prompt in `current.md` and representative checks in `cases.md`. When a prompt is replaced, create a local `history/` directory and store the superseded version as `v<version>.md` with the replacement version, date, and reason.

Prompt directories are source assets owned by their named capability. Backend business code may select a registered prompt identifier and version through typed configuration, but it must not read these files directly or embed their contents.
