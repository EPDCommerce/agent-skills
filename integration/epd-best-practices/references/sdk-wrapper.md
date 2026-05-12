# SDK wrapper — reusable HTTP client for EPD Commerce

Every EPD Commerce integration ends up with a thin wrapper that bakes in auth,
version pinning, idempotency on writes, and 5xx retry. Generate this once at
the start of the integration; every other call site stays clean.

## Required behaviors

A correct EPD Commerce HTTP wrapper must:

1. Read the API key from `process.env.EPD_API_KEY` (or equivalent). Never
   accept the key as a plaintext constructor argument that could end up in
   logs or stack traces.
2. Send `EPD-Version: 2026-02-11` on every request, sourced from a single
   constant so version bumps are one-line changes.
3. For POST / PATCH / DELETE requests, attach an `X-EPD-Idempotency-Key`
   header. If the caller supplied one, use it. Otherwise generate a UUID v4.
   Expose the resolved key on the response object so callers can log it for
   support tickets and retries.
4. On 5xx or network error, retry with the **same** idempotency key,
   exponential backoff, max 3 attempts.
5. On 4xx (except 409 `idempotency_key_in_use`), throw immediately — no retry.
6. Parse `error.request_id` from the response body and include it in any
   thrown error message. EPD Commerce support looks up requests by this ID.
7. Send and receive JSON. Do not URL-encode bodies — POST `application/json`.

## Node.js (TypeScript) — fetch + node:crypto

```ts
import { randomUUID } from 'node:crypto';

const EPD_BASE_URL = 'https://api.epd.com';
const EPD_API_VERSION = '2026-02-11';
const RETRY_STATUSES = new Set([500, 502, 503, 504]);

export class EpdError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly type: string,
    public readonly code: string,
    public readonly requestId: string | undefined,
    public readonly param?: string,
    public readonly fieldErrors?: Array<{ field: string; code: string; message: string }>,
  ) {
    super(`${message}${requestId ? ` (request_id: ${requestId})` : ''}`);
    this.name = 'EpdError';
  }
}

export interface EpdRequestInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
  idempotencyKey?: string;
}

export class EpdClient {
  constructor(private readonly apiKey = process.env.EPD_API_KEY) {
    if (!this.apiKey) throw new Error('EPD_API_KEY is required');
  }

  async request<T>(path: string, init: EpdRequestInit = {}): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const isWrite = method === 'POST' || method === 'PATCH' || method === 'DELETE';

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'EPD-Version': EPD_API_VERSION,
      Accept: 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };

    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    if (isWrite) {
      headers['X-EPD-Idempotency-Key'] = init.idempotencyKey ?? randomUUID();
    }

    const url = `${EPD_BASE_URL}${path}`;
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, { ...init, method, headers, body });

        if (res.ok) return (await res.json()) as T;

        const text = await res.text();
        let parsed: { error?: { type?: string; code?: string; message?: string; request_id?: string; param?: string; field_errors?: Array<{ field: string; code: string; message: string }> } } | undefined;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          /* non-JSON body */
        }

        const err = new EpdError(
          parsed?.error?.message ?? `HTTP ${res.status}`,
          res.status,
          parsed?.error?.type ?? 'unknown_error',
          parsed?.error?.code ?? 'unknown',
          parsed?.error?.request_id,
          parsed?.error?.param,
          parsed?.error?.field_errors,
        );

        const retriable =
          RETRY_STATUSES.has(res.status) ||
          (res.status === 409 && parsed?.error?.code === 'idempotency_key_in_use');

        if (!retriable || attempt === maxAttempts) throw err;
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
      } catch (e) {
        if (e instanceof EpdError) throw e;
        lastError = e;
        if (attempt === maxAttempts) break;
        await sleep(backoffMs(attempt, null));
      }
    }
    throw lastError;
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  return Math.min(2 ** attempt * 200, 5000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

Usage:

```ts
const epd = new EpdClient();

const customer = await epd.request<{ id: string }>('/v1/customers', {
  method: 'POST',
  body: {
    email: 'alice@example.com',
    first_name: 'Alice',
    last_name: 'Liddell',
    phone: '+14155551234',
  },
  idempotencyKey: 'signup-alice-2026-05-08',  // or omit to auto-generate
});
```

## Python — httpx

```python
import os
import time
import uuid
from typing import Any
import httpx

EPD_BASE_URL = "https://api.epd.com"
EPD_API_VERSION = "2026-02-11"
RETRY_STATUSES = {500, 502, 503, 504}


class EpdError(Exception):
    def __init__(self, message, status, type_, code, request_id, param=None, field_errors=None):
        self.status = status
        self.type = type_
        self.code = code
        self.request_id = request_id
        self.param = param
        self.field_errors = field_errors or []
        suffix = f" (request_id: {request_id})" if request_id else ""
        super().__init__(f"{message}{suffix}")


