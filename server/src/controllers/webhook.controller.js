import * as githubWebhookService from '../services/githubWebhook.service.js';
import { sendSuccess } from '../utils/response.js';

// POST /api/webhooks/github. 202 when deployments were queued, 200 when the
// delivery was valid but nothing had to be deployed (ping, other branch,
// duplicate delivery). req.body is the raw request body (a Buffer).
export async function receiveGitHubWebhook(req, res) {
  const { statusCode, data } = await githubWebhookService.handleGitHubDelivery({
    event: req.get('X-GitHub-Event'),
    deliveryId: req.get('X-GitHub-Delivery'),
    signature: req.get('X-Hub-Signature-256'),
    contentType: req.get('Content-Type'),
    body: req.body,
  });
  sendSuccess(res, data, statusCode);
}
