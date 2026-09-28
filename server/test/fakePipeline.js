// Test double for the worker's deployment pipeline. The queue tests exercise
// BullMQ behaviour (concurrency, retries, duplicates, shutdown), not Docker,
// so they plug this fast, deterministic pipeline into the real processor.
// The real pipeline is covered by docker-deploy.test.js.
//
// Deterministic failures, chosen by the deployment's branch:
//   test/fail   - fails on every attempt
//   test/flaky  - fails on every attempt but the last
export const FAIL_BRANCH = 'test/fail';
export const FLAKY_BRANCH = 'test/flaky';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakePipeline({ stepMs }) {
  return async function fakePipeline(ctx) {
    const { deployment, attempt, maxAttempts } = ctx;

    await ctx.setStage('BUILDING', 'Deployment is now building');
    await sleep(stepMs);
    if (deployment.branch === FAIL_BRANCH) {
      throw new Error(`Fake build failure (branch "${FAIL_BRANCH}" always fails)`);
    }
    if (deployment.branch === FLAKY_BRANCH && attempt < maxAttempts) {
      throw new Error(`Fake build failure (branch "${FLAKY_BRANCH}" fails until the last attempt)`);
    }
    await ctx.log('INFO', 'Fake build completed');

    await ctx.setStage('DEPLOYING', 'Deployment is now deploying');
    await sleep(stepMs);
    await ctx.log('INFO', 'Fake deploy completed');

    await ctx.setStage('SUCCESS', 'Deployment completed successfully');
    return { status: 'SUCCESS' };
  };
}
