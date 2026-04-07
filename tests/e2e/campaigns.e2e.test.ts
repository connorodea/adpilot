/**
 * E2E tests for campaign commands.
 * Tests the full command pipeline: parsing -> validation -> API -> output.
 *
 * IN-PROCESS approach: mock node-fetch and config, then import and invoke
 * the Commander program directly. No child process spawned.
 */

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

// Mock ora spinner to prevent terminal output
jest.mock('ora', () => {
  return () => ({
    start: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: '',
  });
});

import { Command } from 'commander';
import fetch from 'node-fetch';
import { registerCampaignCommands } from '../../src/commands/campaigns';

const mockFetch = fetch as unknown as jest.Mock;

function mockJsonResponse(body: any, status = 200) {
  return { json: () => Promise.resolve(body), status, ok: status >= 200 && status < 300 };
}

// Mock process.exit to throw so we can catch exit codes
const originalExit = process.exit;
let exitCode: number | undefined;
beforeAll(() => {
  process.exit = jest.fn((code?: number) => {
    exitCode = code as number;
    throw new Error(`process.exit(${code})`);
  }) as any;
});
afterAll(() => {
  process.exit = originalExit;
});

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerCampaignCommands(program);
  return program;
}

async function run(program: Command, args: string[]) {
  exitCode = undefined;
  try {
    await program.parseAsync(['node', 'adpilot', ...args]);
  } catch (err: any) {
    if (!err.message.startsWith('process.exit')) throw err;
  }
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  mockFetch.mockReset();
  exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

const MOCK_CAMPAIGNS = {
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

// ---------------------------------------------------------------------------
// campaigns list
// ---------------------------------------------------------------------------
describe('campaigns list', () => {
  it('fetches and displays campaigns in table format', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_CAMPAIGNS));
    const program = createProgram();
    await run(program, ['campaigns', 'list']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('act_123456/campaigns');
    expect(calledUrl).toContain('access_token=test-token-e2e');

    // Should output table (console.log called)
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('123456');
    expect(output).toContain('Test Campaign 1');
  });

  it('outputs JSON when --json flag is used', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_CAMPAIGNS));
    const program = createProgram();
    await run(program, ['campaigns', 'list', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('123456');
    expect(parsed[1].id).toBe('789012');
  });

  it('passes status filter to API', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['campaigns', 'list', '--status', 'ACTIVE']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('filtering');
  });

  it('passes limit parameter', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['campaigns', 'list', '--limit', '10']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=10');
  });

  it('uses custom account ID when provided', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['campaigns', 'list', '--account-id', 'act_999']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('act_999/campaigns');
  });

  it('handles API error gracefully', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Invalid token', type: 'OAuthException', code: 190 },
      })
    );
    const program = createProgram();
    await run(program, ['campaigns', 'list']);

    expect(exitCode).toBe(1);
  });

  it('handles empty campaign list', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['campaigns', 'list']);

    // Should not throw
    expect(exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// campaigns get
// ---------------------------------------------------------------------------
describe('campaigns get', () => {
  const MOCK_CAMPAIGN_DETAIL = {
    id: '123456',
    name: 'Test Campaign 1',
    objective: 'OUTCOME_TRAFFIC',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    daily_budget: '5000',
    lifetime_budget: null,
    budget_remaining: '3200',
    spend_cap: null,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    buying_type: 'AUCTION',
    special_ad_categories: [],
    start_time: '2024-01-15T10:00:00+0000',
    stop_time: null,
    created_time: '2024-01-15T10:00:00+0000',
    updated_time: '2024-03-01T08:00:00+0000',
  };

  it('fetches campaign by ID', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_CAMPAIGN_DETAIL));
    const program = createProgram();
    await run(program, ['campaigns', 'get', '123456']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/123456');
    expect(logSpy).toHaveBeenCalled();
  });

  it('outputs JSON for campaign get', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_CAMPAIGN_DETAIL));
    const program = createProgram();
    await run(program, ['campaigns', 'get', '123456', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('123456');
    expect(parsed.objective).toBe('OUTCOME_TRAFFIC');
  });

  it('passes custom fields', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_CAMPAIGN_DETAIL));
    const program = createProgram();
    await run(program, ['campaigns', 'get', '123456', '--fields', 'id,name,status']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('fields=id%2Cname%2Cstatus');
  });
});

