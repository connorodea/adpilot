/**
 * E2E tests for `ads` commands.
 *
 * Strategy: mock node-fetch, config, logger, and ora at the module level,
 * then build a fresh Commander program per test and call parseAsync.
 */

import { Command } from 'commander';

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
import { registerAdCommands } from '../../src/commands/ads';
import { captureOutput, mockProcessExit, ProcessExitError } from './helpers';

// ── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_ADS = {
  data: [
    {
      id: 'ad_001',
      name: 'Test Ad 1',
      adset_id: 'as_001',
      campaign_id: '123456',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      creative: { id: 'cr_001' },
      created_time: '2024-01-15T10:00:00+0000',
      updated_time: '2024-01-16T12:00:00+0000',
    },
    {
      id: 'ad_002',
      name: 'Test Ad 2',
      adset_id: 'as_001',
      campaign_id: '123456',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      creative: { id: 'cr_002' },
      created_time: '2024-02-10T08:00:00+0000',
      updated_time: '2024-02-11T09:00:00+0000',
    },
  ],
};

const MOCK_AD_DETAIL = {
  id: 'ad_001',
  name: 'Test Ad 1',
  adset_id: 'as_001',
  campaign_id: '123456',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
  creative: { id: 'cr_001' },
  bid_type: 'CPC',
  ad_review_feedback: null,
  tracking_specs: [{ action_type: ['offsite_conversion'] }],
  conversion_specs: null,
  created_time: '2024-01-15T10:00:00+0000',
  updated_time: '2024-01-16T12:00:00+0000',
};

const MOCK_CREATE_RESPONSE = { id: 'ad_new_001' };
const MOCK_SUCCESS_RESPONSE = { success: true };

const MOCK_PREVIEW = {
  data: [
    { body: '<div class="fb-ad-preview">Preview HTML Content</div>' },
  ],
};

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

/** Build a fresh program with only the ad commands registered. */
function buildProgram(): Command {
  const program = new Command();
  program.name('adpilot').exitOverride();
  registerAdCommands(program);
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

// ── ads list ────────────────────────────────────────────────────────────────

describe('ads list', () => {
  it('lists ads in table format', async () => {
    mockFetchJson(MOCK_ADS);
    const { stdout, exitCode } = await run(['ads', 'list']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_001');
    expect(stdout).toContain('Test Ad 1');
    expect(stdout).toContain('ad_002');
    expect(stdout).toContain('Test Ad 2');

    // Correct endpoint
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('act_123456/ads');
  });

  it('outputs JSON when --json is passed', async () => {
    mockFetchJson(MOCK_ADS);
    const { stdout, exitCode } = await run(['ads', 'list', '--json']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('ad_001');
    expect(parsed[1].id).toBe('ad_002');
  });

  it('filters by adset-id', async () => {
    mockFetchJson(MOCK_ADS);
    const { exitCode } = await run(['ads', 'list', '--adset-id', 'as_001']);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('as_001/ads');
  });

  it('filters by campaign-id', async () => {
    mockFetchJson(MOCK_ADS);
    const { exitCode } = await run(['ads', 'list', '--campaign-id', 'camp_001']);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('camp_001/ads');
  });

  it('handles API error on list', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['ads', 'list']);

    expect(exitCode).toBe(1);
  });
});

// ── ads get ─────────────────────────────────────────────────────────────────

describe('ads get', () => {
  it('fetches ad details and prints record', async () => {
    mockFetchJson(MOCK_AD_DETAIL);
    const { stdout, exitCode } = await run(['ads', 'get', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_001');
    expect(stdout).toContain('Test Ad 1');

    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toMatch(/\/ad_001\?/);
  });

  it('outputs JSON when --json is passed', async () => {
    mockFetchJson(MOCK_AD_DETAIL);
    const { stdout, exitCode } = await run(['ads', 'get', 'ad_001', '--json']);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.id).toBe('ad_001');
    expect(parsed.name).toBe('Test Ad 1');
    expect(parsed.status).toBe('ACTIVE');
  });

  it('handles API error on get', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['ads', 'get', 'ad_001']);

    expect(exitCode).toBe(1);
  });
});

