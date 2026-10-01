import crypto from 'node:crypto';
import { z } from 'zod';
import config from '../config/index.js';
import { ApiError } from '../utils/ApiError.js';
import { parseGitHubRepo } from '../utils/github.js';
import { branchField } from '../validators/common.js';
import { queueDeployment } from './deployment.service.js';
import { findProjectsByRepository } from './project.service.js';
import { logger } from '../lib/logger.js';

// GitHub push webhooks -> deployments.
//
//   GitHub ── POST /api/webhooks/github ──> verify signature ──> parse push
//     ──> repository -> projects ──> branch filter ──> queueDeployment()
//
// The webhook never builds or deploys anything itself: it creates deployments
// through queueDeployment(), exactly like a manual deployment, and the worker
// picks them up from the same BullMQ queue.

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;
const EVENT_PATTERN = /^[a-z_]{1,64}$/;
const DELIVERY_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const BRANCH_REF_PREFIX = 'refs/heads/';
const ZERO_SHA = '0'.repeat(40);
const branchName = branchField('Branch');

// The fields of a push event DeployX uses; everything else is ignored.
// https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
const pushPayloadSchema = z.object({
  ref: z.string().max(1024),
  after: z.string().regex(/^[0-9a-f]{40}$/, { error: 'after must be a 40-character commit SHA' }),
  deleted: z.boolean().optional(),
  repository: z.object({
    html_url: z.string().max(2048),
    full_name: z.string().max(512),
  }),
  head_commit: z.object({ message: z.string() }).nullish(),
});

// X-Hub-Signature-256 is "sha256=" + the hex HMAC-SHA256 of the raw request
// body, keyed with the webhook secret. Compared in constant time.
export function verifyGitHubSignature(secret, rawBody, header) {
  const match = typeof header === 'string' ? header.match(SIGNATURE_PATTERN) : null;
  if (!secret || !match) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(match[1], 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// First line of a commit message, safe to store as one log line.
function commitSummary(message) {
  const line = (message ?? '').split('\n', 1)[0].replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function ignoredPush(data, reason) {
  return { statusCode: 200, data: { ...data, deployments: [], ignored: [], message: reason } };
}

// Handles one webhook delivery. Returns { statusCode, data } for the response;
// throws ApiError for deliveries that are refused:
//   503  GITHUB_WEBHOOK_SECRET is not configured
//   401  signature missing or invalid
//   400  missing event, malformed JSON, invalid push payload, unsupported event
//   415  not JSON
//   404  no project uses the repository
export async function handleGitHubDelivery({ event, deliveryId, signature, contentType, body }) {
  const secret = config.github.webhookSecret;
  if (!secret) {
    throw new ApiError(503, 'GitHub webhooks are not configured on this server');
  }
  if (!signature) {
    throw new ApiError(401, 'Missing X-Hub-Signature-256 header');
  }
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  if (!verifyGitHubSignature(secret, rawBody, signature)) {
    throw new ApiError(401, 'Invalid webhook signature');
  }

  // From here on the delivery is known to come from GitHub (or whoever holds
  // the secret); its content is still validated before it is used.
  if (!event) throw ApiError.badRequest('Missing X-GitHub-Event header');
  if (!/^application\/json\b/i.test(contentType ?? '')) {
    throw new ApiError(415, 'Webhook payload must be JSON: set the webhook content type to application/json');
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw ApiError.badRequest('Malformed JSON payload');
  }

  if (event === 'ping') {
    return { statusCode: 200, data: { event, message: 'Webhook is configured' } };
  }
  if (event !== 'push') {
    const name = EVENT_PATTERN.test(event) ? ` "${event}"` : '';
    throw ApiError.badRequest(`Unsupported GitHub event${name}: only push events are handled`);
  }

  const parsed = pushPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw ApiError.badRequest(
      'Invalid push payload',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`),
    );
  }
  const push = parsed.data;
  const delivery = DELIVERY_PATTERN.test(deliveryId ?? '') ? deliveryId : null;

  const repository = parseGitHubRepo(push.repository.html_url);
  if (!repository) {
    throw ApiError.notFound('The pushed repository is not a github.com repository');
  }
  const summary = { event, delivery, repository: `${repository.owner}/${repository.name}` };

  if (!push.ref.startsWith(BRANCH_REF_PREFIX)) {
    return ignoredPush(summary, 'Not a branch push: only branches are deployed');
  }
  const branch = push.ref.slice(BRANCH_REF_PREFIX.length);
  if (!branchName.safeParse(branch).success) {
    throw ApiError.badRequest('Invalid push payload', ['ref: not a valid branch name']);
  }
  Object.assign(summary, { branch, commit_sha: push.after });
  if (push.deleted || push.after === ZERO_SHA) {
    return ignoredPush(summary, `Branch ${branch} was deleted: nothing to deploy`);
  }

  const projects = await findProjectsByRepository(repository.url);
  if (projects.length === 0) {
    throw ApiError.notFound(`No DeployX project uses repository ${summary.repository}`);
  }

  const commit = commitSummary(push.head_commit?.message);
  const deployments = [];
  const ignored = [];
  for (const project of projects) {
    if (project.github_branch !== branch) {
      ignored.push({ project_id: project.id, reason: `Project deploys branch ${project.github_branch}, not ${branch}` });
      continue;
    }
    if (project.status !== 'ACTIVE') {
      ignored.push({ project_id: project.id, reason: 'Project is inactive' });
      continue;
    }
    const { deployment, duplicate } = await queueDeployment(project, {
      commitSha: push.after,
      branch,
      trigger: 'GITHUB_PUSH',
      logLines: [
        `GitHub webhook received: push to ${branch}${delivery ? ` (delivery ${delivery})` : ''}`,
        `Repository identified: ${summary.repository}, deploying branch ${branch}`,
        `Commit identified: ${push.after}${commit ? ` (${commit})` : ''}`,
      ],
    });
    deployments.push({ project_id: project.id, deployment_id: deployment.id, duplicate });
  }

  const queued = deployments.filter((deployment) => !deployment.duplicate).length;
  logger.info('webhook_push', {
    repository: summary.repository,
    branch,
    commitSha: push.after,
    delivery,
    queued,
    duplicates: deployments.length - queued,
    ignored: ignored.length,
  });

  const message =
    deployments.length === 0
      ? `No project deploys branch ${branch}: push ignored`
      : queued === 0
        ? 'Already deployed: this commit was received before'
        : `${queued} deployment${queued === 1 ? '' : 's'} queued`;
  return { statusCode: queued > 0 ? 202 : 200, data: { ...summary, deployments, ignored, message } };
}
