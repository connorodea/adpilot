import { Command } from 'commander';
import { apiGet, apiPost } from '../lib/api';
import { getAdAccountId } from '../lib/config';
import { output, printTable, printRecord, success, error, info, warn } from '../utils/output';
import { createSpinner, formatDate, truncate } from '../utils/helpers';

// ── Types ───────────────────────────────────────────────────────────

interface SegmentRow {
  breakdown: string;
  segment: string;
  impressions: number;
  clicks: number;
  ctr: number;
  cpc: number;
  cpm: number;
  spend: number;
  rank: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeFloat(val: any): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function safeInt(val: any): number {
  const n = parseInt(val, 10);
  return isNaN(n) ? 0 : n;
}

function rankSegments(
  insights: any[],
  breakdownKey: string,
  minImpressions: number
): SegmentRow[] {
  const segments: SegmentRow[] = [];

  for (const row of insights) {
    const impressions = safeInt(row.impressions);
    if (impressions < minImpressions) continue;

    const segmentLabel = row[breakdownKey] || 'unknown';
    const clicks = safeInt(row.clicks);
    const spend = safeFloat(row.spend);
    const ctr = safeFloat(row.ctr);
    const cpc = safeFloat(row.cpc);
    const cpm = safeFloat(row.cpm);

    segments.push({
      breakdown: breakdownKey,
      segment: segmentLabel,
      impressions,
      clicks,
      ctr,
      cpc,
      cpm,
      spend,
      rank: 0,
    });
  }

  // Rank by CTR descending, then CPC ascending as tiebreaker
  segments.sort((a, b) => {
    if (b.ctr !== a.ctr) return b.ctr - a.ctr;
    return a.cpc - b.cpc;
  });

  segments.forEach((s, i) => {
    s.rank = i + 1;
  });

  return segments;
}

function buildTargetingSpecForSegment(
  segment: SegmentRow
): Record<string, any> | null {
  const targeting: Record<string, any> = {};

  switch (segment.breakdown) {
    case 'age': {
      // age values come as ranges like "18-24", "25-34"
      const parts = segment.segment.split('-');
      if (parts.length === 2) {
        targeting.age_min = parseInt(parts[0], 10);
        targeting.age_max = parseInt(parts[1], 10);
      }
      break;
    }
    case 'gender': {
      // 1 = male, 2 = female in Meta API
      const genderMap: Record<string, number[]> = {
        male: [1],
        female: [2],
        unknown: [1, 2],
      };
      targeting.genders = genderMap[segment.segment.toLowerCase()] || [1, 2];
      break;
    }
    case 'country': {
      targeting.geo_locations = {
        countries: [segment.segment.toUpperCase()],
      };
      break;
    }
    case 'region': {
      targeting.geo_locations = {
        regions: [{ key: segment.segment }],
      };
      break;
    }
    case 'publisher_platform': {
      targeting.publisher_platforms = [segment.segment.toLowerCase()];
      break;
    }
    case 'platform_position': {
      targeting.facebook_positions = [segment.segment.toLowerCase()];
      break;
    }
    case 'impression_device': {
      targeting.device_platforms = [segment.segment.toLowerCase()];
      break;
    }
    default:
      return null;
  }

  return targeting;
}

// ── Command registration ────────────────────────────────────────────

export function registerDiscoverCommands(program: Command): void {
  const discover = program
    .command('discover')
    .description('Audience discovery and optimization engine');

  // ── AUDIENCES ─────────────────────────────────────────────────────
  discover
    .command('audiences <campaignId>')
    .description('Analyze campaign performance by audience breakdowns to discover best segments')
    .option('--date-preset <preset>', 'Date range preset', 'last_7d')
    .option('--breakdowns <list>', 'Comma-separated breakdowns to analyze', 'age,gender,country')
    .option('--min-impressions <n>', 'Min impressions per segment', '50')
    .option('--top <n>', 'Show top N segments', '10')
    .option('--create-adsets', 'Auto-create targeted ad sets for top segments')
    .option('--campaign-id <id>', 'Campaign to create new ad sets in (defaults to same campaign)')
    .option('--daily-budget <cents>', 'Budget for new ad sets in cents', '1500')
    .option('--dry-run', 'Show plan without creating')
    .option('--json', 'Output as JSON')
    .action(async (campaignId, opts) => {
      const spinner = createSpinner('Analyzing audience performance...');
      spinner.start();
      try {
        const breakdowns = opts.breakdowns.split(',').map((b: string) => b.trim());
        const minImpressions = parseInt(opts.minImpressions, 10);
        const topN = parseInt(opts.top, 10);
        const allSegments: SegmentRow[] = [];

        // Fetch insights per breakdown dimension
        for (const breakdown of breakdowns) {
          const params: Record<string, any> = {
            fields: 'impressions,clicks,spend,ctr,cpc,cpm,reach',
            date_preset: opts.datePreset,
            breakdowns: breakdown,
            limit: 100,
          };

          const data = await apiGet(`${campaignId}/insights`, params);
          const segments = rankSegments(data.data || [], breakdown, minImpressions);
          allSegments.push(...segments);
        }

        // Re-rank all segments combined
        allSegments.sort((a, b) => {
          if (b.ctr !== a.ctr) return b.ctr - a.ctr;
          return a.cpc - b.cpc;
        });
        const topSegments = allSegments.slice(0, topN);
        topSegments.forEach((s, i) => {
          s.rank = i + 1;
        });

        spinner.stop();

        if (topSegments.length === 0) {
          warn('No segments found matching the minimum impressions threshold.');
          return;
        }

        if (opts.json) {
          output(topSegments, 'json');
        } else {
          const rows = topSegments.map((s) => [
            s.rank,
            s.breakdown,
            s.segment,
            s.impressions.toLocaleString(),
            s.clicks.toLocaleString(),
            `${s.ctr.toFixed(2)}%`,
            `$${s.cpc.toFixed(2)}`,
            `$${s.cpm.toFixed(2)}`,
          ]);
          printTable(
            ['Rank', 'Breakdown', 'Segment', 'Impressions', 'Clicks', 'CTR', 'CPC', 'CPM'],
            rows,
            'Top Audience Segments'
          );
        }

        // Auto-create ad sets for top segments
        if (opts.createAdsets || opts.dryRun) {
          const targetCampaign = opts.campaignId || campaignId;
          const budget = parseInt(opts.dailyBudget, 10);

          console.log('');
          info(`Planning ad sets for campaign ${targetCampaign} (budget: $${(budget / 100).toFixed(2)}/day)`);

          // Fetch the best performing ad creative from the original campaign
          const adsSpinner = createSpinner('Fetching campaign ads...');
          adsSpinner.start();
          let creativeId: string | undefined;

          try {
            const adsData = await apiGet(`${campaignId}/ads`, {
              fields: 'id,creative{id}',
              limit: 5,
            });
            if (adsData.data && adsData.data.length > 0) {
              creativeId = adsData.data[0].creative?.id;
            }
          } catch {
            // Non-fatal: we can still show the plan without creative
          }
          adsSpinner.stop();

          for (const segment of topSegments) {
            const targeting = buildTargetingSpecForSegment(segment);
            if (!targeting) {
              warn(`  Skipping ${segment.breakdown}=${segment.segment}: cannot auto-build targeting`);
              continue;
            }

            const adSetName = `[Discover] ${segment.breakdown}: ${segment.segment} (CTR ${segment.ctr.toFixed(2)}%)`;

            if (opts.dryRun) {
              info(`  [DRY RUN] Would create ad set: "${truncate(adSetName, 60)}"`);
              info(`    Targeting: ${JSON.stringify(targeting)}`);
              info(`    Budget: $${(budget / 100).toFixed(2)}/day`);
              if (creativeId) info(`    Creative: ${creativeId}`);
            } else if (opts.createAdsets) {
              const createSpinnerAdSet = createSpinner(`Creating ad set: ${truncate(adSetName, 40)}...`);
              createSpinnerAdSet.start();
              try {
                const adSetBody: Record<string, any> = {
                  name: adSetName,
                  campaign_id: targetCampaign,
                  daily_budget: budget,
                  billing_event: 'IMPRESSIONS',
                  optimization_goal: 'LINK_CLICKS',
                  targeting: JSON.stringify(targeting),
                  status: 'PAUSED', // Create paused for safety
                };

                const adSetResult = await apiPost(`${getAdAccountId()}/adsets`, adSetBody);
                createSpinnerAdSet.stop();
                success(`  Created ad set "${truncate(adSetName, 50)}" (ID: ${adSetResult.id})`);

                // Create ad with copied creative if available
                if (creativeId && adSetResult.id) {
                  try {
                    const adBody: Record<string, any> = {
                      name: `Ad for ${segment.segment}`,
                      adset_id: adSetResult.id,
                      creative: JSON.stringify({ creative_id: creativeId }),
                      status: 'PAUSED',
                    };
                    const adResult = await apiPost(`${getAdAccountId()}/ads`, adBody);
                    success(`    Created ad (ID: ${adResult.id}) with creative ${creativeId}`);
                  } catch (adErr: any) {
                    warn(`    Could not create ad with creative: ${adErr.message}`);
                  }
                }
              } catch (createErr: any) {
                createSpinnerAdSet.stop();
                warn(`  Failed to create ad set: ${createErr.message}`);
              }
            }
          }

          if (opts.dryRun) {
            console.log('');
            info('Dry run complete. Use --create-adsets without --dry-run to execute.');
          }
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });

  // ── INTERESTS ─────────────────────────────────────────────────────
  discover
    .command('interests <campaignId>')
    .description('Suggest interest targeting based on campaign performance')
    .option('--date-preset <preset>', 'Date range preset', 'last_7d')
    .option('--json', 'Output as JSON')
    .action(async (campaignId, opts) => {
      const spinner = createSpinner('Analyzing campaign and discovering interests...');
      spinner.start();
      try {
        // 1. Fetch campaign details
        const campaignData = await apiGet(campaignId, {
          fields: 'id,name,objective,status',
        });
        const campaignName = campaignData.name || 'Unknown Campaign';

        // 2. Fetch platform/position performance breakdown
        const platformInsights = await apiGet(`${campaignId}/insights`, {
          fields: 'impressions,clicks,spend,ctr,cpc,cpm',
          date_preset: opts.datePreset,
          breakdowns: 'publisher_platform',
          limit: 20,
        });

        const positionInsights = await apiGet(`${campaignId}/insights`, {
          fields: 'impressions,clicks,spend,ctr,cpc,cpm',
          date_preset: opts.datePreset,
          breakdowns: 'platform_position',
          limit: 50,
        });

        // 3. Search for related interest targets using campaign name keywords
        const accountId = getAdAccountId();
        const searchQuery = campaignName
          .replace(/[^a-zA-Z0-9\s]/g, '')
          .split(/\s+/)
          .filter((w: string) => w.length > 3)
          .slice(0, 3)
          .join(' ');

        let interestSuggestions: any[] = [];
        if (searchQuery.length > 0) {
          try {
            const interestData = await apiGet('search', {
              type: 'adinterest',
              q: searchQuery,
              limit: 15,
            });
            interestSuggestions = interestData.data || [];
          } catch {
            // Interest search may fail silently
          }
        }

        spinner.stop();

        if (opts.json) {
          output({
            campaign: campaignData,
            platform_performance: platformInsights.data,
            position_performance: positionInsights.data,
            suggested_interests: interestSuggestions,
          }, 'json');
          return;
        }

        // Display campaign info
        printRecord({
          'Campaign': campaignName,
          'ID': campaignData.id || '-',
          'Objective': campaignData.objective || '-',
          'Status': campaignData.status || '-',
        }, 'Campaign Overview');

        // Display platform performance
        const platformRows = (platformInsights.data || []).map((row: any) => [
          row.publisher_platform || '-',
          safeInt(row.impressions).toLocaleString(),
          safeInt(row.clicks).toLocaleString(),
          `${safeFloat(row.ctr).toFixed(2)}%`,
          `$${safeFloat(row.cpc).toFixed(2)}`,
          `$${safeFloat(row.spend).toFixed(2)}`,
        ]);

        if (platformRows.length > 0) {
          printTable(
            ['Platform', 'Impressions', 'Clicks', 'CTR', 'CPC', 'Spend'],
            platformRows,
            'Platform Performance'
          );
        }

        // Display position performance
        const positionRows = (positionInsights.data || [])
          .sort((a: any, b: any) => safeFloat(b.ctr) - safeFloat(a.ctr))
          .slice(0, 10)
          .map((row: any) => [
            row.platform_position || '-',
            safeInt(row.impressions).toLocaleString(),
            safeInt(row.clicks).toLocaleString(),
            `${safeFloat(row.ctr).toFixed(2)}%`,
            `$${safeFloat(row.cpc).toFixed(2)}`,
            `$${safeFloat(row.spend).toFixed(2)}`,
          ]);

        if (positionRows.length > 0) {
          printTable(
            ['Position', 'Impressions', 'Clicks', 'CTR', 'CPC', 'Spend'],
            positionRows,
            'Top Positions by CTR'
          );
        }

        // Display interest suggestions
        if (interestSuggestions.length > 0) {
          const interestRows = interestSuggestions.map((interest: any) => [
            interest.id || '-',
            truncate(interest.name || '-', 35),
            safeInt(interest.audience_size_lower_bound).toLocaleString(),
            safeInt(interest.audience_size_upper_bound).toLocaleString(),
            interest.topic || '-',
          ]);
          printTable(
            ['ID', 'Interest', 'Audience Min', 'Audience Max', 'Topic'],
            interestRows,
            'Suggested Interest Targets'
          );
          info(`Search query used: "${searchQuery}"`);
        } else {
          warn('No interest suggestions found. Try a more descriptive campaign name.');
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });
}
