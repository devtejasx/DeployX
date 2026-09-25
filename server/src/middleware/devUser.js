import config from '../config/index.js';
import { findOrCreateUserByEmail } from '../services/user.service.js';

// TEMPORARY - Phase 2 has no authentication.
//
// Every request is treated as coming from a single development user
// (DEV_USER_EMAIL / DEV_USER_NAME), created on first use. Services already
// scope data by req.user.id, so real authentication can replace this
// middleware later without touching them.
export async function devUser(req, res, next) {
  req.user = await findOrCreateUserByEmail(config.devUser);
  next();
}
