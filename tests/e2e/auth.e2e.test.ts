/**
 * E2E tests for the `auth` command family.
 *
 * These run the Commander-registered actions *in-process* with mocked fetch,
 * config, spinner, and inquirer so we can assert on outputs and exit codes
 * without real HTTP or filesystem I/O.
 */

/* ------------------------------------------------------------------ */
/* Mocks — must appear before any import that touches the mocked deps */
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

// Writable mock config store used by auth commands
const mockConfig: Record<string, any> = {};
jest.mock('../../src/lib/config', () => ({
  getConfig: () => ({ apiVersion: 'v25.0', ...mockConfig }),
  getToken: jest.fn(() => {
    if (mockConfig.accessToken) return mockConfig.accessToken;
    throw new Error('No access token configured. Run `adpilot auth login` first.');
  }),
  setConfig: jest.fn((key: string, value: any) => {
    mockConfig[key] = value;
  }),
  clearConfig: jest.fn(() => {
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  }),
  getAdAccountId: () => 'act_123456',
  listProfiles: jest.fn(() => []),
  getProfile: jest.fn(() => null),
  saveProfile: jest.fn(),
  deleteProfile: jest.fn(),
  getActiveProfileName: jest.fn(() => null),
  switchProfile: jest.fn(),
}));

jest.mock('inquirer', () => ({
  prompt: jest.fn().mockResolvedValue({ token: 'prompted-token-123' }),
}));

/* ------------------------------------------------------------------ */
/* Imports                                                             */
/* ------------------------------------------------------------------ */

import { Command } from 'commander';
import fetch from 'node-fetch';
import inquirer from 'inquirer';
import { registerAuthCommands } from '../../src/commands/auth';
import {
  setConfig,
  clearConfig,
  getToken,
  listProfiles,
  getActiveProfileName,
} from '../../src/lib/config';
import {
  captureOutput,
  mockProcessExit,
  ProcessExitError,
  mockFetchResponse,
} from './helpers';

const mockFetch = fetch as unknown as jest.Mock;

/* ------------------------------------------------------------------ */
/* Test helpers                                                        */
/* ------------------------------------------------------------------ */

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on Commander errors
  registerAuthCommands(program);
  return program;
}

async function runAuth(args: string[]): Promise<{
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
    } else {
      // Re-throw unexpected errors so tests fail clearly
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
/* Setup / teardown                                                    */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  mockFetch.mockReset();
  (setConfig as jest.Mock).mockClear();
  (clearConfig as jest.Mock).mockClear();
  (getToken as jest.Mock).mockClear();
  (listProfiles as jest.Mock).mockClear();
  (getActiveProfileName as jest.Mock).mockClear();

  // Reset mock config store
  Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

jest.setTimeout(15_000);

describe('auth login', () => {
  it('validates token via API and saves to config when -t is provided', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse({ id: '10001', name: 'Test User' })
    );

    const { stdout, exitCode } = await runAuth([
      'auth',
      'login',
      '-t',
      'valid-token-abc',
    ]);

    // API was called to validate the token
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/me');
    expect(calledUrl).toContain('access_token=valid-token-abc');

    // Token saved
    expect(setConfig).toHaveBeenCalledWith('accessToken', 'valid-token-abc');

    // Success message
    expect(stdout).toContain('Test User');
    expect(exitCode).toBeNull(); // no process.exit — success path
  });

  it('prompts for token via inquirer when no -t flag given', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse({ id: '10001', name: 'Prompted User' })
    );

    const { stdout } = await runAuth(['auth', 'login']);

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('access_token=prompted-token-123');
    expect(setConfig).toHaveBeenCalledWith('accessToken', 'prompted-token-123');
    expect(stdout).toContain('Prompted User');
  });

  it('exits 1 when API returns an error (invalid token)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse({
        error: {
          message: 'Invalid OAuth access token.',
          type: 'OAuthException',
          code: 190,
        },
      })
    );

    const { stderr, exitCode } = await runAuth([
      'auth',
      'login',
      '-t',
      'bad-token',
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid token');
    expect(setConfig).not.toHaveBeenCalledWith('accessToken', 'bad-token');
  });
});

describe('auth logout', () => {
  it('clears the token from config', async () => {
    mockConfig.accessToken = 'existing-token';

    const { stdout, exitCode } = await runAuth(['auth', 'logout']);

    expect(setConfig).toHaveBeenCalledWith('accessToken', '');
    expect(stdout).toContain('cleared');
    expect(exitCode).toBeNull();
  });
});

describe('auth status', () => {
  it('shows authenticated user info when token is valid', async () => {
    mockConfig.accessToken = 'valid-token-for-status';

    mockFetch.mockResolvedValueOnce(
      mockFetchResponse({ id: '10001', name: 'Status User' })
    );

    const { stdout, exitCode } = await runAuth(['auth', 'status']);

    expect(stdout).toContain('Authenticated');
    expect(stdout).toContain('Status User');
    expect(stdout).toContain('10001');
    expect(exitCode).toBeNull();
  });

  it('shows error when no token is configured', async () => {
    // mockConfig has no accessToken — getToken will throw
    const { stderr, exitCode } = await runAuth(['auth', 'status']);

    const combined = stderr + ' ';
    // The error message is printed via console.error
    expect(stderr).toContain('No access token configured');
    // status command does not call process.exit on missing token —
    // it catches the error and prints it
    expect(exitCode).toBeNull();
  });
});

describe('auth token', () => {
  it('displays the current token', async () => {
    mockConfig.accessToken = 'display-me-token-xyz';

    const { stdout, exitCode } = await runAuth(['auth', 'token']);

    expect(stdout).toContain('display-me-token-xyz');
    expect(exitCode).toBeNull();
  });

  it('shows error when no token is configured', async () => {
    const { stderr, exitCode } = await runAuth(['auth', 'token']);

    expect(stderr).toContain('No access token configured');
    expect(exitCode).toBeNull();
  });
});

describe('auth profiles list', () => {
  it('shows empty list message when no profiles exist', async () => {
    (listProfiles as jest.Mock).mockReturnValue([]);

    const { stdout, exitCode } = await runAuth([
      'auth',
      'profiles',
      'list',
    ]);

    expect(stdout).toContain('No profiles saved');
    expect(exitCode).toBeNull();
  });
});

describe('auth profiles current', () => {
  it('shows no active profile message when none is active', async () => {
    (getActiveProfileName as jest.Mock).mockReturnValue(null);

    const { stdout, exitCode } = await runAuth([
      'auth',
      'profiles',
      'current',
    ]);

    expect(stdout).toContain('No active profile');
    expect(exitCode).toBeNull();
  });
});
