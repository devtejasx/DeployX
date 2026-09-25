import { z } from 'zod';

// A string field with readable "is required" / "must be a string" messages.
export function stringField(label) {
  return z.string({
    error: (issue) => (issue.input === undefined ? `${label} is required` : `${label} must be a string`),
  });
}

// One of a fixed set of values, e.g. deployment statuses.
export function enumField(label, values) {
  return z.enum(values, {
    error: (issue) =>
      issue.input === undefined
        ? `${label} is required`
        : `${label} must be one of: ${values.join(', ')}`,
  });
}

// Simplified `git check-ref-format`: letters, digits, . _ / -, no "..", "//"
// or "/.", not starting with - / . and not ending with / . or ".lock".
const BRANCH_PATTERN = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![/.])$/;

export function branchField(label = 'Branch') {
  return stringField(label)
    .trim()
    .min(1, { error: `${label} is required` })
    .max(255, { error: `${label} must be at most 255 characters` })
    .regex(BRANCH_PATTERN, { error: `${label} is not a valid git branch name` });
}
