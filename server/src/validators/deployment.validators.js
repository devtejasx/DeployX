import { z } from 'zod';
import { branchField, enumField, stringField } from './common.js';

export const DEPLOYMENT_STATUSES = ['QUEUED', 'BUILDING', 'DEPLOYING', 'HEALTH_CHECK', 'SUCCESS', 'FAILED'];

// Abbreviated (7+) or full (40) hex commit hash, stored lower-case.
const commitSha = stringField('Commit SHA')
  .trim()
  .regex(/^[0-9a-fA-F]{7,40}$/, { error: 'Commit SHA must be 7-40 hexadecimal characters' })
  .transform((sha) => sha.toLowerCase());

// Status is not accepted here: every new deployment starts as QUEUED.
// branch defaults to the project's configured branch.
export const createDeploymentSchema = z.strictObject({
  commit_sha: commitSha.optional(),
  branch: branchField('Branch').optional(),
});

export const updateDeploymentStatusSchema = z.strictObject({
  status: enumField('Deployment status', DEPLOYMENT_STATUSES),
});
