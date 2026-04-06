import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import { apiGet, apiPost } from '../lib/api';
import { getAdAccountId } from '../lib/config';
import { loadTemplate, resolveVariables, validateTemplate, AdPilotTemplate } from '../lib/templates';
import { executeDeploy, DeployResult, printDryRun } from './deploy';
import { linkCampaign, getProject } from '../lib/registry';
import { printTable, printRecord, printJson, success, error, warn, info } from '../utils/output';
import { createSpinner, parseKeyValue, formatBudget, DATE_PRESETS } from '../utils/helpers';

// ── Types ───────────────────────────────────────────────────────────────────

interface AdEvaluation {
  adId: string;
  adName: string;
  adSetId: string;
  adSetName: string;
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpc: number;
  cpa: number;
  reach: number;
  actions: number;
  verdict: 'winner' | 'loser' | 'too_early';
  violations: string[];
}

interface CycleReport {
  campaignId: string;
  campaignName: string;
  objective: string;
  status: string;
  dateRange: string;
  totalSpend: number;
  totalImpressions: number;
  totalClicks: number;
  totalReach: number;
  totalActions: number;
  avgCtr: number;
  avgCpc: number;
  avgCpa: number;
  adSets: AdSetBreakdown[];
  ads: AdBreakdown[];
  winners: AdBreakdown[];
  losers: AdBreakdown[];
  recommendations: string[];
}

interface AdSetBreakdown {
  adSetId: string;
  adSetName: string;
  budget: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
}

