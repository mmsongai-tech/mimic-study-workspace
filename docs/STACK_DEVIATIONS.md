# MIMIC-specific interpretation of the engineering standard

The supplied programming standard describes a broad Python, frontend, AI model, and real-time media platform. This project currently uses TypeScript for the web application and orchestration, plus focused Python or SQL for statistical and data workflows. The rules below prevent mechanical use of irrelevant sections.

| Source rule | MIMIC interpretation |
| --- | --- |
| Every backend module has `config.py` and `config.toml` | Each runtime has one typed configuration entry point. TypeScript uses a typed TS loader; Python uses a typed Python loader only where Python is an actual runtime. TOML is optional when environment variables and a checked example schema are sufficient. |
| Full layered directory tree per module | Create a directory only when its responsibility exists. Empty `routes`, `storage`, `clients`, `models`, or `utils` directories are prohibited. |
| ASR, OCR, VAD, TTS, speaker and real-time buffer rules | Not part of the current MIMIC scope. These sections do not apply unless a separately approved feature introduces that capability. |
| Model weights live inside each module | Model weights and caches are excluded from Git. Public code documents provider, version, license, retrieval, integrity, and fallback behavior. |
| Python public service as the main module API | Use a typed TypeScript public function or service for in-process TS modules, a typed Python function for statistical Python modules, and HTTP only across actual process boundaries. |
| Backend DTO and frontend ViewModel must always differ | Separate them when presentation state or transformation is non-trivial. A simple stable DTO may be used directly when the choice is documented and tested. |
| File length thresholds | A file over about 300 lines, or workflow over about 500 lines, triggers responsibility review. Line count alone does not justify fragmentation. |
| Every module or complex feature needs a README | A public module needs a concise contract document. Small private modules may use nearby typed exports and tests when a separate README would repeat the code. |
| AI prompt mock tests | Prompt tests verify output invariants and fail-closed behavior. They do not assert exact prose. Real-provider checks are separate, authorized integration evidence. |

## Project-specific additions

- MIMIC and PhysioNet data are not covered by the repository's MIT license.
- The data gateway exposes approved aggregates or controlled analysis inputs; the UI and language model never receive patient rows by default.
- Association, prediction, and treatment claims use separate capability and validation requirements. A treatment request fails closed when causal design requirements are not met.
- Every result records whether it came from a fixture, historical snapshot, aggregate cache, or current approved execution.
- Local ports, private database paths, SSH tunnels, keychain labels, and usernames are environment configuration, not public defaults.

