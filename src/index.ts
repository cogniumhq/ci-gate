// Thin entry the ncc bundle uses. Splitting it out from `main.ts` keeps
// tests importable without side effects (main.ts exports `run()`, this
// file only invokes it).

import { reportUnhandled, run } from "./main.js";

run().catch(reportUnhandled);
