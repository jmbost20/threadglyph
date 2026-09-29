import { spawn } from 'child_process';
import type { ProcessRunner } from './claudeCli';

/**
 * Runs a local command with the request on stdin. The command and its fixed
 * arguments come from our code, never from note or model text, and no shell is
 * involved. Output is capped so a runaway process cannot exhaust memory.
 */
export const MAX_OUTPUT_CHARS = 2_000_000;

export const nodeRunner: ProcessRunner = (command, args, input, { cwd, timeoutMs, signal }) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const finish = (outcome: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish({ code: null, stdout, stderr, error: { code: err.code, message: err.message }, timedOut, aborted }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, aborted }));
    // A process that exits before reading its input closes the pipe; that is reported through 'close'.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
