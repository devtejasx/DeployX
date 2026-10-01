import { Queue } from 'bullmq';
import config from '../config/index.js';
import redisConnection from '../db/redis.js';
import { logger } from '../lib/logger.js';

// Shared with the worker (worker/src/config/index.js): both sides must agree
// on the queue name, job name and key prefix.
export const DEPLOYMENT_QUEUE_NAME = 'deployments';
export const DEPLOY_JOB_NAME = 'deploy';

const ADD_TIMEOUT_MS = 3000;

let queue = null;

// Created on first use so that importing the app (e.g. in tests) does not
// touch Redis until a deployment is actually queued.
export function getDeploymentQueue() {
  if (!queue) {
    queue = new Queue(DEPLOYMENT_QUEUE_NAME, {
      connection: redisConnection,
      prefix: config.queue.prefix,
      defaultJobOptions: {
        attempts: config.queue.attempts,
        backoff: { type: 'exponential', delay: config.queue.backoffMs },
        // Keep finished jobs for inspection, but not forever.
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    });
    queue.on('error', (err) => {
      logger.error('queue_error', { err });
    });
  }
  return queue;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Adds a deployment job. The BullMQ job ID is the deployment ID, so a
// deployment can only have one job at a time: adding it again while the
// previous job is still stored returns the existing job instead of a copy.
//
// The payload holds identifiers only - no credentials or secrets.
export async function enqueueDeployment(deployment) {
  const data = {
    deploymentId: deployment.id,
    projectId: deployment.project_id,
    commitSha: deployment.commit_sha,
    branch: deployment.branch,
  };

  return withTimeout(
    getDeploymentQueue().add(DEPLOY_JOB_NAME, data, { jobId: deployment.id }),
    ADD_TIMEOUT_MS,
    'Timed out adding deployment job to the queue',
  );
}

// Closes the queue. The Redis connection itself is shared and closed by
// closeRedis().
export async function closeDeploymentQueue() {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
