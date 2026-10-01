import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';

// Options of every AWS SDK client of the worker: bounded connection and
// request times (the SDK has none by default) and the SDK's own retries for
// throttling and transient errors. Credentials come from the default chain
// (an IAM role preferably), never from here.
export function awsClientOptions() {
  return {
    region: config.aws.region,
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: config.aws.connectionTimeoutMs,
      requestTimeout: config.aws.requestTimeoutMs,
    },
  };
}

// AWS errors that another attempt cannot fix: missing or wrong credentials,
// missing permissions, resources that do not exist, invalid requests. The
// deployment fails at once instead of being retried.
const PERMANENT_ERRORS = new Set([
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'CredentialsProviderError',
  'ExpiredTokenException',
  'ClientException',
  'InvalidParameterException',
  'ValidationException',
  'ClusterNotFoundException',
  'ServiceNotFoundException',
  'ServiceNotActiveException',
  'RepositoryNotFoundException',
  'PlatformUnknownException',
  'PlatformTaskDefinitionIncompatibilityException',
]);

// `err` from an AWS SDK call, as a readable error for the deployment:
//   "ECS UpdateService failed: ServiceNotFoundException: Service not found."
// Throttling, AWS server errors and network problems stay retryable. The
// message only carries what AWS returned - never credentials.
export function awsError(operation, err) {
  const name = err?.name && err.name !== 'Error' ? `${err.name}: ` : '';
  const message = `${operation} failed: ${name}${err?.message ?? 'unknown error'}`.slice(0, 1000);
  return PERMANENT_ERRORS.has(err?.name) ? new UnrecoverableError(message) : new Error(message);
}
