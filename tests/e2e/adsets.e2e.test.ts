/**
 * E2E tests for ad set commands.
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
import { registerAdSetCommands } from '../../src/commands/adsets';

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
  registerAdSetCommands(program);
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

const MOCK_ADSETS = {
  data: [
    {
      id: 'as_001',
      name: 'Test AdSet 1',
      campaign_id: '123456',
      status: 'ACTIVE',
      effective_status: 'ACTIVE',
      daily_budget: '2000',
      lifetime_budget: null,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'REACH',
      bid_amount: null,
      start_time: '2024-01-15T10:00:00+0000',
      end_time: null,
    },
    {
      id: 'as_002',
      name: 'Test AdSet 2',
      campaign_id: '123456',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      daily_budget: '3000',
      lifetime_budget: null,
      billing_event: 'LINK_CLICKS',
      optimization_goal: 'LINK_CLICKS',
      bid_amount: '150',
      start_time: '2024-02-01T08:00:00+0000',
      end_time: '2024-06-01T00:00:00+0000',
    },
  ],
};

const MOCK_ADSET_DETAIL = {
  id: 'as_001',
  name: 'Test AdSet 1',
  campaign_id: '123456',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
  daily_budget: '2000',
  lifetime_budget: null,
  bid_amount: null,
  bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
  billing_event: 'IMPRESSIONS',
  optimization_goal: 'REACH',
  targeting: { geo_locations: { countries: ['US'] }, age_min: 18, age_max: 65 },
  promoted_object: { page_id: 'pg_123' },
  start_time: '2024-01-15T10:00:00+0000',
  end_time: null,
  created_time: '2024-01-15T10:00:00+0000',
  updated_time: '2024-03-01T12:00:00+0000',
  learning_stage_info: { status: 'LEARNING' },
  is_dynamic_creative: false,
};

const TARGETING_JSON = '{"geo_locations":{"countries":["US"]},"age_min":18,"age_max":65}';

// ---------------------------------------------------------------------------
// adsets list
// ---------------------------------------------------------------------------
describe('adsets list', () => {
  it('fetches and displays ad sets in table format', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_ADSETS));
    const program = createProgram();
    await run(program, ['adsets', 'list']);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('act_123456/adsets');
    expect(calledUrl).toContain('access_token=test-token-e2e');

    // Should output table via console.log
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('as_001');
    expect(output).toContain('Test AdSet 1');
  });

  it('outputs JSON when --json flag is used', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_ADSETS));
    const program = createProgram();
    await run(program, ['adsets', 'list', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('as_001');
    expect(parsed[1].id).toBe('as_002');
  });

  it('uses custom account ID when provided', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list', '--account-id', 'act_999']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('act_999/adsets');
  });

  it('passes status filter to API', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list', '--status', 'ACTIVE']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('filtering');
  });

  it('passes limit parameter', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list', '--limit', '5']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=5');
  });

  it('filters by campaign-id', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list', '--campaign-id', 'camp_555']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('camp_555/adsets');
  });

  it('handles API error gracefully', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Invalid token', type: 'OAuthException', code: 190 },
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'list']);

    expect(exitCode).toBe(1);
  });

  it('handles empty ad set list', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list']);

    // Should not throw or exit with error
    expect(exitCode).toBeUndefined();
  });

  it('passes custom fields', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list', '--fields', 'id,name,status']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('fields=id%2Cname%2Cstatus');
  });

  it('uses default limit of 25', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ data: [] }));
    const program = createProgram();
    await run(program, ['adsets', 'list']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('limit=25');
  });
});

// ---------------------------------------------------------------------------
// adsets get
// ---------------------------------------------------------------------------
describe('adsets get', () => {
  it('fetches ad set by ID', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_ADSET_DETAIL));
    const program = createProgram();
    await run(program, ['adsets', 'get', 'as_001']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/as_001');
    expect(logSpy).toHaveBeenCalled();
  });

  it('outputs JSON for ad set get', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_ADSET_DETAIL));
    const program = createProgram();
    await run(program, ['adsets', 'get', 'as_001', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('as_001');
    expect(parsed.billing_event).toBe('IMPRESSIONS');
    expect(parsed.optimization_goal).toBe('REACH');
  });

  it('passes custom fields', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_ADSET_DETAIL));
    const program = createProgram();
    await run(program, ['adsets', 'get', 'as_001', '--fields', 'id,name,targeting']);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('fields=id%2Cname%2Ctargeting');
  });

  it('displays record in table format by default', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse(MOCK_ADSET_DETAIL));
    const program = createProgram();
    await run(program, ['adsets', 'get', 'as_001']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    // Should show the ad set name and ID somewhere in table output
    expect(output).toContain('as_001');
    expect(output).toContain('Test AdSet 1');
  });

  it('handles API error gracefully', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Object does not exist', type: 'GraphMethodException', code: 100 },
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'get', 'nonexistent_id']);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// adsets create
// ---------------------------------------------------------------------------
describe('adsets create', () => {
  it('creates ad set with all required fields', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: 'as_new_001' }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'New AdSet',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('act_123456/adsets');
    expect(calledOpts.method).toBe('POST');

    const bodyStr = calledOpts.body.toString();
    expect(bodyStr).toContain('name=New+AdSet');
    expect(bodyStr).toContain('campaign_id=camp_123');
    expect(bodyStr).toContain('billing_event=IMPRESSIONS');
    expect(bodyStr).toContain('optimization_goal=REACH');
    expect(bodyStr).toContain('daily_budget=5000');
    expect(bodyStr).toContain('status=PAUSED'); // default status
  });

  it('outputs created ad set ID', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: 'as_new_001' }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'New AdSet',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
    ]);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('as_new_001');
  });

  it('creates ad set with all optional fields', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: 'as_new_002' }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'Full AdSet',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--status',
      'ACTIVE',
      '--daily-budget',
      '8000',
      '--bid-amount',
      '200',
      '--bid-strategy',
      'LOWEST_COST_WITH_BID_CAP',
      '--start-time',
      '2024-04-01T00:00:00+0000',
      '--end-time',
      '2024-06-01T00:00:00+0000',
    ]);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('status=ACTIVE');
    expect(bodyStr).toContain('daily_budget=8000');
    expect(bodyStr).toContain('bid_amount=200');
    expect(bodyStr).toContain('bid_strategy=LOWEST_COST_WITH_BID_CAP');
    expect(bodyStr).toContain('start_time=2024-04-01T00');
    expect(bodyStr).toContain('end_time=2024-06-01T00');
  });

  it('returns JSON when --json flag is used', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: 'as_new_003' }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'JSON AdSet',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
      '--json',
    ]);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('as_new_003');
  });

  it('uses custom account ID when provided', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ id: 'as_new_004' }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'Custom Account AdSet',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
      '--account-id',
      'act_999',
    ]);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('act_999/adsets');
  });

  it('validates billing event', async () => {
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'Bad Billing',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'INVALID_EVENT',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
    ]);

    expect(exitCode).toBe(1);
  });

  it('validates optimization goal', async () => {
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'Bad Goal',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'INVALID_GOAL',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
    ]);

    expect(exitCode).toBe(1);
  });

  it('validates targeting JSON', async () => {
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'Bad JSON',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      'not-valid-json',
      '--daily-budget',
      '5000',
    ]);

    expect(exitCode).toBe(1);
  });

  it('handles API error on create', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      })
    );
    const program = createProgram();
    await run(program, [
      'adsets',
      'create',
      '-n',
      'Error AdSet',
      '--campaign-id',
      'camp_123',
      '--billing-event',
      'IMPRESSIONS',
      '--optimization-goal',
      'REACH',
      '--targeting',
      TARGETING_JSON,
      '--daily-budget',
      '5000',
    ]);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// adsets update
// ---------------------------------------------------------------------------
describe('adsets update', () => {
  it('updates ad set name', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001', '-n', 'Updated AdSet']);

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('/as_001');
    expect(calledOpts.method).toBe('POST');
    expect(calledOpts.body.toString()).toContain('name=Updated+AdSet');
  });

  it('updates ad set daily budget', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001', '--daily-budget', '6000']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('daily_budget=6000');
  });

  it('updates multiple fields at once', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'update',
      'as_001',
      '-n',
      'New Name',
      '--daily-budget',
      '7000',
      '--bid-amount',
      '300',
      '--status',
      'PAUSED',
    ]);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('name=New+Name');
    expect(bodyStr).toContain('daily_budget=7000');
    expect(bodyStr).toContain('bid_amount=300');
    expect(bodyStr).toContain('status=PAUSED');
  });

  it('updates targeting JSON', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001', '--targeting', TARGETING_JSON]);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('targeting=');
  });

  it('updates bid strategy', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001', '--bid-strategy', 'COST_CAP']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('bid_strategy=COST_CAP');
  });

  it('fails when no update fields provided', async () => {
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001']);

    expect(exitCode).toBe(1);
    const errOutput = errorSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(errOutput).toContain('No fields to update');
  });

  it('returns JSON when --json flag is used', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001', '-n', 'JSON Update', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
  });

  it('handles API error on update', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Cannot update', type: 'OAuthException', code: 100 },
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'update', 'as_001', '-n', 'Fail']);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// adsets pause/resume/delete
// ---------------------------------------------------------------------------
describe('adsets pause/resume/delete', () => {
  it('pauses an ad set', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'pause', 'as_001']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('status=PAUSED');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('paused');
  });

  it('resumes an ad set', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'resume', 'as_001']);

    expect(mockFetch.mock.calls[0][1].body.toString()).toContain('status=ACTIVE');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('activated');
  });

  it('deletes an ad set', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'delete', 'as_001']);

    expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('deleted');
  });

  it('handles API error on pause', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Cannot pause', type: 'OAuthException', code: 100 },
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'pause', 'as_001']);

    expect(exitCode).toBe(1);
  });

  it('handles API error on resume', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Cannot resume', type: 'OAuthException', code: 100 },
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'resume', 'as_001']);

    expect(exitCode).toBe(1);
  });

  it('handles API error on delete', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        error: { message: 'Cannot delete', type: 'OAuthException', code: 100 },
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'delete', 'as_001']);

    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// adsets set-schedule
// ---------------------------------------------------------------------------
describe('adsets set-schedule', () => {
  it('sets schedule with default weekday parameters', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, ['adsets', 'set-schedule', 'as_001']);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('adset_schedule=');
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('schedule set');
  });

  it('sets schedule with custom days and time range', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const program = createProgram();
    await run(program, [
      'adsets',
      'set-schedule',
      'as_001',
      '--days',
      '1,2,3',
      '--start-minute',
      '480',
      '--end-minute',
      '1020',
    ]);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('adset_schedule=');
  });

  it('sets schedule with raw JSON', async () => {
    mockFetch.mockResolvedValue(mockJsonResponse({ success: true }));
    const schedule = JSON.stringify([
      { start_minute: 0, end_minute: 720, days: [1, 2, 3, 4, 5], timezone_type: 'ADVERTISER' },
    ]);
    const program = createProgram();
    await run(program, ['adsets', 'set-schedule', 'as_001', '--schedule', schedule]);

    const bodyStr = mockFetch.mock.calls[0][1].body.toString();
    expect(bodyStr).toContain('adset_schedule=');
  });
});

// ---------------------------------------------------------------------------
// adsets get-schedule
// ---------------------------------------------------------------------------
describe('adsets get-schedule', () => {
  it('fetches and displays schedule', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({
        id: 'as_001',
        name: 'Test AdSet 1',
        adset_schedule: [
          { start_minute: 480, end_minute: 1020, days: [1, 2, 3, 4, 5], timezone_type: 'ADVERTISER' },
        ],
      })
    );
    const program = createProgram();
    await run(program, ['adsets', 'get-schedule', 'as_001']);

    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('Monday');
  });

  it('outputs JSON when --json flag is used', async () => {
    const scheduleData = {
      id: 'as_001',
      name: 'Test AdSet 1',
      adset_schedule: [
        { start_minute: 0, end_minute: 1439, days: [0, 6], timezone_type: 'USER' },
      ],
    };
    mockFetch.mockResolvedValue(mockJsonResponse(scheduleData));
    const program = createProgram();
    await run(program, ['adsets', 'get-schedule', 'as_001', '--json']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.adset_schedule).toBeDefined();
    expect(parsed.adset_schedule[0].days).toEqual([0, 6]);
  });

  it('shows info message when no schedule exists', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse({ id: 'as_001', name: 'Test AdSet 1', adset_schedule: [] })
    );
    const program = createProgram();
    await run(program, ['adsets', 'get-schedule', 'as_001']);

    const output = logSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n');
    expect(output).toContain('no delivery schedule');
  });
});
