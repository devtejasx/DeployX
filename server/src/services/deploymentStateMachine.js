import { query } from '../db/postgres.js';
import { ApiError } from '../utils/ApiError.js';

// SQLSTATE raised by the database trigger for a transition that is not in
// deployment_status_transitions (see migration 1790671094193).
export const INVALID_TRANSITION = 'DX001';

// The API's only way to change a deployment's status. The transition map and
// the timestamp rules live in PostgreSQL (transition_deployment_status), so
// the API and the worker share exactly one definition.
//
// Returns the updated deployment row, or null if it does not exist. An
// invalid transition becomes a 409 with { from, to }.
export async function transitionDeploymentStatus(deploymentId, newStatus, { errorMessage = null } = {}) {
  try {
    const { rows } = await query('SELECT * FROM transition_deployment_status($1, $2, $3)', [
      deploymentId,
      newStatus,
      errorMessage,
    ]);
    return rows[0] ?? null;
  } catch (err) {
    if (err.code === INVALID_TRANSITION) {
      const { from, to } = JSON.parse(err.detail);
      throw new ApiError(409, 'Invalid deployment state transition', undefined, { from, to }, 'INVALID_STATE_TRANSITION');
    }
    throw err;
  }
}