class EpdClient:
    def __init__(self, api_key: str | None = None, timeout: float = 30.0):
        self.api_key = api_key or os.environ["EPD_API_KEY"]
        self._client = httpx.Client(base_url=EPD_BASE_URL, timeout=timeout)

    def request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        is_write = method.upper() in ("POST", "PATCH", "DELETE")
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "EPD-Version": EPD_API_VERSION,
            "Accept": "application/json",
        }
        if is_write:
            headers["X-EPD-Idempotency-Key"] = idempotency_key or str(uuid.uuid4())

        for attempt in range(1, 4):
            try:
                res = self._client.request(method, path, json=json, params=params, headers=headers)
            except httpx.RequestError:
                if attempt == 3:
                    raise
                time.sleep(min(2 ** attempt * 0.2, 5))
                continue

            if res.is_success:
                return res.json()

            body = {}
            try:
                body = res.json()
            except ValueError:
                pass
            err = body.get("error", {})
            code = err.get("code", "unknown")
            retriable = res.status_code in RETRY_STATUSES or (
                res.status_code == 409 and code == "idempotency_key_in_use"
            )
            if not retriable or attempt == 3:
                raise EpdError(
                    err.get("message", f"HTTP {res.status_code}"),
                    res.status_code,
                    err.get("type", "unknown_error"),
                    code,
                    err.get("request_id"),
                    err.get("param"),
                    err.get("field_errors"),
                )
            retry_after = res.headers.get("retry-after")
            time.sleep(float(retry_after) if retry_after else min(2 ** attempt * 0.2, 5))
```

## PHP — Guzzle

```php
<?php

namespace App\Epd;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use Ramsey\Uuid\Uuid;

class EpdClient
{
    private const BASE_URL = 'https://api.epd.com';
    private const API_VERSION = '2026-02-11';
    private const RETRY_STATUSES = [500, 502, 503, 504];

    private Client $http;

    public function __construct(private string $apiKey = '')
    {
        $this->apiKey = $apiKey ?: ($_ENV['EPD_API_KEY'] ?? '');
        if (!$this->apiKey) {
            throw new \RuntimeException('EPD_API_KEY is required');
        }
        $this->http = new Client(['base_uri' => self::BASE_URL, 'timeout' => 30]);
    }

    public function request(string $method, string $path, array $opts = []): array
    {
        $isWrite = in_array(strtoupper($method), ['POST', 'PATCH', 'DELETE'], true);
        $headers = [
            'Authorization' => 'Bearer ' . $this->apiKey,
            'EPD-Version' => self::API_VERSION,
            'Accept' => 'application/json',
        ];
        if ($isWrite) {
            $headers['X-EPD-Idempotency-Key'] = $opts['idempotency_key'] ?? Uuid::uuid4()->toString();
        }

        for ($attempt = 1; $attempt <= 3; $attempt++) {
            try {
                $res = $this->http->request($method, $path, [
                    'headers' => $headers,
                    'json' => $opts['json'] ?? null,
                    'query' => $opts['query'] ?? null,
                    'http_errors' => false,
                ]);
                $status = $res->getStatusCode();
                $body = json_decode((string) $res->getBody(), true) ?? [];

                if ($status >= 200 && $status < 300) {
                    return $body;
                }

                $err = $body['error'] ?? [];
                $code = $err['code'] ?? 'unknown';
                $retriable = in_array($status, self::RETRY_STATUSES, true) ||
                             ($status === 409 && $code === 'idempotency_key_in_use');

                if (!$retriable || $attempt === 3) {
                    throw new EpdException(
                        $err['message'] ?? "HTTP {$status}",
                        $status,
                        $err['type'] ?? 'unknown_error',
                        $code,
                        $err['request_id'] ?? null,
                        $err['param'] ?? null,
                        $err['field_errors'] ?? [],
                    );
                }
                $retryAfter = $res->getHeaderLine('Retry-After');
                usleep($retryAfter ? (int) $retryAfter * 1_000_000 : min(2 ** $attempt * 200_000, 5_000_000));
            } catch (ConnectException $e) {
                if ($attempt === 3) {
                    throw $e;
                }
                usleep(min(2 ** $attempt * 200_000, 5_000_000));
            }
        }

        throw new \LogicException('unreachable');
    }
}
```

(Define `EpdException` extending `\RuntimeException` with the same fields as
the Node `EpdError` for parity.)

## A note on official SDKs

EPD Commerce does not currently publish official client libraries. Generate
one of the wrappers above for the dev's stack and treat it as the
integration's authoritative HTTP layer. If/when official SDKs ship, this
skill will note the migration path.
