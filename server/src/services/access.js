import { ApiError } from '../utils/ApiError.js';

// Authorization rules, enforced by the services for every request (hiding a
// button in the dashboard is never what protects anything):
//
//   ADMIN  every project and deployment, and the operator endpoints
//          (manual status changes, raw log lines, every audit entry)
//   USER   only the projects it owns, and their deployments and logs
//
// A resource that does not exist is 404; one that exists but belongs to
// someone else is 403. Project and deployment IDs are random UUIDs, so the
// distinction does not help anyone find other users' resources.

export function isAdmin(user) {
  return user?.role === 'ADMIN';
}

export function canAccess(user, ownerId) {
  return isAdmin(user) || (Boolean(user?.id) && ownerId === user.id);
}

// Throws 403 unless `user` may reach a resource owned by `ownerId`.
export function assertAccess(user, ownerId, what) {
  if (!canAccess(user, ownerId)) {
    throw new ApiError(403, `You do not have access to this ${what}`);
  }
}
