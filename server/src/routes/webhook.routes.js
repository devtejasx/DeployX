import express, { Router } from 'express';
import * as webhookController from '../controllers/webhook.controller.js';

// GitHub sends push payloads of up to 25 MB; pushes of ordinary size are far
// below this, and anything larger is refused with 413.
const WEBHOOK_BODY_LIMIT = '5mb';

// Mounted at /api/webhooks, BEFORE the JSON body parser: the signature covers
// the exact bytes GitHub sent, so the body is kept raw (whatever its content
// type) and only parsed once the signature has been verified.
//
// Not behind devUser: webhooks act for a repository, and are authenticated by
// their signature instead.
const router = Router();

router.post(
  '/github',
  express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  webhookController.receiveGitHubWebhook,
);

export default router;
