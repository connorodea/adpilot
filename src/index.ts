#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { registerAuthCommands } from './commands/auth';
import { registerConfigCommands } from './commands/config';
import { registerAccountCommands } from './commands/account';
import { registerCampaignCommands } from './commands/campaigns';
import { registerAdSetCommands } from './commands/adsets';
import { registerAdCommands } from './commands/ads';
import { registerCreativeCommands } from './commands/creatives';
import { registerInsightsCommands } from './commands/insights';
import { registerImageCommands } from './commands/images';
import { registerDeployCommands } from './commands/deploy';
import { registerProjectCommands } from './commands/projects';
import { registerMonitorCommands } from './commands/monitor';
import { registerAudienceCommands } from './commands/audiences';
import { registerLabelCommands } from './commands/labels';
import { registerGenerateCommands } from './commands/generate';
import { registerCompletionCommands } from './commands/completions';
import { registerBulkCommands } from './commands/bulk';
import { registerAiCommands } from './commands/ai';
import { registerValidateCommands } from './commands/validate';
import { registerRulesCommands } from './commands/rules';
import { registerDiscoverCommands } from './commands/discover';
import { registerLogsCommands } from './commands/logs';
import { registerReportsCommands } from './commands/reports';
import { registerCycleCommands } from './commands/cycle';
import { registerBudgetCommands } from './commands/budget';
import { AdPilotError, ExitCode } from './utils/errors';

const program = new Command();

program
  .name('adpilot')
  .description(
    chalk.bold('adpilot') +
      ' — A powerful CLI for the Meta/Facebook Marketing API.\n\n' +
      'Manage campaigns, ad sets, ads, creatives, and insights from your terminal.\n\n' +
      chalk.gray('Get started:\n') +
      chalk.gray('  $ adpilot auth login              # Set your access token\n') +
      chalk.gray('  $ adpilot config set adAccountId act_XXXXX\n') +
      chalk.gray('  $ adpilot campaigns list           # List your campaigns\n') +
      chalk.gray('  $ adpilot insights account          # View account insights')
  )
  .version('1.0.0', '-v, --version');

// Register all command groups
registerAuthCommands(program);
registerConfigCommands(program);
registerAccountCommands(program);
registerCampaignCommands(program);
registerAdSetCommands(program);
registerAdCommands(program);
registerCreativeCommands(program);
registerInsightsCommands(program);
registerImageCommands(program);
registerDeployCommands(program);
registerProjectCommands(program);
registerMonitorCommands(program);
registerAudienceCommands(program);
registerLabelCommands(program);
registerGenerateCommands(program);
registerCompletionCommands(program);
registerBulkCommands(program);
registerAiCommands(program);
registerValidateCommands(program);
registerRulesCommands(program);
registerDiscoverCommands(program);
registerLogsCommands(program);
registerReportsCommands(program);
registerCycleCommands(program);
registerBudgetCommands(program);

// Global error handling
program.exitOverride();

async function main() {
  try {
    await program.parseAsync(process.argv);
    process.exit(ExitCode.SUCCESS);
  } catch (err: any) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(ExitCode.SUCCESS);
    }
    if (err.code === 'commander.missingMandatoryOptionValue' || err.code === 'commander.missingArgument') {
      // Commander already printed the error
      process.exit(ExitCode.USER_ERROR);
    }

    if (err instanceof AdPilotError) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(err.exitCode);
    }

    // Unknown / unexpected errors default to exit code 1
    console.error(chalk.red(`Error: ${err.message}`));
    process.exit(ExitCode.USER_ERROR);
  }
}

main();