interface AdBreakdown {
  adId: string;
  adName: string;
  adSetId: string;
  adSetName: string;
  impressions: number;
  clicks: number;
  spend: number;
  ctr: number;
  cpc: number;
  cpa: number;
  reach: number;
  actions: number;
  compositeScore: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseVarFlags(rawVars: string[]): Record<string, string> {
  if (!rawVars || rawVars.length === 0) return {};
  return parseKeyValue(rawVars);
}

function collectVar(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Compute a composite score for ranking ads.
 * Score = (CTR_norm * 0.4) + (invCPC_norm * 0.3) + (reach_norm * 0.3)
 */
function computeCompositeScore(ads: AdBreakdown[]): AdBreakdown[] {
  if (ads.length === 0) return ads;

  const ctrs = ads.map((a) => a.ctr);
  const invCpcs = ads.map((a) => (a.cpc > 0 ? 1 / a.cpc : 0));
  const reaches = ads.map((a) => a.reach / 1000);

  const normalize = (values: number[]): number[] => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    if (range === 0) return values.map(() => 0.5);
    return values.map((v) => (v - min) / range);
  };

  const normCtrs = normalize(ctrs);
  const normInvCpcs = normalize(invCpcs);
  const normReaches = normalize(reaches);

  for (let i = 0; i < ads.length; i++) {
    ads[i].compositeScore =
      normCtrs[i] * 0.4 + normInvCpcs[i] * 0.3 + normReaches[i] * 0.3;
  }

  return ads;
}

/**
 * Fetch ad-level insights for a specific campaign.
 */
async function fetchCampaignAdInsights(
  campaignId: string,
  datePreset: string
): Promise<AdBreakdown[]> {
  const insightsParams: Record<string, any> = {
    fields:
      'ad_id,ad_name,adset_id,adset_name,impressions,clicks,spend,cpc,ctr,reach,actions',
    level: 'ad',
    date_preset: datePreset,
  };

  const insightsRes = await apiGet(`${campaignId}/insights`, insightsParams);
  const rows = insightsRes.data || [];
  const ads: AdBreakdown[] = [];

  for (const row of rows) {
    const impressions = parseInt(row.impressions || '0', 10);
    const clicks = parseInt(row.clicks || '0', 10);
    const spend = parseFloat(row.spend || '0');
    const ctr = row.ctr ? parseFloat(row.ctr) : 0;
    const cpc = row.cpc ? parseFloat(row.cpc) : 0;
    const reach = parseInt(row.reach || '0', 10);

    let totalActions = 0;
    if (row.actions && Array.isArray(row.actions)) {
      for (const action of row.actions) {
        totalActions += parseInt(action.value || '0', 10);
      }
    }

    ads.push({
      adId: row.ad_id || '',
      adName: row.ad_name || row.ad_id || '',
      adSetName: row.adset_name || row.adset_id || '',
      adSetId: row.adset_id || '',
      impressions,
      clicks,
      spend,
      ctr,
      cpc,
      cpa: totalActions > 0 ? spend / totalActions : 0,
      reach,
      actions: totalActions,
      compositeScore: 0,
    });
  }

  return ads;
}

/**
 * Fetch ad-set-level insights for a specific campaign.
 */
async function fetchCampaignAdSetInsights(
  campaignId: string,
  datePreset: string
): Promise<AdSetBreakdown[]> {
  const insightsParams: Record<string, any> = {
    fields:
      'adset_id,adset_name,impressions,clicks,spend,cpc,ctr',
    level: 'adset',
    date_preset: datePreset,
  };

  const insightsRes = await apiGet(`${campaignId}/insights`, insightsParams);
  const rows = insightsRes.data || [];
  const adSets: AdSetBreakdown[] = [];

  for (const row of rows) {
    // Fetch budget info for each ad set
    let budget = '-';
    try {
      const adSetData = await apiGet(row.adset_id, {
        fields: 'daily_budget,lifetime_budget',
      });
      if (adSetData.daily_budget) {
        budget = formatBudget(parseInt(adSetData.daily_budget, 10)) + '/day';
      } else if (adSetData.lifetime_budget) {
        budget = formatBudget(parseInt(adSetData.lifetime_budget, 10)) + ' lifetime';
      }
    } catch {
      // Ignore budget fetch errors
    }

    adSets.push({
      adSetId: row.adset_id || '',
      adSetName: row.adset_name || row.adset_id || '',
      budget,
      spend: parseFloat(row.spend || '0'),
      impressions: parseInt(row.impressions || '0', 10),
      clicks: parseInt(row.clicks || '0', 10),
      ctr: row.ctr ? parseFloat(row.ctr) : 0,
      cpc: row.cpc ? parseFloat(row.cpc) : 0,
    });
  }

  return adSets;
}

/**
 * Generate recommendations based on cycle data.
 */
function generateRecommendations(
  winners: AdBreakdown[],
  losers: AdBreakdown[],
  totalSpend: number,
  totalActions: number,
  avgCtr: number
): string[] {
  const recs: string[] = [];

  if (winners.length > 0) {
    const topWinner = winners[0];
    recs.push(
      `Scale budget for "${topWinner.adName}" (score: ${topWinner.compositeScore.toFixed(3)}) — top performer`
    );
  }

  if (losers.length > 0) {
    const worstLoser = losers[losers.length - 1];
    recs.push(
      `Consider pausing "${worstLoser.adName}" (score: ${worstLoser.compositeScore.toFixed(3)}) — underperforming`
    );
  }

  if (avgCtr < 1.0) {
    recs.push('Overall CTR is below 1% — test new creative angles or headlines');
  }

  if (totalActions === 0 && totalSpend > 0) {
    recs.push('No conversions tracked — verify pixel/event setup or add conversion optimization');
  }

  if (winners.length > 0 && losers.length > 0) {
    recs.push('Reallocate budget from losers to winners for improved ROI');
  }

  if (recs.length === 0) {
    recs.push('Campaign is performing within acceptable ranges — continue monitoring');
  }

  return recs;
}

// ── Command Registration ────────────────────────────────────────────────────

export function registerCycleCommands(program: Command): void {
  const cycle = program
    .command('cycle')
    .description('Rapid test cycle orchestrator — deploy, analyze, and optimize in one flow');

  // ── cycle run ───────────────────────────────────────────────────────────
  cycle
    .command('run')
    .description('End-to-end automated test cycle: deploy, analyze, decide, and act')
    .requiredOption('-t, --template <file>', 'Campaign template to deploy')
    .option('--var <key=value...>', 'Template variables', collectVar, [])
    .option('--project <id>', 'Link deployed campaign to this project')
    .option('--monitor-after <hours>', 'Hours to wait before analyzing (informational)', '24')
    .option('--min-impressions <n>', 'Min impressions before evaluating', '100')
    .option('--min-ctr <pct>', 'CTR threshold to keep (%)', '0.5')
    .option('--max-cpc <dollars>', 'Max CPC to keep ($)', '5')
    .option('--max-cpa <dollars>', 'Max CPA to keep ($)', '50')
    .option('--scale-winners <mult>', 'Budget multiplier for winners', '1.5')
    .option('--kill-losers', 'Auto-pause underperformers')
    .option('--account-id <id>', 'Ad account ID override')
    .option('--dry-run', 'Show plan without executing')
    .option('--json', 'JSON output')
    .action(async (opts) => {
      try {
        const accountId = opts.accountId || getAdAccountId();
        const minImpressions = parseInt(opts.minImpressions, 10);
        const minCtr = parseFloat(opts.minCtr);
        const maxCpc = parseFloat(opts.maxCpc);
        const maxCpa = parseFloat(opts.maxCpa);
        const scaleMultiplier = parseFloat(opts.scaleWinners);

        // ── 1. Deploy Phase ─────────────────────────────────────────────
        info('Phase 1: Deploy');

        const template = loadTemplate(opts.template);
        info(`Loaded template: ${template.name}`);

        const vars = parseVarFlags(opts.var);
        const resolved = resolveVariables(template, vars);

        const validationErrors = validateTemplate(resolved);
        if (validationErrors.length > 0) {
          error('Template validation failed:');
          for (const msg of validationErrors) {
            console.error(chalk.red(`  - ${msg}`));
          }
          process.exit(1);
        }

        if (opts.dryRun) {
          console.log(chalk.yellow('\n  MODE: DRY RUN — showing deploy plan only\n'));
          printDryRun(resolved);

          // Show thresholds that would be applied
          console.log(chalk.bold.cyan('Cycle Thresholds:'));
          console.log(`  Min Impressions: ${minImpressions}`);
          console.log(`  Min CTR:         ${minCtr}%`);
          console.log(`  Max CPC:         $${maxCpc}`);
          console.log(`  Max CPA:         $${maxCpa}`);
          console.log(`  Scale Winners:   ${scaleMultiplier}x`);
          console.log(`  Kill Losers:     ${opts.killLosers ? 'Yes' : 'No'}`);
          if (opts.project) {
            console.log(`  Link to Project: ${opts.project}`);
          }
          console.log();
          warn('Dry run complete. Remove --dry-run to deploy and run the full cycle.');
          return;
        }

        const spinner = createSpinner('Deploying template...');
        spinner.start();

        let deployResult: DeployResult;
        try {
          deployResult = await executeDeploy(resolved, accountId);
          spinner.stop();
          success(`Deployed campaign ${deployResult.campaign_id}`);
          info(`  Ad Sets: ${deployResult.adset_ids.length}, Ads: ${deployResult.ad_ids.length}`);
        } catch (deployErr: any) {
          spinner.stop();
          error(`Deploy failed: ${deployErr.message}`);
          process.exit(1);
          return;
        }

        const campaignId = deployResult.campaign_id!;

        // ── 2. Link Phase ───────────────────────────────────────────────
        if (opts.project) {
          info('Phase 2: Link to Project');
          try {
            linkCampaign(opts.project, campaignId);
            success(`Linked campaign ${campaignId} to project "${opts.project}"`);
          } catch (linkErr: any) {
            warn(`Could not link campaign: ${linkErr.message}`);
          }
        }

        // ── 3. Analyze Phase ────────────────────────────────────────────
        info('Phase 3: Analyze');
        const analyzeSpinner = createSpinner('Fetching campaign insights...');
        analyzeSpinner.start();

        let adInsights: AdBreakdown[];
        try {
          adInsights = await fetchCampaignAdInsights(campaignId, 'last_7d');
          analyzeSpinner.stop();
        } catch (analyzeErr: any) {
          analyzeSpinner.stop();
          warn(`Could not fetch insights: ${analyzeErr.message}`);
          adInsights = [];
        }

        // ── 4. Decide Phase ────────────────────────────────────────────
        info('Phase 4: Evaluate');

        const evaluations: AdEvaluation[] = [];
        const winners: AdEvaluation[] = [];
        const losers: AdEvaluation[] = [];

        if (adInsights.length === 0) {
          info('No ad-level data yet — campaign was just deployed.');
          info(`Check back after ~${opts.monitorAfter}h with: adpilot cycle status ${campaignId}`);
        } else {
          for (const ad of adInsights) {
            const violations: string[] = [];

            if (ad.impressions < minImpressions) {
              evaluations.push({
                adId: ad.adId,
                adName: ad.adName,
                adSetId: ad.adSetId,
                adSetName: ad.adSetName,
                impressions: ad.impressions,
                clicks: ad.clicks,
                spend: ad.spend,
                ctr: ad.ctr,
                cpc: ad.cpc,
                cpa: ad.cpa,
                reach: ad.reach,
                actions: ad.actions,
                verdict: 'too_early',
                violations: [`Only ${ad.impressions} impressions (min: ${minImpressions})`],
              });
              continue;
            }

            if (ad.ctr < minCtr) {
              violations.push(`CTR ${ad.ctr.toFixed(2)}% < ${minCtr}%`);
            }
            if (ad.cpc > maxCpc && ad.cpc > 0) {
              violations.push(`CPC $${ad.cpc.toFixed(2)} > $${maxCpc}`);
            }
            if (ad.cpa > maxCpa && ad.cpa > 0) {
              violations.push(`CPA $${ad.cpa.toFixed(2)} > $${maxCpa}`);
            }

            const verdict = violations.length > 0 ? 'loser' : 'winner';
            const evaluation: AdEvaluation = {
              adId: ad.adId,
              adName: ad.adName,
              adSetId: ad.adSetId,
              adSetName: ad.adSetName,
              impressions: ad.impressions,
              clicks: ad.clicks,
              spend: ad.spend,
              ctr: ad.ctr,
              cpc: ad.cpc,
              cpa: ad.cpa,
              reach: ad.reach,
              actions: ad.actions,
              verdict,
              violations,
            };

            evaluations.push(evaluation);
            if (verdict === 'winner') {
              winners.push(evaluation);
            } else {
              losers.push(evaluation);
            }
          }
        }

        // ── 5. Act Phase ────────────────────────────────────────────────
        const actionsTaken: { target: string; action: string; detail: string }[] = [];

        if (evaluations.length > 0) {
          info('Phase 5: Act');

          // Kill losers
          if (opts.killLosers && losers.length > 0) {
            for (const loser of losers) {
              try {
                await apiPost(loser.adId, { status: 'PAUSED' });
                actionsTaken.push({
                  target: loser.adName,
                  action: 'PAUSED',
                  detail: loser.violations.join('; '),
                });
              } catch (pauseErr: any) {
                actionsTaken.push({
                  target: loser.adName,
                  action: 'PAUSE FAILED',
                  detail: pauseErr.message,
                });
              }
            }
          }

          // Scale winners
          if (scaleMultiplier > 1 && winners.length > 0) {
            const scaledAdSets = new Set<string>();
            for (const winner of winners) {
              if (scaledAdSets.has(winner.adSetId)) continue;
              scaledAdSets.add(winner.adSetId);

              try {
                const adSetData = await apiGet(winner.adSetId, {
                  fields: 'id,name,daily_budget,lifetime_budget',
                });
                const dailyBudget = adSetData.daily_budget
                  ? parseInt(adSetData.daily_budget, 10)
                  : 0;
                const lifetimeBudget = adSetData.lifetime_budget
                  ? parseInt(adSetData.lifetime_budget, 10)
                  : 0;

                if (dailyBudget > 0) {
                  const newBudget = Math.round(dailyBudget * scaleMultiplier);
                  await apiPost(winner.adSetId, {
                    daily_budget: String(newBudget),
                  });
                  actionsTaken.push({
                    target: winner.adSetName,
                    action: 'BUDGET SCALED',
                    detail: `${formatBudget(dailyBudget)} -> ${formatBudget(newBudget)} (${scaleMultiplier}x)`,
                  });
                } else if (lifetimeBudget > 0) {
                  const newBudget = Math.round(lifetimeBudget * scaleMultiplier);
                  await apiPost(winner.adSetId, {
                    lifetime_budget: String(newBudget),
                  });
                  actionsTaken.push({
                    target: winner.adSetName,
                    action: 'BUDGET SCALED',
                    detail: `${formatBudget(lifetimeBudget)} -> ${formatBudget(newBudget)} lifetime (${scaleMultiplier}x)`,
                  });
                }
              } catch (scaleErr: any) {
                actionsTaken.push({
                  target: winner.adSetName || winner.adSetId,
                  action: 'SCALE FAILED',
                  detail: scaleErr.message,
                });
              }
            }
          }
        }

        // ── 6. Report Phase ─────────────────────────────────────────────
        info('Phase 6: Report');

        if (opts.json) {
          printJson({
            cycle: 'complete',
            deployed: {
              campaignId,
              adSetIds: deployResult.adset_ids,
              adIds: deployResult.ad_ids,
              creativeIds: deployResult.creative_ids,
            },
            project: opts.project || null,
            thresholds: { minImpressions, minCtr, maxCpc, maxCpa, scaleMultiplier },
            evaluations,
            winners: winners.length,
            losers: losers.length,
            actions: actionsTaken,
          });
          return;
        }

        console.log(chalk.bold.green('\n=== Cycle Report ===\n'));

        // Deploy summary
        console.log(chalk.bold('Deployed Objects:'));
        console.log(`  Campaign:  ${campaignId}`);
        console.log(`  Ad Sets:   ${deployResult.adset_ids.join(', ')}`);
        console.log(`  Ads:       ${deployResult.ad_ids.join(', ')}`);
        if (opts.project) {
          console.log(`  Project:   ${opts.project}`);
        }
        console.log();

        // Performance table
        if (evaluations.length > 0) {
          const evalRows = evaluations.map((e) => [
            e.adId,
            e.adName,
            `$${e.spend.toFixed(2)}`,
            String(e.impressions),
            `${e.ctr.toFixed(2)}%`,
            e.cpc > 0 ? `$${e.cpc.toFixed(2)}` : '-',
            e.cpa > 0 ? `$${e.cpa.toFixed(2)}` : '-',
            e.verdict === 'winner'
              ? chalk.green('WINNER')
              : e.verdict === 'loser'
              ? chalk.red('LOSER')
              : chalk.gray('TOO EARLY'),
            e.violations.join('; ') || '-',
          ]);

          printTable(
            ['Ad ID', 'Name', 'Spend', 'Impr.', 'CTR', 'CPC', 'CPA', 'Verdict', 'Notes'],
            evalRows,
            'Performance Evaluation'
          );
        } else {
          info('No performance data available yet — campaign was just deployed.');
        }

        // Actions taken
        if (actionsTaken.length > 0) {
          const actionRows = actionsTaken.map((a) => [
            a.target,
            a.action === 'PAUSED'
              ? chalk.red(a.action)
              : a.action === 'BUDGET SCALED'
              ? chalk.green(a.action)
              : chalk.yellow(a.action),
            a.detail,
          ]);

          printTable(['Target', 'Action', 'Detail'], actionRows, 'Actions Taken');
        }

        // Summary
        console.log(chalk.bold('Summary:'));
        console.log(`  Winners:   ${chalk.green(String(winners.length))}`);
        console.log(`  Losers:    ${chalk.red(String(losers.length))}`);
        console.log(
          `  Too Early: ${chalk.gray(
            String(evaluations.filter((e) => e.verdict === 'too_early').length)
          )}`
        );
        console.log(`  Actions:   ${actionsTaken.length}`);
        console.log();

        if (evaluations.length === 0) {
          info(`Run "adpilot cycle status ${campaignId}" after ~${opts.monitorAfter}h to check performance.`);
        }

        success('Cycle complete.');
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── cycle status ────────────────────────────────────────────────────────
  cycle
    .command('status <campaignId>')
    .description('Quick status check on a campaign deployed via a cycle')
    .option(
      '--date-preset <preset>',
      `Date preset: ${DATE_PRESETS.join(', ')}`,
      'last_7d'
    )
    .option('--min-impressions <n>', 'Min impressions threshold', '100')
    .option('--json', 'JSON output')
    .action(async (campaignId, opts) => {
      const spinner = createSpinner('Fetching campaign status...');
      spinner.start();
      try {
        const minImpressions = parseInt(opts.minImpressions, 10);

        // Fetch campaign info
        const campData = await apiGet(campaignId, {
          fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget',
        });

        // Fetch ad-level insights
        const adInsights = await fetchCampaignAdInsights(campaignId, opts.datePreset);
        const scored = computeCompositeScore(adInsights);
        scored.sort((a, b) => b.compositeScore - a.compositeScore);

        // Calculate totals
        let totalSpend = 0;
        let totalImpressions = 0;
        let totalClicks = 0;
        for (const ad of adInsights) {
          totalSpend += ad.spend;
          totalImpressions += ad.impressions;
          totalClicks += ad.clicks;
        }

        // Budget utilization
        const dailyBudget = campData.daily_budget
          ? parseInt(campData.daily_budget, 10)
          : 0;
        const budgetStr = dailyBudget > 0 ? formatBudget(dailyBudget) + '/day' : '-';
        const utilization =
          dailyBudget > 0 ? ((totalSpend / (dailyBudget / 100)) * 100).toFixed(1) + '%' : '-';

        spinner.stop();

        if (opts.json) {
          printJson({
            campaignId: campData.id,
            campaignName: campData.name,
            objective: campData.objective,
            status: campData.effective_status || campData.status,
            budget: budgetStr,
            utilization,
            totalSpend,
            totalImpressions,
            totalClicks,
            ads: scored.map((a) => ({
              ...a,
              verdict:
                a.impressions < minImpressions
                  ? 'too_early'
                  : a.compositeScore >= 0.5
                  ? 'winning'
                  : 'losing',
            })),
          });
          return;
        }

        // Campaign overview
        printRecord(
          {
            'Campaign ID': campData.id,
            Name: campData.name || '-',
            Objective: campData.objective || '-',
            Status: campData.effective_status || campData.status || '-',
            Budget: budgetStr,
            'Total Spend': `$${totalSpend.toFixed(2)}`,
            Impressions: totalImpressions,
            Clicks: totalClicks,
            Utilization: utilization,
          },
          'Campaign Status'
        );

        // Per-ad performance
        if (scored.length > 0) {
          const adRows = scored.map((a, i) => {
            let verdict: string;
            if (a.impressions < minImpressions) {
              verdict = chalk.gray('TOO EARLY');
            } else if (a.compositeScore >= 0.5) {
              verdict = chalk.green('WINNING');
            } else {
              verdict = chalk.red('LOSING');
            }

            return [
              String(i + 1),
              a.adId,
              a.adName,
              `$${a.spend.toFixed(2)}`,
              String(a.impressions),
              `${a.ctr.toFixed(2)}%`,
              a.cpc > 0 ? `$${a.cpc.toFixed(2)}` : '-',
              a.cpa > 0 ? `$${a.cpa.toFixed(2)}` : '-',
              chalk.cyan(a.compositeScore.toFixed(3)),
              verdict,
            ];
          });

          printTable(
            ['#', 'Ad ID', 'Name', 'Spend', 'Impr.', 'CTR', 'CPC', 'CPA', 'Score', 'Verdict'],
            adRows,
            'Per-Ad Performance'
          );
        } else {
          warn('No ad-level insights data available for this campaign.');
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── cycle report ────────────────────────────────────────────────────────
  cycle
    .command('report <campaignId>')
    .description('Generate a detailed cycle report for a campaign')
    .option(
      '--date-preset <preset>',
      `Date preset: ${DATE_PRESETS.join(', ')}`,
      'last_7d'
    )
    .option('--output <file>', 'Write report to file (markdown or JSON)')
    .option('--json', 'JSON output')
    .action(async (campaignId, opts) => {
      const spinner = createSpinner('Generating cycle report...');
      spinner.start();
      try {
        // Fetch campaign info
        const campData = await apiGet(campaignId, {
          fields: 'id,name,objective,status,effective_status',
        });

        // Fetch ad-level insights
        const adInsights = await fetchCampaignAdInsights(campaignId, opts.datePreset);
        const scored = computeCompositeScore(adInsights);
        scored.sort((a, b) => b.compositeScore - a.compositeScore);

        // Fetch ad-set-level insights
        const adSetInsights = await fetchCampaignAdSetInsights(campaignId, opts.datePreset);

        // Calculate totals
        let totalSpend = 0;
        let totalImpressions = 0;
        let totalClicks = 0;
        let totalReach = 0;
        let totalActions = 0;
        for (const ad of adInsights) {
          totalSpend += ad.spend;
          totalImpressions += ad.impressions;
          totalClicks += ad.clicks;
          totalReach += ad.reach;
          totalActions += ad.actions;
        }

        const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
        const avgCpa = totalActions > 0 ? totalSpend / totalActions : 0;

        // Identify winners (top half by score) and losers (bottom half)
        const midpoint = Math.ceil(scored.length / 2);
        const winnersArr = scored.slice(0, midpoint);
        const losersArr = scored.slice(midpoint);

        const recommendations = generateRecommendations(
          winnersArr,
          losersArr,
          totalSpend,
          totalActions,
          avgCtr
        );

        const report: CycleReport = {
          campaignId: campData.id || campaignId,
          campaignName: campData.name || campaignId,
          objective: campData.objective || '-',
          status: campData.effective_status || campData.status || '-',
          dateRange: opts.datePreset,
          totalSpend,
          totalImpressions,
          totalClicks,
          totalReach,
          totalActions,
          avgCtr,
          avgCpc,
          avgCpa,
          adSets: adSetInsights,
          ads: scored,
          winners: winnersArr,
          losers: losersArr,
          recommendations,
        };

        spinner.stop();

        // JSON output
        if (opts.json) {
          if (opts.output) {
            fs.writeFileSync(opts.output, JSON.stringify(report, null, 2));
            success(`Report written to ${opts.output}`);
          } else {
            printJson(report);
          }
          return;
        }

        // Write markdown file if --output given
        if (opts.output) {
          const md = generateMarkdownReport(report);
          fs.writeFileSync(opts.output, md);
          success(`Report written to ${opts.output}`);
          return;
        }

        // Print to console
        console.log(chalk.bold.green('\n=== Cycle Report ===\n'));

        // Campaign overview
        printRecord(
          {
            'Campaign ID': report.campaignId,
            Name: report.campaignName,
            Objective: report.objective,
            Status: report.status,
            'Date Range': report.dateRange,
            'Total Spend': `$${report.totalSpend.toFixed(2)}`,
            Impressions: report.totalImpressions,
            Clicks: report.totalClicks,
            Reach: report.totalReach,
            Actions: report.totalActions,
            'Avg CTR': `${report.avgCtr.toFixed(2)}%`,
            'Avg CPC': `$${report.avgCpc.toFixed(2)}`,
            'Avg CPA': report.avgCpa > 0 ? `$${report.avgCpa.toFixed(2)}` : '-',
          },
          'Campaign Overview'
        );

        // Ad Set breakdown
        if (report.adSets.length > 0) {
          const adSetRows = report.adSets.map((as) => [
            as.adSetId,
            as.adSetName,
            as.budget,
            `$${as.spend.toFixed(2)}`,
            String(as.impressions),
            String(as.clicks),
            `${as.ctr.toFixed(2)}%`,
            as.cpc > 0 ? `$${as.cpc.toFixed(2)}` : '-',
          ]);

          printTable(
            ['Ad Set ID', 'Name', 'Budget', 'Spend', 'Impr.', 'Clicks', 'CTR', 'CPC'],
            adSetRows,
            'Per-Ad-Set Breakdown'
          );
        }

        // Per-ad performance (ranked)
        if (report.ads.length > 0) {
          const adRows = report.ads.map((a, i) => [
            String(i + 1),
            a.adId,
            a.adName,
            `$${a.spend.toFixed(2)}`,
            String(a.impressions),
            `${a.ctr.toFixed(2)}%`,
            a.cpc > 0 ? `$${a.cpc.toFixed(2)}` : '-',
            a.cpa > 0 ? `$${a.cpa.toFixed(2)}` : '-',
            String(a.actions),
            chalk.cyan(a.compositeScore.toFixed(3)),
          ]);

          printTable(
            ['#', 'Ad ID', 'Name', 'Spend', 'Impr.', 'CTR', 'CPC', 'CPA', 'Actions', 'Score'],
            adRows,
            'Per-Ad Performance (Ranked by Score)'
          );
        }

        // Winners
        if (report.winners.length > 0) {
          const winnerRows = report.winners.map((w) => [
            w.adId,
            w.adName,
            chalk.green(w.compositeScore.toFixed(3)),
            `${w.ctr.toFixed(2)}%`,
            `$${w.spend.toFixed(2)}`,
          ]);

          printTable(
            ['Ad ID', 'Name', 'Score', 'CTR', 'Spend'],
            winnerRows,
            'Winners'
          );
        }

        // Losers
        if (report.losers.length > 0) {
          const loserRows = report.losers.map((l) => [
            l.adId,
            l.adName,
            chalk.red(l.compositeScore.toFixed(3)),
            `${l.ctr.toFixed(2)}%`,
            `$${l.spend.toFixed(2)}`,
          ]);

          printTable(
            ['Ad ID', 'Name', 'Score', 'CTR', 'Spend'],
            loserRows,
            'Losers'
          );
        }

        // Recommendations
        console.log(chalk.bold.cyan('\nRecommendations:'));
        for (const rec of report.recommendations) {
          console.log(`  ${chalk.yellow('>')} ${rec}`);
        }
        console.log();

        // ROI summary
        if (report.totalActions > 0) {
          console.log(chalk.bold.cyan('ROI Summary:'));
          console.log(`  Total Spend:       $${report.totalSpend.toFixed(2)}`);
          console.log(`  Total Conversions: ${report.totalActions}`);
          console.log(`  Cost per Action:   $${report.avgCpa.toFixed(2)}`);
          console.log();
        }

        success('Report complete.');
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });
}

/**
 * Generate a markdown-formatted report string.
 */
function generateMarkdownReport(report: CycleReport): string {
  const lines: string[] = [];

  lines.push(`# Cycle Report: ${report.campaignName}`);
  lines.push('');
  lines.push('## Campaign Overview');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Campaign ID | ${report.campaignId} |`);
  lines.push(`| Name | ${report.campaignName} |`);
  lines.push(`| Objective | ${report.objective} |`);
  lines.push(`| Status | ${report.status} |`);
  lines.push(`| Date Range | ${report.dateRange} |`);
  lines.push(`| Total Spend | $${report.totalSpend.toFixed(2)} |`);
  lines.push(`| Impressions | ${report.totalImpressions} |`);
  lines.push(`| Clicks | ${report.totalClicks} |`);
  lines.push(`| Reach | ${report.totalReach} |`);
  lines.push(`| Actions | ${report.totalActions} |`);
  lines.push(`| Avg CTR | ${report.avgCtr.toFixed(2)}% |`);
  lines.push(`| Avg CPC | $${report.avgCpc.toFixed(2)} |`);
  lines.push(`| Avg CPA | ${report.avgCpa > 0 ? '$' + report.avgCpa.toFixed(2) : '-'} |`);
  lines.push('');

  // Ad Set breakdown
  if (report.adSets.length > 0) {
    lines.push('## Per-Ad-Set Breakdown');
    lines.push('');
    lines.push('| Ad Set ID | Name | Budget | Spend | Impr. | Clicks | CTR | CPC |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const as of report.adSets) {
      lines.push(
        `| ${as.adSetId} | ${as.adSetName} | ${as.budget} | $${as.spend.toFixed(2)} | ${as.impressions} | ${as.clicks} | ${as.ctr.toFixed(2)}% | ${as.cpc > 0 ? '$' + as.cpc.toFixed(2) : '-'} |`
      );
    }
    lines.push('');
  }

  // Per-ad performance
  if (report.ads.length > 0) {
    lines.push('## Per-Ad Performance (Ranked by Score)');
    lines.push('');
    lines.push('| # | Ad ID | Name | Spend | Impr. | CTR | CPC | CPA | Actions | Score |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    report.ads.forEach((a, i) => {
      lines.push(
        `| ${i + 1} | ${a.adId} | ${a.adName} | $${a.spend.toFixed(2)} | ${a.impressions} | ${a.ctr.toFixed(2)}% | ${a.cpc > 0 ? '$' + a.cpc.toFixed(2) : '-'} | ${a.cpa > 0 ? '$' + a.cpa.toFixed(2) : '-'} | ${a.actions} | ${a.compositeScore.toFixed(3)} |`
      );
    });
    lines.push('');
  }

  // Winners
  if (report.winners.length > 0) {
    lines.push('## Winners');
    lines.push('');
    for (const w of report.winners) {
      lines.push(`- **${w.adName}** (${w.adId}) — Score: ${w.compositeScore.toFixed(3)}, CTR: ${w.ctr.toFixed(2)}%`);
    }
    lines.push('');
  }

  // Losers
  if (report.losers.length > 0) {
    lines.push('## Losers');
    lines.push('');
    for (const l of report.losers) {
      lines.push(`- **${l.adName}** (${l.adId}) — Score: ${l.compositeScore.toFixed(3)}, CTR: ${l.ctr.toFixed(2)}%`);
    }
    lines.push('');
  }

  // Recommendations
  lines.push('## Recommendations');
  lines.push('');
  for (const rec of report.recommendations) {
    lines.push(`- ${rec}`);
  }
  lines.push('');

  // ROI summary
  if (report.totalActions > 0) {
    lines.push('## ROI Summary');
    lines.push('');
    lines.push(`- Total Spend: $${report.totalSpend.toFixed(2)}`);
    lines.push(`- Total Conversions: ${report.totalActions}`);
    lines.push(`- Cost per Action: $${report.avgCpa.toFixed(2)}`);
    lines.push('');
  }

  return lines.join('\n');
}
