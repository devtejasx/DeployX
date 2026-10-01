import { DescribeImagesCommand, DescribeRepositoriesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { UnrecoverableError } from 'bullmq';
import config from '../config/index.js';
import { awsClientOptions, awsError } from '../lib/awsErrors.js';
import * as dockerService from './dockerService.js';

// Amazon ECR: where AWS_ECS deployments' images are stored.
//
// Every image is pushed to the one configured repository (AWS_ECR_REPOSITORY)
// under two tags, the ECR counterparts of the local image tags:
//   <project>-<project-id-prefix>-<commit-sha-12>        which commit it is
//   <project>-<project-id-prefix>-deployment-<id>        which deployment built it
// A tag can move when a commit is built again; the manifest digest ECR reports
// for the pushed image cannot. ECS runs the image by that digest, and a
// rollback restores it by digest, so what runs is always exactly what was built.
//
// `client` is an ECRClient (replaced by a fake in tests), `docker` the Docker
// service that tags, logs in and pushes.
export function createEcrService({ client, docker = dockerService, repository = config.aws.ecrRepository } = {}) {
  let ecr = client;
  const ecrClient = () => (ecr ??= new ECRClient(awsClientOptions()));

  async function send(operation, command) {
    try {
      return await ecrClient().send(command);
    } catch (err) {
      throw awsError(`ECR ${operation}`, err);
    }
  }

  // <account>.dkr.ecr.<region>.amazonaws.com/<repository>
  async function repositoryUri() {
    const { repositories } = await send(
      'DescribeRepositories',
      new DescribeRepositoriesCommand({ repositoryNames: [repository] }),
    );
    const uri = repositories?.[0]?.repositoryUri;
    if (!uri) throw new UnrecoverableError(`ECR repository ${repository} was not found`);
    return uri;
  }

  // The digest (sha256:...) of the image with this tag or digest, or null.
  async function findDigest(imageId) {
    try {
      const { imageDetails } = await ecrClient().send(
        new DescribeImagesCommand({ repositoryName: repository, imageIds: [imageId] }),
      );
      return imageDetails?.[0]?.imageDigest ?? null;
    } catch (err) {
      if (err.name === 'ImageNotFoundException') return null;
      throw awsError('ECR DescribeImages', err);
    }
  }

  return {
    repository,
    repositoryUri,

    // Logs Docker in to the registry with a 12-hour ECR token. Returns the
    // repository URI.
    async login() {
      const uri = await repositoryUri();
      const { authorizationData } = await send('GetAuthorizationToken', new GetAuthorizationTokenCommand({}));
      const token = authorizationData?.[0]?.authorizationToken;
      if (!token) throw new Error('ECR returned no authorization token');
      // "AWS:<password>"
      const credentials = Buffer.from(token, 'base64').toString('utf8');
      const separator = credentials.indexOf(':');
      await docker.registryLogin({
        registry: uri.split('/')[0],
        username: credentials.slice(0, separator),
        password: credentials.slice(separator + 1),
      });
      return uri;
    },

    // Pushes local `image` as <uri>:<tag> for each of `tags` (the first one is
    // the image's name) and returns { reference, digest }.
    async push(image, tags, { onLine } = {}) {
      const uri = await repositoryUri();
      for (const tag of tags) {
        await docker.tagImage(image, `${uri}:${tag}`);
        await docker.pushImage(`${uri}:${tag}`, { onLine });
      }
      const digest = await findDigest({ imageTag: tags[0] });
      if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
        throw new Error(`ECR has no image tagged ${tags[0]} after the push`);
      }
      return { reference: `${uri}:${tags[0]}`, digest };
    },

    // Whether the image with this digest is still in the repository (a
    // lifecycle policy or a person may have deleted it).
    async imageExists(digest) {
      return (await findDigest({ imageDigest: digest })) !== null;
    },
  };
}
