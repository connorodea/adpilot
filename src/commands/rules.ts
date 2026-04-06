import { Command } from 'commander';
import { apiGet, apiPost, apiDelete } from '../lib/api';
import { getAdAccountId } from '../lib/config';
import { output, printRecord, printTable, success, error, info } from '../utils/output';
import { createSpinner, formatDate, truncate } from '../utils/helpers';

// ── Metric mapping for evaluation_spec ──────────────────────────────
const METRIC_FIELD_MAP: Record<string, string> = {
  cost_per: 'cost_per_action_type',
  ctr: 'ctr',
  cpc: 'cpc',
  cpm: 'cpm',
  impressions: 'impressions',
  clicks: 'clicks',
  spend: 'spend',
  reach: 'reach',
};

// ── Action → execution_type mapping ─────────────────────────────────
const ACTION_TYPE_MAP: Record<string, string> = {
  PAUSE: 'PAUSE',
  UNPAUSE: 'UNPAUSE',
  CHANGE_BUDGET: 'CHANGE_BUDGET',
  CHANGE_BID: 'CHANGE_BID',
  SEND_NOTIFICATION: 'SEND_NOTIFICATION',
};

function buildEvaluationSpec(
  metric: string,
  operator: string,
  value: string,
  timePreset: string
): Record<string, any> {
  const field = METRIC_FIELD_MAP[metric] || metric;
  const numValue = parseFloat(value);

  return {
    evaluation_type: 'SCHEDULE',
    filters: [
      {
        field,
        operator,
        value: numValue,
      },
      {
        field: 'time_preset',
        operator: 'EQUAL',
        value: timePreset,
      },
    ],
    trigger: {
      type: 'STATS_CHANGE',
      field,
      operator,
      value: numValue,
    },
  };
}

function buildExecutionSpec(
  action: string,
  actionValue?: string
): Record<string, any> {
  const executionType = ACTION_TYPE_MAP[action] || action;
  const spec: Record<string, any> = {
    execution_type: executionType,
  };

  if (actionValue && (action === 'CHANGE_BUDGET' || action === 'CHANGE_BID')) {
    spec.execution_options = [
      {
        field: action === 'CHANGE_BUDGET' ? 'daily_budget' : 'bid_amount',
        value: actionValue,
        operator: 'SET',
      },
    ];
  }

  return spec;
}

function formatScheduleType(spec: any): string {
  if (!spec) return '-';
  return spec.schedule_type || spec.type || '-';
}

function formatEvaluationSummary(spec: any): string {
  if (!spec) return '-';
  const filters = spec.filters || [];
  return filters
    .filter((f: any) => f.field !== 'time_preset')
    .map((f: any) => `${f.field} ${f.operator} ${f.value}`)
    .join(', ') || '-';
}

function formatExecutionSummary(spec: any): string {
  if (!spec) return '-';
  const type = spec.execution_type || '-';
  const opts = spec.execution_options;
  if (opts && opts.length > 0) {
    return `${type} (${opts.map((o: any) => `${o.field}=${o.value}`).join(', ')})`;
  }
  return type;
}

