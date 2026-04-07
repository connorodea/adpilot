/**
 * E2E tests for error handling across multiple command types.
 *
 * Verifies that authentication errors, rate limits, permission errors,
 * server errors, network failures, and validation errors are all
 * handled gracefully with correct exit codes and output.
 */

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

jest.mock('node-fetch', () => jest.fn());
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
jest.mock('../../src/lib/config', () => ({
  getConfig: () => ({ apiVersion: 'v25.0' }),
  getToken: () => 'test-token-e2e',
  getAdAccountId: () => 'act_123456',
}));

/* ------------------------------------------------------------------ */
/* Imports                                                             */
/* ------------------------------------------------------------------ */

import { Command } from 'commander';
import fetch from 'node-fetch';
import { registerCampaignCommands } from '../../src/commands/campaigns';
import { registerInsightsCommands } from '../../src/commands/insights';
import {
  captureOutput,
  mockProcessExit,
  ProcessExitError,
  mockFetchResponse,
  MOCK_ERROR_AUTH,
  MOCK_ERROR_RATE_LIMIT,
  MOCK_ERROR_PERMISSIONS,
  MOCK_CAMPAIGNS,
} from './helpers';

const mockFetch = fetch as unknown as jest.Mock;

/* ------------------------------------------------------------------ */
/* Test helpers                                                        */
/* ------------------------------------------------------------------ */

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCampaignCommands(program);
  registerInsightsCommands(program);
  return program;
}

async function run(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const output = captureOutput();
  const exitMock = mockProcessExit();
  let exitCode: number | null = null;

  try {
    const program = buildProgram();
    await program.parseAsync(['node', 'adpilot', ...args]);
  } catch (err: any) {
    if (err instanceof ProcessExitError) {
      exitCode = err.exitCode;
    } else if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.version'
    ) {
      exitCode = 0;
    } else if (err.code?.startsWith?.('commander.')) {
      // Commander validation errors (missing options, etc.)
      exitCode = 1;
    } else {
      output.restore();
      exitMock.restore();
      throw err;
    }
  } finally {
    output.restore();
    exitMock.restore();
  }

  return {
    stdout: output.getStdout(),
    stderr: output.getStderr(),
    exitCode,
  };
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  mockFetch.mockReset();
});

jest.setTimeout(15_000);

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('Auth error (code 190)', () => {
  it('exits 1 and shows error on campaigns list', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_AUTH));

    const { stderr, exitCode } = await run(['campaigns', 'list']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('190');
    expect(stderr).toContain('OAuthException');
  });
});

describe('Rate limit handling (code 4)', () => {
  it('retries after rate limit then succeeds', async () => {
    // Speed up retry delays for this test only
    const origSetTimeout = global.setTimeout;
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

    // First call: rate limited, second call: success
    mockFetch
      .mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_RATE_LIMIT))
      .mockResolvedValueOnce(mockFetchResponse(MOCK_CAMPAIGNS));

    const { exitCode } = await run(['campaigns', 'list']);

    // Should succeed after retry
    expect(exitCode).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Restore real setTimeout
    (global.setTimeout as any).mockRestore();
  });

  it('exits 1 when all rate limit retries are exhausted', async () => {
    // Speed up retry delays
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

    // All 4 calls (initial + 3 retries) return rate limit
    mockFetch
      .mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_RATE_LIMIT))
      .mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_RATE_LIMIT))
      .mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_RATE_LIMIT))
      .mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_RATE_LIMIT));

    const { stderr, exitCode } = await run(['campaigns', 'list']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Too many calls');
    // Initial attempt + 3 retries = 4 total
    expect(mockFetch).toHaveBeenCalledTimes(4);

    (global.setTimeout as any).mockRestore();
  });
});

describe('Permissions error (code 10)', () => {
  it('exits 1 with descriptive message', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse(MOCK_ERROR_PERMISSIONS));

    const { stderr, exitCode } = await run(['campaigns', 'list']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('10');
    expect(stderr).toContain('Insufficient permissions');
  });
});

describe('API server error (500-level)', () => {
  it('handles 500 response gracefully', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse(
        {
          error: {
            message: 'An unknown error occurred',
            type: 'OAuthException',
            code: 1,
          },
        },
        500
      )
    );

    const { stderr, exitCode } = await run(['campaigns', 'list']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('An unknown error occurred');
  });
});

describe('Network error', () => {
  it('exits 1 when fetch throws a network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const { stderr, exitCode } = await run(['campaigns', 'list']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('ECONNREFUSED');
  });
});

describe('Validation errors on campaign create', () => {
  it('exits 1 with invalid objective', async () => {
    const { stderr, exitCode } = await run([
      'campaigns',
      'create',
      '--name',
      'Test',
      '--objective',
      'INVALID_OBJECTIVE',
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid objective');
    expect(stderr).toContain('INVALID_OBJECTIVE');
  });

  it('exits 1 with invalid status', async () => {
    const { stderr, exitCode } = await run([
      'campaigns',
      'create',
      '--name',
      'Test',
      '--objective',
      'OUTCOME_TRAFFIC',
      '--status',
      'BOGUS_STATUS',
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid status');
    expect(stderr).toContain('BOGUS_STATUS');
  });
});

describe('Missing required option', () => {
  it('Commander error when campaign create has no --name', async () => {
    const { exitCode } = await run([
      'campaigns',
      'create',
      '--objective',
      'OUTCOME_TRAFFIC',
    ]);

    // Commander exits with a non-zero code for missing required options
    expect(exitCode).not.toBeNull();
    expect(exitCode).toBeGreaterThan(0);
  });
});

describe('Insights with empty response', () => {
  it('handles empty data array without crashing', async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse({ data: [] }));

    const { stdout, exitCode } = await run(['insights', 'account']);

    // Should not crash — prints "No insights data" or an empty table
    expect(exitCode).toBeNull();
    expect(stdout).toContain('No insights data');
  });
});
