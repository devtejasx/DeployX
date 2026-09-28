import { spawn } from 'node:child_process';

// Variables a child process (git, docker) may inherit. Everything else -
// DATABASE_URL, REDIS_URL and any other secret in the worker's environment -
// is withheld, so it can never leak into a clone, a build or a log.
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  // Windows: needed for process startup and to find Docker CLI plugins.
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'ProgramFiles',
  'ProgramData',
  'APPDATA',
  'LOCALAPPDATA',
  // Where to reach Docker (e.g. the socket proxy in Docker Compose).
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
];

export function childEnv(extra = {}) {
  const env = {};
  for (const name of INHERITED_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

export class CommandError extends Error {
  constructor(message, { code = null, timedOut = false, tail = [] } = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.timedOut = timedOut;
    this.tail = tail;
  }
}

// Runs `command` with `args` WITHOUT a shell. Arguments go to the program
// verbatim, so user-controlled values (branch names, paths) can never be
// interpreted as shell syntax.
//
// Output is split into lines and passed to `onLine(line, stream)`; the last
// `tailSize` lines are kept for error reporting. Resolves with the exit code
// (non-zero is not an error here) and throws CommandError if the program
// cannot be started or exceeds `timeoutMs`.
export function runCommand(command, args, { cwd, env = childEnv(), timeoutMs = 60000, onLine, tailSize = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const tail = [];
    const stdoutChunks = [];
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function lineReader(stream, name) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (name === 'stdout') stdoutChunks.push(chunk);
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop();
        for (const line of lines) handleLine(line, name);
      });
      stream.on('end', () => {
        if (pending) handleLine(pending, name);
      });
    }

    function handleLine(line, name) {
      if (line.trim() === '') return;
      tail.push(line);
      if (tail.length > tailSize) tail.shift();
      onLine?.(line, name);
    }

    lineReader(child.stdout, 'stdout');
    lineReader(child.stderr, 'stderr');

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new CommandError(`Could not run ${command}: ${err.message}`, { tail }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new CommandError(`${command} ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)}s`, {
            timedOut: true,
            tail,
          }),
        );
        return;
      }
      resolve({ code, stdout: stdoutChunks.join(''), tail });
    });
  });
}
