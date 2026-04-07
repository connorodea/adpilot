import { runCli } from './helpers';

jest.setTimeout(15_000);

describe('CLI Bootstrap E2E', () => {
  // --version
  it('prints version and exits 0', async () => {
    const { stdout, exitCode } = await runCli(['--version']);
    expect(stdout.trim()).toBe('1.0.0');
    expect(exitCode).toBe(0);
  });

  it('-v also prints version', async () => {
    const { stdout, exitCode } = await runCli(['-v']);
    expect(stdout.trim()).toBe('1.0.0');
    expect(exitCode).toBe(0);
  });

  // --help
  it('prints help text and exits 0', async () => {
    const { stdout, exitCode } = await runCli(['--help']);
    expect(stdout).toContain('adpilot');
    expect(stdout).toContain('campaigns');
    expect(stdout).toContain('auth');
    expect(stdout).toContain('insights');
    expect(exitCode).toBe(0);
  });

  // Subcommand help
  it('campaigns --help shows subcommands', async () => {
    const { stdout, exitCode } = await runCli(['campaigns', '--help']);
    expect(stdout).toContain('list');
    expect(stdout).toContain('get');
    expect(stdout).toContain('create');
    expect(stdout).toContain('update');
    expect(stdout).toContain('delete');
    expect(exitCode).toBe(0);
  });

  it('auth --help shows subcommands', async () => {
    const { stdout, exitCode } = await runCli(['auth', '--help']);
    expect(stdout).toContain('login');
    expect(stdout).toContain('logout');
    expect(stdout).toContain('status');
    expect(stdout).toContain('token');
    expect(exitCode).toBe(0);
  });

  it('insights --help shows subcommands', async () => {
    const { stdout, exitCode } = await runCli(['insights', '--help']);
    expect(stdout).toContain('account');
    expect(stdout).toContain('campaign');
    expect(stdout).toContain('adset');
    expect(stdout).toContain('ad');
    expect(exitCode).toBe(0);
  });

  // All major commands present in help
  it('help lists all major command groups', async () => {
    const { stdout } = await runCli(['--help']);
    const expectedCommands = [
      'auth', 'config', 'account', 'campaigns', 'adsets', 'ads',
      'creatives', 'insights', 'images', 'videos', 'deploy', 'projects',
      'monitor', 'audiences', 'labels', 'generate', 'completions',
      'bulk', 'batch', 'ai', 'validate', 'rules', 'discover', 'logs',
      'reports', 'cycle', 'budget', 'leads', 'splits', 'targeting',
      'webhooks', 'setup', 'doctor',
    ];
    for (const cmd of expectedCommands) {
      expect(stdout).toContain(cmd);
    }
  });

  // Command aliases work
  it('campaign alias works (singular)', async () => {
    const { stdout, exitCode } = await runCli(['campaign', '--help']);
    expect(stdout).toContain('list');
    expect(exitCode).toBe(0);
  });

  // Unknown command
  it('unknown command exits with error', async () => {
    const { stderr, exitCode } = await runCli(['nonexistent']);
    expect(exitCode).not.toBe(0);
  });
});
