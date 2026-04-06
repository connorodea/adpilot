import { Command } from 'commander';
import { getLogEntries, getLogFiles, clearLogs, LogEntry } from '../lib/logger';
import { printTable, output, success, info, error } from '../utils/output';
import chalk from 'chalk';

export function registerLogsCommands(program: Command): void {
  const logs = program
    .command('logs')
    .description('View and manage API call logs');

  // logs show
  logs
    .command('show')
    .description('Display API call logs')
    .option('--date <YYYY-MM-DD>', 'Show logs for a specific date (default: today)')
    .option('--limit <n>', 'Limit number of entries shown')
    .option('--status <status>', 'Filter by status: success or error')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        const date = opts.date || new Date().toISOString().slice(0, 10);
        let entries = getLogEntries(date);

        if (entries.length === 0) {
          info(`No log entries found for ${date}.`);
          const files = getLogFiles();
          if (files.length > 0) {
            info(`Available log dates: ${files.map((f) => f.replace('.jsonl', '')).join(', ')}`);
          }
          return;
        }

        if (opts.status) {
          entries = entries.filter((e) => e.status === opts.status);
        }

        if (opts.limit) {
          entries = entries.slice(-parseInt(opts.limit, 10));
        }

        if (opts.json) {
          output(entries, 'json');
          return;
        }

        const headers = ['Time', 'Method', 'Endpoint', 'Status', 'Duration', 'Error'];
        const rows = entries.map((e: LogEntry) => [
          e.timestamp.slice(11, 19),
          e.method,
          truncateEndpoint(e.endpoint),
          e.status === 'success' ? chalk.green('OK') : chalk.red('ERR'),
          `${e.durationMs}ms`,
          e.error ? truncateEndpoint(e.error) : '-',
        ]);

        printTable(headers, rows, `API Logs for ${date}`);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });

  // logs clear
  logs
    .command('clear')
    .description('Delete log files')
    .option('--before <YYYY-MM-DD>', 'Delete logs older than this date')
    .option('--all', 'Delete all log files')
    .action(async (opts) => {
      try {
        if (!opts.before && !opts.all) {
          error('Specify --before <date> or --all to clear logs.');
          process.exit(1);
        }

        const deleted = clearLogs({ before: opts.before, all: opts.all });
        if (deleted === 0) {
          info('No log files to delete.');
        } else {
          success(`Deleted ${deleted} log file(s).`);
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });
}

function truncateEndpoint(str: string): string {
  if (!str) return '-';
  return str.length > 50 ? str.substring(0, 49) + '...' : str;
}
