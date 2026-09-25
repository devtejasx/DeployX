// ============================================================================
// SIMULATION - Phase 3 only.
//
// Deterministic failures, so that retries and failure handling can be tested
// without random behaviour. They are triggered by the deployment's branch:
//
//   simulate/fail   - the simulated build fails on every attempt
//                     -> the deployment ends FAILED after the last attempt
//   simulate/flaky  - the simulated build fails on every attempt but the last
//                     -> the deployment ends SUCCESS on the final attempt
//
// Any other branch never fails. Removed together with the simulation in Phase 4.
// ============================================================================

export const FAIL_BRANCH = 'simulate/fail';
export const FLAKY_BRANCH = 'simulate/flaky';

// Returns the error the simulated build should throw, or null.
export function simulatedBuildFailure(branch, attempt, maxAttempts) {
  if (branch === FAIL_BRANCH) {
    return new Error(`Simulated build failure (branch "${FAIL_BRANCH}" always fails)`);
  }
  if (branch === FLAKY_BRANCH && attempt < maxAttempts) {
    return new Error(`Simulated build failure (branch "${FLAKY_BRANCH}" fails until the last attempt)`);
  }
  return null;
}
