// Decides which lines of `docker build` output are worth storing in
// deployment_logs. Build output can run to many thousands of lines, so only
// meaningful lines are kept, each line is capped, and the total per build is
// capped. The last lines are always kept separately so a failure can still be
// explained after the cap is reached.

// BuildKit (--progress=plain): "#7 [2/4] RUN npm ci"; legacy: "Step 2/4 : RUN ..."
const STEP_LINE = /^#\d+ \[[^\]]+\] |^Step \d+\/\d+ : /;
// BuildKit result lines and errors.
const IMPORTANT_LINE = /^#\d+ (ERROR|CANCELED)\b|^#\d+ naming to |^ERROR\b|\berror\b|^Successfully (built|tagged) /i;
// BuildKit progress bookkeeping that explains nothing on its own.
const NOISE_LINE = /^#\d+ (DONE|CACHED)\b|^#\d+ transferring |^#0 building with /;

// Hide credentials embedded in URLs (https://user:token@host).
export function sanitizeLine(line, maxLength) {
  const clean = line.replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@');
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}… [truncated]` : clean;
}

export function createBuildLogCollector({ maxLines = 150, maxLineLength = 1000, tailSize = 30 } = {}) {
  const tail = [];
  const seenSteps = new Set();
  let stored = 0;
  let dropped = 0;

  return {
    // Returns the line to store, or null to skip it.
    accept(rawLine) {
      const line = rawLine.trimEnd();
      tail.push(line);
      if (tail.length > tailSize) tail.shift();

      const isStep = STEP_LINE.test(line);
      if (!isStep && !IMPORTANT_LINE.test(line)) return null;
      // BuildKit repeats a step header when it reports progress; keep it once.
      if (isStep) {
        if (seenSteps.has(line)) return null;
        seenSteps.add(line);
      }
      if (stored >= maxLines) {
        dropped += 1;
        return null;
      }
      stored += 1;
      return sanitizeLine(line, maxLineLength);
    },
    // The last lines of output, for explaining a failure (BuildKit progress
    // noise such as "#1 DONE 0.0s" left out).
    tail() {
      return tail
        .filter((line) => !NOISE_LINE.test(line))
        .map((line) => sanitizeLine(line, maxLineLength));
    },
    get dropped() {
      return dropped;
    },
  };
}