// ---------------------------------------------------------------------------
// campaigns create
// ---------------------------------------------------------------------------
describe('campaigns create', () => {
  it('creates campaign with required fields', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: '999999' }));
    const program = createProgram();
    await run(program, ['campaigns', 'create', '-n', 'New Campaign', '-o', 'OUTCOME_TRAFFIC']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('act_123456/campaigns');
    expect(calledOpts.method).toBe('POST');

    const bodyStr = calledOpts.body.toString();
    expect(bodyStr).toContain('name=New+Campaign');
    expect(bodyStr).toContain('objective=OUTCOME_TRAFFIC');
    expect(bodyStr).toContain('status=PAUSED'); // default status
  });

  it('outputs created campaign ID', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: '999999' }));
    const program = createProgram();
    await run(program, ['campaigns', 'create', '-n', 'New Campaign', '-o', 'OUTCOME_TRAFFIC']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('999999');
  });

  it('creates campaign with all options', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: '999999' }));
    const program = createProgram();
    await run(program, [
      'campaigns',
      'create',
      '-n',
      'Full Campaign',
      '-o',
      'OUTCOME_TRAFFIC',
      '--status',
      'ACTIVE',
      '--daily-budget',
      '10000',
      '--bid-strategy',
      'LOWEST_COST_WITHOUT_CAP',
      '--buying-type',
      'AUCTION',
    ]);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('status=ACTIVE');
    expect(bodyStr).toContain('daily_budget=10000');
    expect(bodyStr).toContain('bid_strategy=LOWEST_COST_WITHOUT_CAP');
  });

  it('returns JSON when --json flag is used', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: '999999' }));
    const program = createProgram();
    await run(program, [
      'campaigns',
      'create',
      '-n',
      'New',
      '-o',
      'OUTCOME_TRAFFIC',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('999999');
  });

  it('validates objective', async () => {
    const program = createProgram();
    await run(program, ['campaigns', 'create', '-n', 'Bad', '-o', 'INVALID_OBJECTIVE']);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// campaigns update
// ---------------------------------------------------------------------------
describe('campaigns update', () => {
  it('updates campaign name', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['campaigns', 'update', '123456', '-n', 'Updated Name']);

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('/123456');
    expect(calledOpts.method).toBe('POST');
    expect(calledOpts.body.toString()).toContain('name=Updated+Name');
  });

  it('updates campaign budget', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['campaigns', 'update', '123456', '--daily-budget', '8000']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('daily_budget=8000');
  });

  it('fails when no update fields provided', async () => {
    const program = createProgram();
    await run(program, ['campaigns', 'update', '123456']);

    expect(exitCode).toBe(1);
    const errOutput = errorSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(errOutput).toContain('No fields to update');
  });
});

// ---------------------------------------------------------------------------
// campaigns pause/resume/archive/delete
// ---------------------------------------------------------------------------
describe('campaigns pause/resume/archive/delete', () => {
  it('pauses a campaign', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['campaigns', 'pause', '123456']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('status=PAUSED');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('paused');
  });

  it('resumes a campaign', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['campaigns', 'resume', '123456']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('status=ACTIVE');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('activated');
  });

  it('archives a campaign', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['campaigns', 'archive', '123456']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('status=ARCHIVED');
  });

  it('deletes a campaign', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['campaigns', 'delete', '123456']);

    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('deleted');
  });
});

// ---------------------------------------------------------------------------
// campaigns copy
// ---------------------------------------------------------------------------
describe('campaigns copy', () => {
  it('copies a campaign', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ copied_campaign_id: '888888' }));
    const program = createProgram();
    await run(program, ['campaigns', 'copy', '123456']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('123456/copies');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('888888');
  });

  it('deep copies with rename prefix', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ copied_campaign_id: '888888' }));
    const program = createProgram();
    await run(program, ['campaigns', 'copy', '123456', '--deep', '--rename-prefix', 'COPY_']);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('deep_copy=true');
    expect(bodyStr).toContain('rename_prefix=COPY_');
    expect(bodyStr).toContain('rename_strategy=DEEP_RENAME');
  });
});