export function registerRulesCommands(program: Command): void {
  const rules = program
    .command('rules')
    .alias('rule')
    .description('Manage automated ad rules');

  // ── LIST ─────────────────────────────────────────────────────────
  rules
    .command('list')
    .alias('ls')
    .description('List ad rules in your ad account')
    .option('--account-id <id>', 'Ad account ID')
    .option('--limit <n>', 'Max results', '25')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const spinner = createSpinner('Fetching ad rules...');
      spinner.start();
      try {
        const accountId = opts.accountId || getAdAccountId();
        const fields = 'id,name,status,evaluation_spec,execution_spec,schedule_spec,created_time,updated_time';
        const params: Record<string, any> = { fields, limit: opts.limit };

        const data = await apiGet(`${accountId}/adrules_library`, params);
        spinner.stop();

        if (opts.json) {
          output(data.data, 'json');
        } else {
          const rows = (data.data || []).map((r: any) => [
            r.id,
            truncate(r.name, 30),
            r.status || '-',
            formatScheduleType(r.schedule_spec),
            formatDate(r.created_time),
          ]);
          printTable(
            ['ID', 'Name', 'Status', 'Schedule', 'Created'],
            rows,
            'Ad Rules'
          );
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── GET ──────────────────────────────────────────────────────────
  rules
    .command('get <ruleId>')
    .description('Get detailed information about an ad rule')
    .option('--json', 'Output as JSON')
    .action(async (ruleId, opts) => {
      const spinner = createSpinner('Fetching rule details...');
      spinner.start();
      try {
        const fields = 'id,name,status,evaluation_spec,execution_spec,schedule_spec,entity_type,filter_ids,created_time,updated_time';
        const data = await apiGet(ruleId, { fields });
        spinner.stop();

        if (opts.json) {
          output(data, 'json');
        } else {
          const record: Record<string, any> = {
            'ID': data.id || '-',
            'Name': data.name || '-',
            'Status': data.status || '-',
            'Entity Type': data.entity_type || '-',
            'Conditions': formatEvaluationSummary(data.evaluation_spec),
            'Actions': formatExecutionSummary(data.execution_spec),
            'Schedule': formatScheduleType(data.schedule_spec),
            'Applied To': data.filter_ids ? data.filter_ids.join(', ') : '-',
            'Created': formatDate(data.created_time),
            'Updated': formatDate(data.updated_time),
          };
          printRecord(record, 'Ad Rule Details');
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── CREATE ───────────────────────────────────────────────────────
  rules
    .command('create')
    .description('Create an automated ad rule')
    .requiredOption('--name <name>', 'Rule name')
    .requiredOption('--apply-to <ids>', 'Comma-separated campaign/adset/ad IDs')
    .requiredOption('--apply-to-type <type>', 'CAMPAIGN, ADSET, or AD')
    .requiredOption('--metric <metric>', 'Metric: cost_per, ctr, cpc, cpm, impressions, clicks, spend, reach')
    .requiredOption('--operator <op>', 'GREATER_THAN, LESS_THAN, IN_RANGE, NOT_IN_RANGE')
    .requiredOption('--value <value>', 'Threshold value')
    .requiredOption('--action <action>', 'PAUSE, UNPAUSE, CHANGE_BUDGET, CHANGE_BID, SEND_NOTIFICATION')
    .option('--action-value <value>', 'Value for action (e.g., budget amount)')
    .option('--schedule <schedule>', 'SEMI_HOURLY, HOURLY, DAILY', 'DAILY')
    .option('--time-preset <preset>', 'Time window: TODAY, YESTERDAY, LAST_3_DAYS, LAST_7_DAYS, LAST_14_DAYS, LAST_28_DAYS, LIFETIME', 'LAST_7_DAYS')
    .option('--status <status>', 'ENABLED or DISABLED', 'ENABLED')
    .option('--account-id <id>', 'Ad account ID')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const spinner = createSpinner('Creating ad rule...');
      spinner.start();
      try {
        const accountId = opts.accountId || getAdAccountId();
        const filterIds = opts.applyTo.split(',').map((id: string) => id.trim());

        const body: Record<string, any> = {
          name: opts.name,
          evaluation_spec: JSON.stringify(
            buildEvaluationSpec(opts.metric, opts.operator, opts.value, opts.timePreset)
          ),
          execution_spec: JSON.stringify(
            buildExecutionSpec(opts.action, opts.actionValue)
          ),
          schedule_spec: JSON.stringify({
            schedule_type: opts.schedule,
          }),
          entity_type: opts.applyToType,
          filter_ids: JSON.stringify(filterIds),
          status: opts.status,
        };

        const data = await apiPost(`${accountId}/adrules_library`, body);
        spinner.stop();

        if (opts.json) {
          output(data, 'json');
        } else {
          success(`Ad rule "${opts.name}" created with ID: ${data.id}`);
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── PAUSE ────────────────────────────────────────────────────────
  rules
    .command('pause <ruleId>')
    .description('Pause (disable) an ad rule')
    .action(async (ruleId) => {
      const spinner = createSpinner('Pausing rule...');
      spinner.start();
      try {
        await apiPost(ruleId, { status: 'DISABLED' });
        spinner.stop();
        success(`Rule ${ruleId} paused.`);
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── RESUME ───────────────────────────────────────────────────────
  rules
    .command('resume <ruleId>')
    .description('Resume (enable) an ad rule')
    .action(async (ruleId) => {
      const spinner = createSpinner('Resuming rule...');
      spinner.start();
      try {
        await apiPost(ruleId, { status: 'ENABLED' });
        spinner.stop();
        success(`Rule ${ruleId} resumed.`);
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── DELETE ───────────────────────────────────────────────────────
  rules
    .command('delete <ruleId>')
    .alias('rm')
    .description('Delete an ad rule')
    .action(async (ruleId) => {
      const spinner = createSpinner('Deleting rule...');
      spinner.start();
      try {
        await apiDelete(ruleId);
        spinner.stop();
        success(`Rule ${ruleId} deleted.`);
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── QUICK-CREATE ─────────────────────────────────────────────────
  rules
    .command('quick-create')
    .description('Create a rule from common presets')
    .requiredOption('--type <type>', 'Preset: pause-high-cpa, pause-low-ctr, scale-winners, notify-spend')
    .requiredOption('--apply-to <ids>', 'Comma-separated object IDs')
    .requiredOption('--apply-to-type <type>', 'CAMPAIGN, ADSET, or AD')
    .option('--threshold <value>', 'Threshold value (uses preset default if omitted)')
    .option('--account-id <id>', 'Ad account ID')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const spinner = createSpinner('Creating rule from preset...');
      spinner.start();
      try {
        const accountId = opts.accountId || getAdAccountId();
        const filterIds = opts.applyTo.split(',').map((id: string) => id.trim());

        let name: string;
        let metric: string;
        let operator: string;
        let value: number;
        let action: string;
        let actionValue: string | undefined;
        const timePreset = 'LAST_7_DAYS';

        switch (opts.type) {
          case 'pause-high-cpa':
            name = 'Auto-pause: High CPA';
            metric = 'cost_per_action_type';
            operator = 'GREATER_THAN';
            value = opts.threshold ? parseFloat(opts.threshold) : 50;
            action = 'PAUSE';
            break;

          case 'pause-low-ctr':
            name = 'Auto-pause: Low CTR';
            metric = 'ctr';
            operator = 'LESS_THAN';
            value = opts.threshold ? parseFloat(opts.threshold) : 0.5;
            action = 'PAUSE';
            break;

          case 'scale-winners':
            name = 'Auto-scale: High CTR winners';
            metric = 'ctr';
            operator = 'GREATER_THAN';
            value = opts.threshold ? parseFloat(opts.threshold) : 1.5;
            action = 'CHANGE_BUDGET';
            actionValue = '120'; // 120% = increase by 20%
            break;

          case 'notify-spend':
            name = 'Notify: High daily spend';
            metric = 'spend';
            operator = 'GREATER_THAN';
            value = opts.threshold ? parseFloat(opts.threshold) : 100;
            action = 'SEND_NOTIFICATION';
            break;

          default:
            spinner.stop();
            error(`Unknown preset type: ${opts.type}. Choose from: pause-high-cpa, pause-low-ctr, scale-winners, notify-spend`);
            process.exit(1);
            return;
        }

        const evaluationSpec = {
          evaluation_type: 'SCHEDULE',
          filters: [
            {
              field: metric,
              operator,
              value,
            },
            {
              field: 'time_preset',
              operator: 'EQUAL',
              value: timePreset,
            },
          ],
          trigger: {
            type: 'STATS_CHANGE',
            field: metric,
            operator,
            value,
          },
        };

        const executionSpec: Record<string, any> = {
          execution_type: action,
        };
        if (action === 'CHANGE_BUDGET' && actionValue) {
          executionSpec.execution_options = [
            {
              field: 'daily_budget',
              value: actionValue,
              operator: 'INCREASE_BY_PERCENT',
            },
          ];
        }

        const body: Record<string, any> = {
          name,
          evaluation_spec: JSON.stringify(evaluationSpec),
          execution_spec: JSON.stringify(executionSpec),
          schedule_spec: JSON.stringify({ schedule_type: 'DAILY' }),
          entity_type: opts.applyToType,
          filter_ids: JSON.stringify(filterIds),
          status: 'ENABLED',
        };

        const data = await apiPost(`${accountId}/adrules_library`, body);
        spinner.stop();

        if (opts.json) {
          output(data, 'json');
        } else {
          success(`Rule "${name}" created with ID: ${data.id}`);
          info(`  Condition: ${metric} ${operator} ${value}`);
          info(`  Action: ${action}`);
          info(`  Applied to: ${filterIds.join(', ')}`);
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });
}
