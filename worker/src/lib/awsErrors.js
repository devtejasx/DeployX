import { UnrecoverableError } from 'bullmq';

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
