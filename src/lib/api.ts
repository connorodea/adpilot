import fetch from 'node-fetch';
import { getConfig, getToken } from './config';
import { ApiError } from '../utils/errors';
import { isLoggingEnabled, logApiCall, sanitizeParams } from './logger';

const BASE_URL = 'https://graph.facebook.com';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(code: number, subcode?: number): boolean {
  return RATE_LIMIT_CODES.has(code) || (subcode !== undefined && RATE_LIMIT_CODES.has(subcode));
}

export interface ApiResponse<T = any> {
  data?: T[];
  paging?: {
    cursors?: { before: string; after: string };
    next?: string;
    previous?: string;
  };
  id?: string;
  success?: boolean;
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
  [key: string]: any;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  params?: Record<string, any>;
  body?: Record<string, any>;
  token?: string;
}

function buildUrl(endpoint: string, params: Record<string, any> = {}): string {
  const { apiVersion } = getConfig();
  const base = endpoint.startsWith('http')
    ? endpoint
    : `${BASE_URL}/${apiVersion}/${endpoint.replace(/^\//, '')}`;
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      );
    }
  }
  return url.toString();
}

export async function apiRequest<T = any>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const { method = 'GET', params = {}, body, token } = options;
  const accessToken = token || getToken();

  const allParams = { ...params, access_token: accessToken };

  let url: string;
  let fetchOptions: any = { method };

  if (method === 'GET' || method === 'DELETE') {
    url = buildUrl(endpoint, allParams);
  } else {
    url = buildUrl(endpoint);
    const formBody = new URLSearchParams();
    const merged = { ...allParams, ...body };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined && value !== null) {
        formBody.set(
          key,
          typeof value === 'object' ? JSON.stringify(value) : String(value)
        );
      }
    }
    fetchOptions.body = formBody;
    fetchOptions.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  const shouldLog = isLoggingEnabled();
  let lastError: ApiError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    const response = await fetch(url, fetchOptions);
    const data = (await response.json()) as ApiResponse<T>;
    const durationMs = Date.now() - startTime;

    if (data.error) {
      const err = data.error;
      const errorMsg = `[${err.code}] ${err.type}: ${err.message}${
        err.error_subcode ? ` (subcode: ${err.error_subcode})` : ''
      }`;

      if (shouldLog) {
        logApiCall({
          timestamp: new Date().toISOString(),
          method,
          endpoint,
          params: sanitizeParams(params),
          status: 'error',
          error: errorMsg,
          durationMs,
        });
      }

      if (isRateLimitError(err.code, err.error_subcode) && attempt < MAX_RETRIES) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        process.stderr.write(
          `Rate limited (code ${err.code}). Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...\n`
        );
        await sleep(delayMs);
        lastError = new ApiError(errorMsg);
        continue;
      }

      throw new ApiError(errorMsg);
    }

    if (shouldLog) {
      logApiCall({
        timestamp: new Date().toISOString(),
        method,
        endpoint,
        params: sanitizeParams(params),
        status: 'success',
        responseId: data.id,
        durationMs,
      });
    }

    return data;
  }

  // Should only be reached if all retries exhausted (guarded above, but satisfies TS)
  throw lastError || new ApiError('Request failed after maximum retries.');
}

export async function apiGet<T = any>(
  endpoint: string,
  params: Record<string, any> = {},
  token?: string
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'GET', params, token });
}

export async function apiPost<T = any>(
  endpoint: string,
  body: Record<string, any> = {},
  params: Record<string, any> = {},
  token?: string
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'POST', body, params, token });
}

export async function apiDelete<T = any>(
  endpoint: string,
  params: Record<string, any> = {},
  token?: string
): Promise<ApiResponse<T>> {
  return apiRequest<T>(endpoint, { method: 'DELETE', params, token });
}

export async function fetchAllPages<T = any>(
  endpoint: string,
  params: Record<string, any> = {},
  maxPages = 10
): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | undefined;
  let page = 0;

  const firstResponse = await apiGet<T>(endpoint, params);
  if (firstResponse.data) results.push(...firstResponse.data);
  nextUrl = firstResponse.paging?.next;

  while (nextUrl && page < maxPages - 1) {
    page++;
    const response = await apiRequest<T>(nextUrl.replace(`${BASE_URL}/`, ''));
    if (response.data) results.push(...response.data);
    nextUrl = response.paging?.next;
  }

  return results;
}
