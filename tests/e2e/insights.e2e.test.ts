/**
 * E2E tests for `insights` commands.
 *
 * Strategy: mock node-fetch, config, logger, and ora at the module level,
 * then build a fresh Commander program per test and call parseAsync.
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';

// ── Mocks (must come before any import that touches these modules) ──────────

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/lib/config', () => ({
  getConfig: () => ({ apiVersion: 'v25.0', defaultOutputFormat: 'table' }),
  getToken: () => 'test-token-e2e',
  getAdAccountId: () => 'act_123456',
}));
jest.mock('../../src/lib/logger', () => ({
  isLoggingEnabled: () => false,
  logApiCall: jest.fn(),
  sanitizeParams: (p: any) => p,
}));
jest.mock('ora', () => {
  return () => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: '',
  });
});

import fetch from 'node-fetch';
import { registerInsightsCommands } from '../../src/commands/insights';
import { captureOutput, mockProcessExit, ProcessExitError } from './helpers';

// ── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_INSIGHTS = {
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
      actions: [{ action_type: 'link_click', value: '423' }],
    },
  ],
};

const MOCK_EMPTY_INSIGHTS = { data: [] };

const MOCK_ERROR_RESPONSE = {
  error: {
    message: 'Invalid OAuth access token.',
    type: 'OAuthException',
    code: 190,
    fbtrace_id: 'abc123',
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const mockedFetch = fetch as unknown as jest.Mock;

function mockFetchJson(body: any, status = 200) {
  mockedFetch.mockResolvedValueOnce({
    json: () => Promise.resolve(body),
    status,
    ok: status >= 200 && status < 300,
  });
}

/** Build a fresh program with only the insights commands registered. */
function buildProgram(): Command {
  const program = new Command();
  program.name('adpilot').exitOverride();
  registerInsightsCommands(program);
  return program;
}

/** Parse args through a fresh program, capturing stdout/stderr. */
async function run(args: string[]) {
  const out = captureOutput();
  const exitMock = mockProcessExit();
  let exitCode = 0;
  try {
    const program = buildProgram();
    await program.parseAsync(['node', 'adpilot', ...args]);
  } catch (err: any) {
    if (err instanceof ProcessExitError) {
      exitCode = err.exitCode;
    } else if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      exitCode = 0;
    } else {
      exitCode = 1;
    }
  } finally {
    out.restore();
    exitMock.restore();
  }
  return { stdout: out.getStdout(), stderr: out.getStderr(), exitCode };
}

// ── Tests ───────────────────────────────────────────────────────────────────

jest.setTimeout(15_000);

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('insights account', () => {
  it('fetches account insights and prints table output', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run(['insights', 'account']);

    expect(exitCode).toBe(0);
    // Table should contain key metrics from the mock data
    expect(stdout).toContain('15234');   // impressions
    expect(stdout).toContain('423');     // clicks
    expect(stdout).toContain('52.17');   // spend
    expect(stdout).toContain('12500');   // reach

    // API was called with correct endpoint
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('act_123456/insights');
  });

  it('outputs JSON when --json is passed', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run(['insights', 'account', '--json']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual(MOCK_INSIGHTS.data);
    expect(parsed[0].impressions).toBe('15234');
    expect(parsed[0].clicks).toBe('423');
    expect(parsed[0].spend).toBe('52.17');
  });

  it('passes custom date range (--since / --until) to API', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'account',
      '--since', '2024-03-01',
      '--until', '2024-03-07',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    // When since/until are supplied, time_range should be set (JSON-encoded)
    expect(callUrl).toContain('time_range');
    expect(callUrl).toContain('2024-03-01');
    expect(callUrl).toContain('2024-03-07');
    // date_preset should NOT appear when custom range is given
    expect(callUrl).not.toContain('date_preset');
  });

  it('passes --date-preset to API', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'account',
      '--date-preset', 'last_30d',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('date_preset=last_30d');
  });

  it('passes --breakdowns to API', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'account',
      '--breakdowns', 'age',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('breakdowns=age');
  });

  it('exports CSV when --csv is provided', async () => {
    const csvPath = path.join('/tmp', `test-insights-${Date.now()}.csv`);

    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run([
      'insights', 'account',
      '--csv', csvPath,
    ]);

    expect(exitCode).toBe(0);
    // Success message should mention the file
    expect(stdout).toContain(csvPath);

    // Verify the CSV file was actually created
    expect(fs.existsSync(csvPath)).toBe(true);
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    expect(csvContent).toContain('Impressions');
    expect(csvContent).toContain('15234');
    expect(csvContent).toContain('52.17');

    // Cleanup
    fs.unlinkSync(csvPath);
  });

  it('handles empty insights data gracefully', async () => {
    mockFetchJson(MOCK_EMPTY_INSIGHTS);
    const { stdout, exitCode } = await run(['insights', 'account']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('No insights data available');
  });

  it('exits with code 1 on API error', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode, stderr } = await run(['insights', 'account']);

    expect(exitCode).toBe(1);
  });
});

describe('insights campaign', () => {
  it('fetches campaign insights by ID', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run([
      'insights', 'campaign', 'camp_001', '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('camp_001/insights');

    const parsed = JSON.parse(stdout.trim());
    expect(parsed[0].campaign_name).toBe('Test Campaign 1');
  });

  it('passes date range params for campaign insights', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'campaign', 'camp_001',
      '--since', '2024-03-01',
      '--until', '2024-03-07',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('time_range');
  });

  it('exports campaign insights to CSV', async () => {
    const csvPath = path.join('/tmp', `test-campaign-insights-${Date.now()}.csv`);
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'campaign', 'camp_001',
      '--csv', csvPath,
    ]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(csvPath)).toBe(true);
    const content = fs.readFileSync(csvPath, 'utf-8');
    // Campaign level CSV includes a Name column
    expect(content).toContain('Name');
    expect(content).toContain('Test Campaign 1');

    fs.unlinkSync(csvPath);
  });
});

describe('insights adset', () => {
  it('fetches adset insights by ID', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run([
      'insights', 'adset', 'as_001', '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('as_001/insights');
  });

  it('table output for adset insights contains metrics', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run([
      'insights', 'adset', 'as_001',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('15234');
    expect(stdout).toContain('52.17');
  });

  it('handles API error for adset insights', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['insights', 'adset', 'as_001']);

    expect(exitCode).toBe(1);
  });
});

describe('insights ad', () => {
  it('fetches ad insights by ID', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run([
      'insights', 'ad', 'ad_001', '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('ad_001/insights');
  });

  it('passes breakdowns for ad-level insights', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'ad', 'ad_001',
      '--breakdowns', 'age',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('breakdowns=age');
  });

  it('table output for ad insights works', async () => {
    mockFetchJson(MOCK_INSIGHTS);
    const { stdout, exitCode } = await run(['insights', 'ad', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('15234');
  });

  it('exports ad insights to CSV', async () => {
    const csvPath = path.join('/tmp', `test-ad-insights-${Date.now()}.csv`);
    mockFetchJson(MOCK_INSIGHTS);
    const { exitCode } = await run([
      'insights', 'ad', 'ad_001',
      '--csv', csvPath,
    ]);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(csvPath)).toBe(true);
    fs.unlinkSync(csvPath);
  });

  it('handles empty ad insights', async () => {
    mockFetchJson(MOCK_EMPTY_INSIGHTS);
    const { stdout, exitCode } = await run(['insights', 'ad', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('No insights data available');
  });
});