// ── ads create ──────────────────────────────────────────────────────────────

describe('ads create', () => {
  it('creates an ad with required options', async () => {
    mockFetchJson(MOCK_CREATE_RESPONSE);
    const { stdout, exitCode } = await run([
      'ads', 'create',
      '--name', 'New Test Ad',
      '--adset-id', 'as_001',
      '--creative', '{"creative_id":"cr_001"}',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_new_001');

    // Verify POST was made to the correct endpoint
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('act_123456/ads');

    // Verify the fetch was called with POST method
    const fetchOpts = mockedFetch.mock.calls[0][1];
    expect(fetchOpts.method).toBe('POST');
  });

  it('creates an ad with explicit status', async () => {
    mockFetchJson(MOCK_CREATE_RESPONSE);
    const { stdout, exitCode } = await run([
      'ads', 'create',
      '--name', 'Active Ad',
      '--adset-id', 'as_001',
      '--creative', '{"creative_id":"cr_001"}',
      '--status', 'ACTIVE',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_new_001');

    // Verify POST body includes status=ACTIVE
    const fetchOpts = mockedFetch.mock.calls[0][1];
    const body = fetchOpts.body as URLSearchParams;
    expect(body.get('status')).toBe('ACTIVE');
  });

  it('outputs JSON on create when --json is passed', async () => {
    mockFetchJson(MOCK_CREATE_RESPONSE);
    const { stdout, exitCode } = await run([
      'ads', 'create',
      '--name', 'JSON Ad',
      '--adset-id', 'as_001',
      '--creative', '{"creative_id":"cr_001"}',
      '--json',
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.id).toBe('ad_new_001');
  });

  it('handles API error on create', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run([
      'ads', 'create',
      '--name', 'Failing Ad',
      '--adset-id', 'as_001',
      '--creative', '{"creative_id":"cr_001"}',
    ]);

    expect(exitCode).toBe(1);
  });
});

// ── ads update ──────────────────────────────────────────────────────────────

describe('ads update', () => {
  it('updates ad name', async () => {
    mockFetchJson(MOCK_SUCCESS_RESPONSE);
    const { stdout, exitCode } = await run([
      'ads', 'update', 'ad_001',
      '--name', 'Updated Ad Name',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_001');
    expect(stdout).toContain('updated');

    const fetchOpts = mockedFetch.mock.calls[0][1];
    expect(fetchOpts.method).toBe('POST');
    const body = fetchOpts.body as URLSearchParams;
    expect(body.get('name')).toBe('Updated Ad Name');
  });

  it('updates ad status', async () => {
    mockFetchJson(MOCK_SUCCESS_RESPONSE);
    const { stdout, exitCode } = await run([
      'ads', 'update', 'ad_001',
      '--status', 'PAUSED',
    ]);

    expect(exitCode).toBe(0);
    const fetchOpts = mockedFetch.mock.calls[0][1];
    const body = fetchOpts.body as URLSearchParams;
    expect(body.get('status')).toBe('PAUSED');
  });

  it('updates multiple fields at once', async () => {
    mockFetchJson(MOCK_SUCCESS_RESPONSE);
    const { exitCode } = await run([
      'ads', 'update', 'ad_001',
      '--name', 'Renamed Ad',
      '--status', 'ACTIVE',
    ]);

    expect(exitCode).toBe(0);
    const fetchOpts = mockedFetch.mock.calls[0][1];
    const body = fetchOpts.body as URLSearchParams;
    expect(body.get('name')).toBe('Renamed Ad');
    expect(body.get('status')).toBe('ACTIVE');
  });

  it('exits with error when no fields to update', async () => {
    const { exitCode } = await run(['ads', 'update', 'ad_001']);

    expect(exitCode).toBe(1);
    // No fetch call should have been made
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('handles API error on update', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run([
      'ads', 'update', 'ad_001',
      '--name', 'Will Fail',
    ]);

    expect(exitCode).toBe(1);
  });
});

// ── ads pause / resume / delete ─────────────────────────────────────────────

describe('ads pause', () => {
  it('pauses an ad by ID', async () => {
    mockFetchJson(MOCK_SUCCESS_RESPONSE);
    const { stdout, exitCode } = await run(['ads', 'pause', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_001');
    expect(stdout).toContain('paused');

    const fetchOpts = mockedFetch.mock.calls[0][1];
    expect(fetchOpts.method).toBe('POST');
    const body = fetchOpts.body as URLSearchParams;
    expect(body.get('status')).toBe('PAUSED');
  });

  it('handles API error on pause', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['ads', 'pause', 'ad_001']);

    expect(exitCode).toBe(1);
  });
});

describe('ads resume', () => {
  it('resumes an ad by ID', async () => {
    mockFetchJson(MOCK_SUCCESS_RESPONSE);
    const { stdout, exitCode } = await run(['ads', 'resume', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_001');
    expect(stdout).toContain('activated');

    const fetchOpts = mockedFetch.mock.calls[0][1];
    expect(fetchOpts.method).toBe('POST');
    const body = fetchOpts.body as URLSearchParams;
    expect(body.get('status')).toBe('ACTIVE');
  });

  it('handles API error on resume', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['ads', 'resume', 'ad_001']);

    expect(exitCode).toBe(1);
  });
});

describe('ads delete', () => {
  it('deletes an ad by ID', async () => {
    mockFetchJson(MOCK_SUCCESS_RESPONSE);
    const { stdout, exitCode } = await run(['ads', 'delete', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('ad_001');
    expect(stdout).toContain('deleted');

    // Should use DELETE method
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toMatch(/\/ad_001\?/);
    const fetchOpts = mockedFetch.mock.calls[0][1];
    expect(fetchOpts.method).toBe('DELETE');
  });

  it('handles API error on delete', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['ads', 'delete', 'ad_001']);

    expect(exitCode).toBe(1);
  });
});

// ── ads preview ─────────────────────────────────────────────────────────────

describe('ads preview', () => {
  it('fetches ad preview HTML', async () => {
    mockFetchJson(MOCK_PREVIEW);
    const { stdout, exitCode } = await run(['ads', 'preview', 'ad_001']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Preview HTML Content');

    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('ad_001/previews');
    expect(callUrl).toContain('ad_format=DESKTOP_FEED_STANDARD');
  });

  it('passes custom format option', async () => {
    mockFetchJson(MOCK_PREVIEW);
    const { exitCode } = await run([
      'ads', 'preview', 'ad_001',
      '--format', 'MOBILE_FEED_STANDARD',
    ]);

    expect(exitCode).toBe(0);
    const callUrl = mockedFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain('ad_format=MOBILE_FEED_STANDARD');
  });

  it('outputs JSON when --json is passed', async () => {
    mockFetchJson(MOCK_PREVIEW);
    const { stdout, exitCode } = await run([
      'ads', 'preview', 'ad_001', '--json',
    ]);

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed[0].body).toContain('Preview HTML Content');
  });

  it('handles empty preview', async () => {
    mockFetchJson({ data: [] });
    const { stderr, exitCode } = await run(['ads', 'preview', 'ad_001']);

    // The command prints an error for empty previews but doesn't exit(1)
    expect(exitCode).toBe(0);
  });

  it('handles API error on preview', async () => {
    mockFetchJson(MOCK_ERROR_RESPONSE);
    const { exitCode } = await run(['ads', 'preview', 'ad_001']);

    expect(exitCode).toBe(1);
  });
});
