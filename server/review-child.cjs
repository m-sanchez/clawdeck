// Runs the repository's pre-push review scan in a SEPARATE process so the panel's
// event loop is never blocked by the synchronous scan (which can take seconds on
// a large branch diff). Prints the raw runPrePush result as JSON on stdout.
"use strict";
const path = require("path");
const root = process.argv[2] || process.cwd();
try {
  const mod = require(
    path.join(root, ".claude", "hooks", "lib", "review-run.js"),
  );
  if (!mod || typeof mod.runPrePush !== "function") {
    process.stdout.write(JSON.stringify({ __unavailable: true }));
    process.exit(0);
  }
  const res = mod.runPrePush({ root });
  process.stdout.write(JSON.stringify(res));
} catch (e) {
  process.stdout.write(
    JSON.stringify({ __error: String((e && e.message) || e) }),
  );
}
