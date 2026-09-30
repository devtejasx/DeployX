import * as dockerService from '../services/dockerService.js';
import { createAwsEcsTarget } from './awsEcsTarget.js';
import { createLocalDockerTarget } from './localDockerTarget.js';

// The deployment targets, by the name stored in deployments.deployment_target.
// AWS clients are only created when an AWS_ECS deployment actually runs.
export function createTargets({ docker = dockerService, ecr, ecs } = {}) {
  const local = createLocalDockerTarget({ docker });
  return {
    LOCAL: local,
    AWS_ECS: createAwsEcsTarget({ ecr, ecs, docker, local }),
  };
}
