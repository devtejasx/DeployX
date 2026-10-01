import { recordAudit } from '../services/audit.service.js';
import * as githubWebhookService from '../services/githubWebhook.service.js';
import { sendSuccess } from '../utils/response.js';

// POST /api/webhooks/github. 202 when deployments were queued, 200 when the
// delivery was valid but nothing had to be deployed (ping, other branch,
// duplicate delivery). req.body is the raw request body (a Buffer).
//
// Push deliveries and refused signatures are audited (never the signature or
// the secret itself).
export async function receiveGitHubWebhook(req, res) {
  let result;
  try {
    result = await githubWebhookService.handleGitHubDelivery({
      event: req.get('X-GitHub-Event'),
      deliveryId: req.get('X-GitHub-Delivery'),
      signature: req.get('X-Hub-Signature-256'),
      contentType: req.get('Content-Type'),
      body: req.body,
    });
  } catch (err) {
    if (err.statusCode === 401) {
      await recordAudit({ req, action: 'webhook.rejected', details: { reason: err.message } });
    }
    throw err;
  }

  const { statusCode, data } = result;
  if (data.repository && data.commit_sha) {
    await recordAudit({
      req,
      action: 'webhook.push',
      targetType: 'repository',
      targetId: data.repository,
      details: {
        delivery: data.delivery,
        branch: data.branch,
        commit_sha: data.commit_sha,
        deployments: data.deployments.map(({ deployment_id: id, duplicate }) => ({ id, duplicate })),
        ignored: data.ignored.length,
      },
    });
  }
  sendSuccess(res, data, statusCode);
}
