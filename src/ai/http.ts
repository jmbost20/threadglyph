import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { Buffer } from 'buffer';

/**
 * A small HTTP client for local services such as Ollama. Node's own client is
 * used instead of `fetch` so requests are not subject to browser CORS rules and
 * can be cancelled. Responses are capped so a runaway server cannot exhaust memory.
 */

export const MAX_RESPONSE_CHARS = 2_000_000;

export interface HttpCall {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type HttpOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; reason: 'timeout' | 'aborted' | 'network'; message: string };

export type HttpFn = (call: HttpCall) => Promise<HttpOutcome>;

export const nodeHttp: HttpFn = ({ url, method = 'GET', body, timeoutMs, signal }) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: HttpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = send(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', message: `No answer within ${Math.round(timeoutMs / 1000)} seconds.` });
      req.destroy();
    }, timeoutMs);
    const onAbort = () => {
      finish({ ok: false, reason: 'aborted', message: 'Cancelled.' });
      req.destroy();
    };

    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (text.length < MAX_RESPONSE_CHARS) text += chunk;
      });
      res.on('end', () => finish({ ok: true, status: res.statusCode ?? 0, text }));
      res.on('error', (err) => finish({ ok: false, reason: 'network', message: err.message }));
    });
    // Registered before any destroy() below, so a cancelled request's socket error is always handled.
    req.on('error', (err: NodeJS.ErrnoException) =>
      finish({ ok: false, reason: 'network', message: err.code ? `${err.code}: ${err.message}` : err.message }),
    );
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    req.end(body);
  });
