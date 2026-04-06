import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { apiGet } from '../lib/api';
import { getProject, IPProject } from '../lib/registry';
import { createSpinner, DATE_PRESETS, formatBudget } from '../utils/helpers';
import { success, error, warn, info, printJson, printTable, printRecord } from '../utils/output';

// ── Types ───────────────────────────────────────────────────────────────────

interface MarketValidateOptions {
  datePreset: string;
  output?: string;
  format: string;
  json?: boolean;
}

type Verdict = 'STRONG SIGNAL' | 'MODERATE SIGNAL' | 'WEAK SIGNAL' | 'INSUFFICIENT DATA';

interface MarketValidationReport {
  project: {
    id: string;
    name: string;
    description?: string;
    url?: string;
    targetAudience?: string;
    status: string;
    linkedCampaigns: number;
  };
  period: string;
  metrics: {
    totalSpend: number;
    totalImpressions: number;
    totalClicks: number;
    totalReach: number;
    ctr: number;
    cpc: number;
    cpm: number;
    conversions: number;
    conversionRate: number;
    cpa: number;
    roas: number;
    demandScore: number;
  };
  benchmarks: {
    ctrRating: string;
    cpcRating: string;
  };
  verdict: Verdict;
  recommendation: string;
  nextSteps: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function computeVerdict(demandScore: number, ctr: number, impressions: number): {
  verdict: Verdict;
  recommendation: string;
  nextSteps: string[];
} {
  if (impressions < 1000) {
    return {
      verdict: 'INSUFFICIENT DATA',
      recommendation: 'Not enough impressions to evaluate market demand. Continue running ads to gather more data.',
      nextSteps: [
        'Increase daily budget or extend the test period.',
        'Ensure ads are approved and actively delivering.',
        'Check targeting parameters are not too restrictive.',
        'Aim for at least 1,000 impressions before evaluating.',
      ],
    };
  }

  if (demandScore > 3 && ctr > 1) {
    return {
      verdict: 'STRONG SIGNAL',
      recommendation: 'Strong market demand. Recommend scaling.',
      nextSteps: [
        'Increase daily budget to accelerate data collection.',
        'Create additional ad variants to find even better performing copy.',
        'Expand targeting to new demographics or geographies.',
        'Set up conversion tracking if not already in place.',
        'Consider building a landing page or MVP if not already done.',
      ],
    };
  }

  if ((demandScore >= 1 && demandScore <= 3) || (ctr >= 0.5 && ctr <= 1)) {
    return {
      verdict: 'MODERATE SIGNAL',
      recommendation: 'Moderate interest. Consider iterating on messaging or targeting.',
      nextSteps: [
        'Test new ad copy angles and headlines.',
        'Try different target audiences or narrower demographics.',
        'Experiment with different CTAs.',
        'A/B test landing pages if conversion rates are low.',
        'Review underperforming ads and pause them to focus budget.',
      ],
    };
  }

  return {
    verdict: 'WEAK SIGNAL',
    recommendation: 'Weak market response. Consider pivoting or testing different audiences.',
    nextSteps: [
      'Re-evaluate the product/market fit hypothesis.',
      'Test completely different messaging and value propositions.',
      'Try radically different target audiences.',
      'Consider if the product needs repositioning.',
      'Gather qualitative feedback from the few who did engage.',
      'Set a kill threshold and pivot if next iteration also underperforms.',
    ],
  };
}

function rateMetric(value: number, goodThreshold: number, direction: 'higher' | 'lower'): string {
  if (direction === 'higher') {
    return value > goodThreshold ? chalk.green('Good') : chalk.yellow('Below benchmark');
  }
  return value < goodThreshold ? chalk.green('Good') : chalk.yellow('Above benchmark');
}

function verdictColor(verdict: Verdict): string {
  switch (verdict) {
    case 'STRONG SIGNAL':
      return chalk.bold.green(verdict);
    case 'MODERATE SIGNAL':
      return chalk.bold.yellow(verdict);
    case 'WEAK SIGNAL':
      return chalk.bold.red(verdict);
    case 'INSUFFICIENT DATA':
      return chalk.bold.gray(verdict);
  }
}

function buildMarkdownReport(report: MarketValidationReport): string {
  const m = report.metrics;

  let md = `# Market Validation Report: ${report.project.name}

## Project Overview
- **Name:** ${report.project.name}
- **Status:** ${report.project.status}
${report.project.description ? `- **Description:** ${report.project.description}` : ''}
${report.project.url ? `- **URL:** ${report.project.url}` : ''}
${report.project.targetAudience ? `- **Target Audience:** ${report.project.targetAudience}` : ''}
- **Linked Campaigns:** ${report.project.linkedCampaigns}
- **Analysis Period:** ${report.period}

## Performance Metrics

| Metric | Value |
|--------|-------|
| Total Spend | $${m.totalSpend.toFixed(2)} |
| Impressions | ${m.totalImpressions.toLocaleString()} |
| Clicks | ${m.totalClicks.toLocaleString()} |
| Reach | ${m.totalReach.toLocaleString()} |
| CTR | ${m.ctr.toFixed(2)}% |
| CPC | $${m.cpc.toFixed(2)} |
| CPM | $${m.cpm.toFixed(2)} |
| Demand Score | ${m.demandScore.toFixed(2)} |
`;

  if (m.conversions > 0) {
    md += `| Conversions | ${m.conversions} |
| Conversion Rate | ${m.conversionRate.toFixed(2)}% |
| CPA | $${m.cpa.toFixed(2)} |
| ROAS | ${m.roas.toFixed(2)}x |
`;
  }

  md += `
## Benchmarks
- CTR: ${m.ctr.toFixed(2)}% ${m.ctr > 1 ? '(Good - above 1% benchmark)' : '(Below 1% benchmark)'}
- CPC: $${m.cpc.toFixed(2)} ${m.cpc < 2 ? '(Good - below $2 benchmark)' : '(Above $2 benchmark)'}
- Demand Score: ${m.demandScore.toFixed(2)} (clicks/spend*100)

## Verdict: ${report.verdict}

${report.recommendation}

## Next Steps
${report.nextSteps.map((step) => `- ${step}`).join('\n')}
`;

  return md;
}

// ── Command Registration ────────────────────────────────────────────────────

export function registerValidateCommands(program: Command): void {
  const validate = program
    .command('validate')
    .description('Validation and market analysis tools');

  // ── validate market ───────────────────────────────────────────────────
  validate
    .command('market <projectId>')
    .description('Generate a market validation report for a project/IP')
    .option(
      '--date-preset <preset>',
      `Date preset: ${DATE_PRESETS.join(', ')}`,
      'maximum'
    )
    .option('--output <file>', 'Write report to file')
    .option('--format <fmt>', 'Output format: markdown or json', 'markdown')
    .option('--json', 'JSON output (shorthand for --format json)')
    .action(async (projectId: string, opts: MarketValidateOptions) => {
      const spinner = createSpinner('Generating market validation report...');
      spinner.start();

      try {
        // 1. Get project from registry
        const project = getProject(projectId);
        if (!project) {
          spinner.stop();
          error(`Project "${projectId}" not found.`);
          process.exit(1);
          return;
        }

        if (project.campaignIds.length === 0) {
          spinner.stop();
          warn(
            `Project "${projectId}" has no linked campaigns. ` +
            `Link campaigns first with: adpilot projects link ${projectId} <campaignId>`
          );
          return;
        }

        // 2. Fetch insights for all linked campaigns
        const insightsFields = 'campaign_name,impressions,clicks,spend,cpc,ctr,reach,actions';
        const params: Record<string, any> = {
          fields: insightsFields,
          date_preset: opts.datePreset,
        };

        let totalSpend = 0;
        let totalImpressions = 0;
        let totalClicks = 0;
        let totalReach = 0;
        let totalConversions = 0;
        let totalConversionValue = 0;

        for (const campaignId of project.campaignIds) {
          try {
            const data = await apiGet(`${campaignId}/insights`, params);
            const rows = data.data || [];
            for (const row of rows) {
              totalSpend += parseFloat(row.spend || '0');
              totalImpressions += parseInt(row.impressions || '0', 10);
              totalClicks += parseInt(row.clicks || '0', 10);
              totalReach += parseInt(row.reach || '0', 10);

              // Parse conversion actions
              if (row.actions && Array.isArray(row.actions)) {
                for (const action of row.actions) {
                  const actionType = action.action_type || '';
                  if (
                    actionType === 'offsite_conversion' ||
                    actionType === 'purchase' ||
                    actionType === 'lead' ||
                    actionType === 'complete_registration' ||
                    actionType.startsWith('offsite_conversion.')
                  ) {
                    totalConversions += parseInt(action.value || '0', 10);
                  }
                }
              }

              // Parse action values for ROAS
              if (row.action_values && Array.isArray(row.action_values)) {
                for (const av of row.action_values) {
                  const actionType = av.action_type || '';
                  if (
                    actionType === 'offsite_conversion' ||
                    actionType === 'purchase' ||
                    actionType.startsWith('offsite_conversion.')
                  ) {
                    totalConversionValue += parseFloat(av.value || '0');
                  }
                }
              }
            }
          } catch {
            // Skip campaigns with errors - continue gathering what data we can
          }
        }

        // 3. Compute metrics
        const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
        const cpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;
        const conversionRate = totalClicks > 0 ? (totalConversions / totalClicks) * 100 : 0;
        const cpa = totalConversions > 0 ? totalSpend / totalConversions : 0;
        const roas = totalSpend > 0 ? totalConversionValue / totalSpend : 0;
        const demandScore = totalSpend > 0 ? (totalClicks / totalSpend) * 100 : 0;

        // 4. Compute verdict
        const { verdict, recommendation, nextSteps } = computeVerdict(
          demandScore,
          ctr,
          totalImpressions
        );

        spinner.stop();

        // 5. Build report
        const report: MarketValidationReport = {
          project: {
            id: project.id,
            name: project.name,
            description: project.description,
            url: project.url,
            targetAudience: project.targetAudience,
            status: project.status,
            linkedCampaigns: project.campaignIds.length,
          },
          period: opts.datePreset,
          metrics: {
            totalSpend,
            totalImpressions,
            totalClicks,
            totalReach,
            ctr,
            cpc,
            cpm,
            conversions: totalConversions,
            conversionRate,
            cpa,
            roas,
            demandScore,
          },
          benchmarks: {
            ctrRating: ctr > 1 ? 'Good' : 'Below benchmark',
            cpcRating: cpc < 2 ? 'Good' : 'Above benchmark',
          },
          verdict,
          recommendation,
          nextSteps,
        };

        // 6. Output
        const useJson = opts.json || opts.format === 'json';

        if (useJson) {
          printJson(report);
          return;
        }

        // Markdown / terminal output
        if (opts.output) {
          const markdownReport = buildMarkdownReport(report);
          const outputPath = path.resolve(opts.output);
          fs.writeFileSync(outputPath, markdownReport);
          success(`Market validation report written to ${outputPath}`);
          return;
        }

        // Print to terminal
        console.log(chalk.bold.cyan('\n=== Market Validation Report ===\n'));

        // Project overview
        printRecord(
          {
            'Project': project.name,
            'Status': project.status,
            'Description': project.description || '-',
            'URL': project.url || '-',
            'Target Audience': project.targetAudience || '-',
            'Linked Campaigns': project.campaignIds.length,
            'Period': opts.datePreset,
          },
          'Project Overview'
        );

        // Performance metrics
        const metricsRows: [string, string][] = [
          ['Total Spend', `$${totalSpend.toFixed(2)}`],
          ['Impressions', totalImpressions.toLocaleString()],
          ['Clicks', totalClicks.toLocaleString()],
          ['Reach', totalReach.toLocaleString()],
          ['CTR', `${ctr.toFixed(2)}%`],
          ['CPC', `$${cpc.toFixed(2)}`],
          ['CPM', `$${cpm.toFixed(2)}`],
          ['Demand Score', demandScore.toFixed(2)],
        ];

        if (totalConversions > 0) {
          metricsRows.push(
            ['Conversions', String(totalConversions)],
            ['Conversion Rate', `${conversionRate.toFixed(2)}%`],
            ['CPA', `$${cpa.toFixed(2)}`],
            ['ROAS', `${roas.toFixed(2)}x`],
          );
        }

        printTable(
          ['Metric', 'Value'],
          metricsRows,
          'Performance Metrics'
        );

        // Benchmarks
        console.log(chalk.bold('  Benchmarks:'));
        console.log(`    CTR:  ${ctr.toFixed(2)}%  ${rateMetric(ctr, 1, 'higher')}`);
        console.log(`    CPC:  $${cpc.toFixed(2)}  ${rateMetric(cpc, 2, 'lower')}`);
        console.log();

        // Verdict
        console.log(chalk.bold('  Verdict: ') + verdictColor(verdict));
        console.log(`  ${recommendation}`);
        console.log();

        // Next steps
        console.log(chalk.bold('  Next Steps:'));
        for (const step of nextSteps) {
          console.log(`    - ${step}`);
        }
        console.log();
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });
}
