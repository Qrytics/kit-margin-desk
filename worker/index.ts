import { enqueueDailyDigests } from "../app/server/digest.server";
import { enqueueNightlyReconciliation, runNextJob } from "../app/server/jobs.server";

/** Standalone worker: `npm run worker`. Run beside the web process (Fly machine / Render background worker). */
let lastNightly = "";
let lastDigest = "";
async function loop() {
  for (;;) {
    const day = new Date().toISOString().slice(0, 10);
    if (new Date().getUTCHours() === 3 && lastNightly !== day) {
      lastNightly = day;
      await enqueueNightlyReconciliation().catch((e) => console.error("nightly enqueue failed", e));
    }
    if (new Date().getUTCHours() === 13 && lastDigest !== day) {
      lastDigest = day;
      await enqueueDailyDigests().catch((e) => console.error("digest enqueue failed", e));
    }
    const worked = await runNextJob().catch((e) => { console.error("job loop error", e); return false; });
    if (!worked) await new Promise((r) => setTimeout(r, 1500));
  }
}
loop();
