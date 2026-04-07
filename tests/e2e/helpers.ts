import { execFile } from 'child_process';
import path from 'path';

// ---------------------------------------------------------------------------
// 1. runCli — spawn the compiled CLI as a child process
// ---------------------------------------------------------------------------

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCli(args: string[]): Promise<CliResult> {
  const entry = path.resolve(__dirname, '../../dist/index.js');

  return new Promise((resolve) => {
    execFile(
      'node',
      [entry, ...args],
      {
        timeout: 10_000,
        env: {
          ...process.env,
          ADPILOT_TOKEN: 'test-token-e2e',
          HOME: '/tmp/adpilot-e2e-test',
        },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: error ? (error as any).code ?? 1 : 0,
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 2. mockFetchResponse — build a fake Response-like object
// ---------------------------------------------------------------------------

export function mockFetchResponse(body: any, status: number = 200) {
  return {
    json: () => Promise.resolve(body),
    status,
    ok: status >= 200 && status < 300,
  };
}

// ---------------------------------------------------------------------------
// 3. Fixture data constants
// ---------------------------------------------------------------------------

export const MOCK_CAMPAIGNS = {
  data: [
    {
      id: '123456',
      name: 'Test Campaign 1',
      objective: 'OUTCOME_TRAFFIC',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      daily_budget: '5000',
      lifetime_budget: null,
      budget_remaining: '3200',
      created_time: '2024-01-15T10:00:00+0000',
    },
    {
      id: '789012',
      name: 'Test Campaign 2',
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      daily_budget: null,
      lifetime_budget: '100000',
      budget_remaining: '45000',
      created_time: '2024-02-20T14:30:00+0000',
    },
  ],
};

export const MOCK_ADSETS = {
  data: [
    {
      id: 'as_001',
      name: 'Test AdSet 1',
      campaign_id: '123456',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      daily_budget: '2000',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'REACH',
      targeting: { geo_locations: { countries: ['US'] } },
    },
    {
      id: 'as_002',
      name: 'Test AdSet 2',
      campaign_id: '123456',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      daily_budget: '3000',
      billing_event: 'LINK_CLICKS',
      optimization_goal: 'LINK_CLICKS',
      targeting: { geo_locations: { countries: ['GB'] } },
    },
  ],
};

export const MOCK_ADS = {
  data: [
    {
      id: 'ad_001',
      name: 'Test Ad 1',
      adset_id: 'as_001',
      campaign_id: '123456',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      creative: { id: 'cr_001' },
    },
    {
      id: 'ad_002',
      name: 'Test Ad 2',
      adset_id: 'as_001',
      campaign_id: '123456',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      creative: { id: 'cr_002' },
    },
  ],
};

export const MOCK_INSIGHTS = {
  data: [
    {
      impressions: '15234',
      clicks: '423',
      spend: '52.17',
      cpc: '0.12',
      cpm: '3.42',
      ctr: '2.78',
      reach: '12500',
      frequency: '1.22',
      date_start: '2024-03-01',
      date_stop: '2024-03-07',
      campaign_name: 'Test Campaign 1',
      actions: [
        { action_type: 'link_click', value: '423' },
        { action_type: 'landing_page_view', value: '389' },
      ],
    },
  ],
};

export const MOCK_CREATIVES = {
  data: [
    {
      id: 'cr_001',
      name: 'Creative 1',
      status: 'ACTIVE',
      title: 'Buy Now',
      body: 'Great deals',
      object_story_spec: {},
    },
  ],
};

export const MOCK_ME = { id: '10001', name: 'Test User' };

export const MOCK_ACCOUNT_INFO = {
  id: 'act_123456',
  name: 'Test Ad Account',
  account_id: '123456',
  account_status: 1,
  currency: 'USD',
  timezone_name: 'America/New_York',
  spend_cap: '500000',
  amount_spent: '150000',
  balance: '350000',
};

export const MOCK_CREATE_RESPONSE = { id: '999999' };
export const MOCK_SUCCESS_RESPONSE = { success: true };

export const MOCK_ERROR_AUTH = {
  error: {
    message: 'Invalid OAuth access token.',
    type: 'OAuthException',
    code: 190,
    fbtrace_id: 'abc123',
  },
};

export const MOCK_ERROR_RATE_LIMIT = {
  error: {
    message: 'Too many calls',
    type: 'OAuthException',
    code: 4,
    fbtrace_id: 'def456',
  },
};

export const MOCK_ERROR_PERMISSIONS = {
  error: {
    message: 'Insufficient permissions',
    type: 'OAuthException',
    code: 10,
    error_subcode: 1349193,
  },
};

// ---------------------------------------------------------------------------
// 4. captureOutput — spy on console / process.stdout / process.stderr
// ---------------------------------------------------------------------------

export function captureOutput() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origLog = console.log;
  const origError = console.error;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  console.log = (...args: any[]) => {
    stdoutChunks.push(args.map(String).join(' '));
  };

  console.error = (...args: any[]) => {
    stderrChunks.push(args.map(String).join(' '));
  };

  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  return {
    getStdout: () => stdoutChunks.join('\n'),
    getStderr: () => stderrChunks.join('\n'),
    restore: () => {
      console.log = origLog;
      console.error = origError;
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    },
  };
}

// ---------------------------------------------------------------------------
// 5. mockProcessExit — mock process.exit so tests can assert exit codes
// ---------------------------------------------------------------------------

export class ProcessExitError extends Error {
  public readonly exitCode: number;

  constructor(code: number) {
    super(`process.exit called with code ${code}`);
    this.name = 'ProcessExitError';
    this.exitCode = code;
  }
}

export function mockProcessExit() {
  const originalExit = process.exit;

  (process as any).exit = (code: number = 0) => {
    throw new ProcessExitError(code);
  };

  return {
    restore: () => {
      process.exit = originalExit;
    },
  };
}
