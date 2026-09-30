// Builds and sends GitHub webhook deliveries the way GitHub does: a JSON body
// signed with HMAC-SHA256 (X-Hub-Signature-256), plus the event and delivery
// headers. Used by the webhook tests and the AWS end-to-end tests.
import crypto from 'node:crypto';

export const WEBHOOK_SECRET = 'test-webhook-secret-7d1f0b';

export function sign(body, secret = WEBHOOK_SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function randomSha() {
  return crypto.randomBytes(20).toString('hex');
}

// A push event as GitHub sends it (the fields DeployX reads, and a few more).
export function pushPayload({ repo = 'https://github.com/example/my-api', branch = 'main', sha = randomSha(), message = 'Update the app' } = {}) {
  const [owner, name] = new URL(repo).pathname.slice(1).split('/');
  return {
    ref: `refs/heads/${branch}`,
    before: randomSha(),
    after: sha,
    created: false,
    deleted: false,
    forced: false,
    compare: `https://github.com/${owner}/${name}/compare/abc...def`,
    repository: {
      id: 123456,
      name,
      full_name: `${owner}/${name}`,
      html_url: `https://github.com/${owner}/${name}`,
      clone_url: `https://github.com/${owner}/${name}.git`,
      default_branch: 'main',
      private: false,
    },
    pusher: { name: 'octocat', email: 'octocat@example.com' },
    head_commit: {
      id: sha,
      message,
      timestamp: '2026-09-30T10:00:00Z',
      author: { name: 'Octo Cat', email: 'octocat@example.com' },
    },
    commits: [{ id: sha, message }],
  };
}

// POSTs a delivery to /api/webhooks/github. `signature: null` leaves the
// signature header out; `rawBody` replaces the JSON-encoded payload.
export async function sendWebhook(
  baseUrl,
  {
    event = 'push',
    payload,
    rawBody,
    secret = WEBHOOK_SECRET,
    signature,
    contentType = 'application/json',
    delivery = crypto.randomUUID(),
  } = {},
) {
  const body = rawBody ?? JSON.stringify(payload);
  const headers = { 'User-Agent': 'GitHub-Hookshot/deployx-test' };
  if (event !== null) headers['X-GitHub-Event'] = event;
  if (delivery !== null) headers['X-GitHub-Delivery'] = delivery;
  if (contentType !== null) headers['Content-Type'] = contentType;
  const signatureHeader = signature === undefined ? sign(body, secret) : signature;
  if (signatureHeader !== null) headers['X-Hub-Signature-256'] = signatureHeader;

  const response = await fetch(`${baseUrl}/api/webhooks/github`, { method: 'POST', headers, body });
  return { status: response.status, body: await response.json() };
}
