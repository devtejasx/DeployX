import { z } from 'zod';
import { ApiError } from '../utils/ApiError.js';

function formatIssues(issues) {
  return issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return `Unknown or read-only field(s): ${issue.keys.join(', ')}`;
    }
    return issue.message;
  });
}

// Validates req.params and/or req.body against zod schemas. The parsed body
// (trimmed, defaults applied, unknown fields rejected) replaces req.body, so
// controllers only ever see validated data.
export function validate({ params, body }) {
  return (req, res, next) => {
    if (params) {
      const result = params.safeParse(req.params);
      if (!result.success) {
        throw ApiError.badRequest('Validation failed', formatIssues(result.error.issues));
      }
    }

    if (body) {
      if (req.body === undefined || req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw ApiError.badRequest('Validation failed', ['Request body must be a JSON object']);
      }
      const result = body.safeParse(req.body);
      if (!result.success) {
        throw ApiError.badRequest('Validation failed', formatIssues(result.error.issues));
      }
      req.body = result.data;
    }

    next();
  };
}

// Route parameter that must be a UUID, e.g. uuidParams({ id: 'project' }).
export function uuidParams(labels) {
  const shape = {};
  for (const [param, label] of Object.entries(labels)) {
    shape[param] = z.uuid({ error: `Invalid ${label} ID` });
  }
  return z.object(shape);
}
