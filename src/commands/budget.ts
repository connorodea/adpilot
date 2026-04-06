import { Command } from 'commander';
import chalk from 'chalk';
import { apiGet, apiPost } from '../lib/api';
import { getAdAccountId } from '../lib/config';
import { listProjects, getProject } from '../lib/registry';
import { printTable, printRecord, printJson, success, error, warn, info } from '../utils/output';
import { createSpinner, formatBudget, DATE_PRESETS } from '../utils/helpers';

// ── Types ───────────────────────────────────────────────────────────────────

interface ProjectCampaignData {
  projectId: string;
  projectName: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpc: number;
  actions: number;
  demandScore: number;
  currentDailyBudget: number;
  currentLifetimeBudget: number;
}

interface AllocationEntry {
  projectId: string;
  projectName: string;
  campaignId: string;
  campaignName: string;
  score: number;
  oldBudget: number;
  newBudget: number;
  changePct: number;
  applied: boolean;
  applyError?: string;
}

interface BudgetStatusEntry {
  projectId: string;
  projectName: string;
  campaignCount: number;
  totalDailyBudget: number;
  totalSpend: number;
  utilization: number;
  pace: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch insights and budget data for all campaigns across all active projects.
 */
async function fetchAllProjectCampaignData(
  datePreset: string
): Promise<ProjectCampaignData[]> {
  const projects = listProjects().filter((p) => p.status === 'active');
  const results: ProjectCampaignData[] = [];

  for (const project of projects) {
    for (const campaignId of project.campaignIds) {
      try {
        // Fetch campaign budget
        const campData = await apiGet(campaignId, {
          fields: 'id,name,daily_budget,lifetime_budget,status,effective_status',
        });

        // Skip non-active campaigns
        const effStatus = campData.effective_status || campData.status;
        if (effStatus !== 'ACTIVE' && effStatus !== 'PAUSED') continue;

        // Fetch insights
        const insightsRes = await apiGet(`${campaignId}/insights`, {
          fields: 'campaign_name,impressions,clicks,spend,cpc,ctr,actions',
          date_preset: datePreset,
        });

        const rows = insightsRes.data || [];
        let impressions = 0;
        let clicks = 0;
        let spend = 0;
        let ctr = 0;
        let cpc = 0;
        let totalActions = 0;

        if (rows.length > 0) {
          const row = rows[0];
          impressions = parseInt(row.impressions || '0', 10);
          clicks = parseInt(row.clicks || '0', 10);
          spend = parseFloat(row.spend || '0');
          ctr = row.ctr ? parseFloat(row.ctr) : 0;
          cpc = row.cpc ? parseFloat(row.cpc) : 0;

          if (row.actions && Array.isArray(row.actions)) {
            for (const action of row.actions) {
              totalActions += parseInt(action.value || '0', 10);
            }
          }
        }

        const currentDailyBudget = campData.daily_budget
          ? parseInt(campData.daily_budget, 10)
          : 0;
        const currentLifetimeBudget = campData.lifetime_budget
          ? parseInt(campData.lifetime_budget, 10)
          : 0;

        const demandScore = spend > 0 ? (clicks / spend) * 100 : 0;

        results.push({
          projectId: project.id,
          projectName: project.name,
          campaignId,
          campaignName: campData.name || campaignId,
          impressions,
          clicks,
          spend,
          ctr,
          cpc,
          actions: totalActions,
          demandScore,
          currentDailyBudget,
          currentLifetimeBudget,
        });
      } catch {
        // Skip campaigns that fail to fetch
      }
    }
  }

  return results;
}

/**
 * Compute allocation based on strategy.
 */
function computeAllocation(
  data: ProjectCampaignData[],
  totalBudget: number,
  strategy: string,
  minBudget: number
): AllocationEntry[] {
  if (data.length === 0) return [];

  // Compute raw scores
  const scores: number[] = data.map((d) => {
    switch (strategy) {
      case 'equal':
        return 1;
      case 'performance':
        return Math.max(d.ctr, 0.01); // Use CTR, min 0.01 to avoid zero
      case 'demand_score':
      default:
        return Math.max(d.demandScore, 0.01); // Use demand score, min 0.01
    }
  });

  const totalScore = scores.reduce((sum, s) => sum + s, 0);

  // Calculate proportional allocation
  const allocations: AllocationEntry[] = [];
  let allocatedBudget = 0;

  for (let i = 0; i < data.length; i++) {
    const proportion = scores[i] / totalScore;
    let newBudget = Math.round(totalBudget * proportion);

    // Enforce minimum budget
    if (newBudget < minBudget) {
      newBudget = minBudget;
    }

    const oldBudget = data[i].currentDailyBudget;
    const changePct = oldBudget > 0 ? ((newBudget - oldBudget) / oldBudget) * 100 : 100;

    allocations.push({
      projectId: data[i].projectId,
      projectName: data[i].projectName,
      campaignId: data[i].campaignId,
      campaignName: data[i].campaignName,
      score: scores[i],
      oldBudget,
      newBudget,
      changePct,
      applied: false,
    });

    allocatedBudget += newBudget;
  }

  // If total allocated exceeds budget, scale down proportionally (respecting minimums)
  if (allocatedBudget > totalBudget) {
    const excess = allocatedBudget - totalBudget;
    const adjustable = allocations.filter((a) => a.newBudget > minBudget);
    const adjustableTotal = adjustable.reduce((sum, a) => sum + (a.newBudget - minBudget), 0);

    if (adjustableTotal > 0) {
      for (const alloc of adjustable) {
        const adjustableAmount = alloc.newBudget - minBudget;
        const reduction = Math.round((adjustableAmount / adjustableTotal) * excess);
        alloc.newBudget = Math.max(alloc.newBudget - reduction, minBudget);
        alloc.changePct =
          alloc.oldBudget > 0
            ? ((alloc.newBudget - alloc.oldBudget) / alloc.oldBudget) * 100
            : 100;
      }
    }
  }

  return allocations;
}

// ── Command Registration ────────────────────────────────────────────────────

export function registerBudgetCommands(program: Command): void {
  const budget = program
    .command('budget')
    .description('Dynamic budget allocation and utilization tracking across projects');

  // ── budget allocate ─────────────────────────────────────────────────────
  budget
    .command('allocate')
    .description('Dynamically allocate budget across projects/campaigns based on strategy')
    .requiredOption('--total-budget <cents>', 'Total budget to allocate in cents (e.g., 100000 = $1000)')
    .option(
      '--strategy <strategy>',
      'Allocation strategy: equal, performance, demand_score',
      'demand_score'
    )
    .option(
      '--date-preset <preset>',
      `Date preset: ${DATE_PRESETS.join(', ')}`,
      'last_7d'
    )
    .option('--min-budget <cents>', 'Minimum budget per campaign in cents', '500')
    .option('--dry-run', 'Show allocation plan without applying')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const spinner = createSpinner('Computing budget allocation...');
      spinner.start();
      try {
        const totalBudget = parseInt(opts.totalBudget, 10);
        const minBudget = parseInt(opts.minBudget, 10);
        const strategy = opts.strategy;

        if (isNaN(totalBudget) || totalBudget <= 0) {
          spinner.stop();
          error('--total-budget must be a positive number (in cents).');
          process.exit(1);
          return;
        }

        if (!['equal', 'performance', 'demand_score'].includes(strategy)) {
          spinner.stop();
          error('--strategy must be one of: equal, performance, demand_score');
          process.exit(1);
          return;
        }

        // Fetch data for all project campaigns
        const data = await fetchAllProjectCampaignData(opts.datePreset);

        if (data.length === 0) {
          spinner.stop();
          warn('No active project campaigns found. Create projects and link campaigns first.');
          return;
        }

        // Only allocate to campaigns that have daily budgets (not lifetime)
        const dailyBudgetCampaigns = data.filter(
          (d) => d.currentDailyBudget > 0 || d.currentLifetimeBudget === 0
        );

        if (dailyBudgetCampaigns.length === 0) {
          spinner.stop();
          warn(
            'No campaigns with daily budgets found. Budget allocation only works with daily budget campaigns.'
          );
          return;
        }

        // Compute allocation
        const allocations = computeAllocation(
          dailyBudgetCampaigns,
          totalBudget,
          strategy,
          minBudget
        );

        // Apply if not dry run
        if (!opts.dryRun) {
          for (const alloc of allocations) {
            try {
              await apiPost(alloc.campaignId, {
                daily_budget: String(alloc.newBudget),
              });
              alloc.applied = true;
            } catch (applyErr: any) {
              alloc.applyError = applyErr.message;
            }
          }
        }

        spinner.stop();

        // Output
        if (opts.json) {
          printJson({
            totalBudget: formatBudget(totalBudget),
            strategy,
            datePreset: opts.datePreset,
            dryRun: !!opts.dryRun,
            allocations: allocations.map((a) => ({
              ...a,
              oldBudgetFormatted: formatBudget(a.oldBudget),
              newBudgetFormatted: formatBudget(a.newBudget),
            })),
          });
          return;
        }

        console.log(chalk.bold.cyan('\nBudget Allocation'));
        console.log(
          chalk.gray(
            `  Total: ${formatBudget(totalBudget)}  |  Strategy: ${strategy}  |  Date: ${opts.datePreset}`
          )
        );
        if (opts.dryRun) {
          console.log(chalk.yellow('  MODE: DRY RUN (no changes will be made)\n'));
        } else {
          console.log();
        }

        const tableRows = allocations.map((a) => {
          const changePctStr =
            a.changePct >= 0
              ? chalk.green(`+${a.changePct.toFixed(1)}%`)
              : chalk.red(`${a.changePct.toFixed(1)}%`);

          let statusStr: string;
          if (opts.dryRun) {
            statusStr = chalk.yellow('PLANNED');
          } else if (a.applied) {
            statusStr = chalk.green('APPLIED');
          } else {
            statusStr = chalk.red(a.applyError || 'FAILED');
          }

          return [
            a.projectName,
            a.campaignId,
            a.campaignName,
            formatBudget(a.oldBudget),
            formatBudget(a.newBudget),
            changePctStr,
            a.score.toFixed(2),
            statusStr,
          ];
        });

        printTable(
          ['Project', 'Campaign ID', 'Campaign', 'Old Budget', 'New Budget', 'Change', 'Score', 'Status'],
          tableRows,
          'Allocation Plan'
        );

        const totalAllocated = allocations.reduce((sum, a) => sum + a.newBudget, 0);
        info(
          `Allocated ${formatBudget(totalAllocated)} of ${formatBudget(totalBudget)} across ${allocations.length} campaign(s)`
        );

        if (opts.dryRun) {
          warn('Remove --dry-run to apply these budget changes.');
        } else {
          const applied = allocations.filter((a) => a.applied).length;
          const failed = allocations.filter((a) => !a.applied).length;
          if (applied > 0) {
            success(`${applied} campaign budget(s) updated.`);
          }
          if (failed > 0) {
            error(`${failed} campaign budget(s) failed to update.`);
          }
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── budget status ───────────────────────────────────────────────────────
  budget
    .command('status')
    .description('Show current budget utilization across all projects')
    .option(
      '--date-preset <preset>',
      `Date preset: ${DATE_PRESETS.join(', ')}`,
      'last_7d'
    )
    .option('--json', 'JSON output')
    .action(async (opts) => {
      const spinner = createSpinner('Fetching budget utilization...');
      spinner.start();
      try {
        const projects = listProjects().filter((p) => p.status === 'active');

        if (projects.length === 0) {
          spinner.stop();
          warn('No active projects found.');
          return;
        }

        const statusEntries: BudgetStatusEntry[] = [];

        for (const project of projects) {
          if (project.campaignIds.length === 0) {
            statusEntries.push({
              projectId: project.id,
              projectName: project.name,
              campaignCount: 0,
              totalDailyBudget: 0,
              totalSpend: 0,
              utilization: 0,
              pace: '-',
            });
            continue;
          }

          let totalDailyBudget = 0;
          let totalSpend = 0;
          let campaignCount = 0;

          for (const campaignId of project.campaignIds) {
            try {
              // Fetch campaign budget
              const campData = await apiGet(campaignId, {
                fields: 'id,daily_budget,status,effective_status',
              });

              const effStatus = campData.effective_status || campData.status;
              if (effStatus !== 'ACTIVE') continue;

              campaignCount++;
              const dailyBudget = campData.daily_budget
                ? parseInt(campData.daily_budget, 10)
                : 0;
              totalDailyBudget += dailyBudget;

              // Fetch insights
              const insightsRes = await apiGet(`${campaignId}/insights`, {
                fields: 'spend',
                date_preset: opts.datePreset,
              });

              const rows = insightsRes.data || [];
              if (rows.length > 0) {
                totalSpend += parseFloat(rows[0].spend || '0');
              }
            } catch {
              // Skip problematic campaigns
            }
          }

          // Calculate days in period for utilization estimate
          const daysMap: Record<string, number> = {
            today: 1,
            yesterday: 1,
            last_3d: 3,
            last_7d: 7,
            last_14d: 14,
            last_28d: 28,
            last_30d: 30,
            last_90d: 90,
          };
          const days = daysMap[opts.datePreset] || 7;

          // totalDailyBudget is in cents, totalSpend is in dollars
          const expectedSpend = (totalDailyBudget / 100) * days;
          const utilization = expectedSpend > 0 ? (totalSpend / expectedSpend) * 100 : 0;

          let pace: string;
          if (expectedSpend === 0) {
            pace = 'NO BUDGET';
          } else if (utilization >= 85 && utilization <= 115) {
            pace = 'ON TRACK';
          } else if (utilization < 85) {
            pace = 'UNDERSPENDING';
          } else {
            pace = 'OVERSPENDING';
          }

          statusEntries.push({
            projectId: project.id,
            projectName: project.name,
            campaignCount,
            totalDailyBudget,
            totalSpend,
            utilization,
            pace,
          });
        }

        spinner.stop();

        if (opts.json) {
          printJson(
            statusEntries.map((e) => ({
              ...e,
              totalDailyBudgetFormatted: formatBudget(e.totalDailyBudget),
              totalSpendFormatted: `$${e.totalSpend.toFixed(2)}`,
              utilizationFormatted: `${e.utilization.toFixed(1)}%`,
            }))
          );
          return;
        }

        console.log(chalk.bold.cyan('\nBudget Utilization'));
        console.log(chalk.gray(`  Date preset: ${opts.datePreset}\n`));

        const tableRows = statusEntries.map((e) => {
          let paceColor: string;
          switch (e.pace) {
            case 'ON TRACK':
              paceColor = chalk.green(e.pace);
              break;
            case 'UNDERSPENDING':
              paceColor = chalk.yellow(e.pace);
              break;
            case 'OVERSPENDING':
              paceColor = chalk.red(e.pace);
              break;
            default:
              paceColor = chalk.gray(e.pace);
          }

          return [
            e.projectName,
            String(e.campaignCount),
            e.totalDailyBudget > 0 ? formatBudget(e.totalDailyBudget) + '/day' : '-',
            `$${e.totalSpend.toFixed(2)}`,
            e.utilization > 0 ? `${e.utilization.toFixed(1)}%` : '-',
            paceColor,
          ];
        });

        printTable(
          ['Project', 'Campaigns', 'Daily Budget', 'Spend', 'Utilization', 'Pace'],
          tableRows,
          'Budget Status by Project'
        );

        // Summary
        const totalDailyAll = statusEntries.reduce((s, e) => s + e.totalDailyBudget, 0);
        const totalSpendAll = statusEntries.reduce((s, e) => s + e.totalSpend, 0);
        const activeCampaigns = statusEntries.reduce((s, e) => s + e.campaignCount, 0);

        info(
          `${statusEntries.length} project(s), ${activeCampaigns} active campaign(s), ` +
            `${formatBudget(totalDailyAll)}/day total budget, $${totalSpendAll.toFixed(2)} total spend`
        );
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });
}
