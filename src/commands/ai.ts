import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { getAdAccountId } from '../lib/config';
import { AdPilotTemplate } from '../lib/templates';
import { apiGet } from '../lib/api';
import { createSpinner, CTA_TYPES, DATE_PRESETS } from '../utils/helpers';
import { success, error, warn, info, printJson } from '../utils/output';
import {
  executeDeploy,
  printDryRun,
  printDeployResult,
  printPartialResult,
} from './deploy';

// ── Types ───────────────────────────────────────────────────────────────────

type Tone = 'professional' | 'casual' | 'urgent' | 'playful' | 'luxury';

const VALID_TONES: Tone[] = ['professional', 'casual', 'urgent', 'playful', 'luxury'];

interface GenerateCopyOptions {
  product: string;
  description: string;
  audience?: string;
  tone: string;
  variants: string;
  outputFormat: string;
  output?: string;
  json?: boolean;
}

interface ParseCopyOptions {
  input: string;
  product: string;
  url: string;
  country: string;
  dailyBudget: string;
  output?: string;
  deploy?: boolean;
  dryRun?: boolean;
  accountId?: string;
  json?: boolean;
}

interface FeedbackOptions {
  campaign: string;
  datePreset: string;
  output?: string;
  json?: boolean;
}

interface LlmAdVariant {
  headline: string;
  body: string;
  cta: string;
  hook?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildLlmPrompt(opts: {
  product: string;
  description: string;
  audience?: string;
  tone: string;
  variants: number;
  includeTemplateSchema: boolean;
}): string {
  const ctaList = [
    'SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'DOWNLOAD',
    'GET_QUOTE', 'CONTACT_US', 'SUBSCRIBE', 'BUY_NOW', 'ORDER_NOW',
  ].join(', ');

  let prompt = `You are an expert Facebook ads copywriter. Generate ${opts.variants} ad copy variants for the following product.

Product: ${opts.product}
Description: ${opts.description}
Target Audience: ${opts.audience || 'Broad / general audience'}
Tone: ${opts.tone}

For each variant, provide a JSON object with:
- headline (max 40 chars)
- body (max 125 chars)
- cta (one of: ${ctaList})
- hook (the emotional/logical hook being used)

Respond with a JSON array of ${opts.variants} variants:
[
  { "headline": "...", "body": "...", "cta": "...", "hook": "..." },
  ...
]`;

  if (opts.includeTemplateSchema) {
    prompt += `

Also generate the full adpilot template JSON using this schema:

{
  "name": "string - template name",
  "description": "string - template description",
  "campaign": {
    "name": "string - campaign name",
    "objective": "OUTCOME_TRAFFIC | OUTCOME_SALES | OUTCOME_LEADS | OUTCOME_AWARENESS | OUTCOME_ENGAGEMENT | OUTCOME_APP_PROMOTION",
    "status": "PAUSED",
    "special_ad_categories": []
  },
  "adsets": [
    {
      "name": "string - ad set name",
      "billing_event": "IMPRESSIONS",
      "optimization_goal": "LINK_CLICKS",
      "daily_budget": 1500,
      "targeting": { "geo_locations": { "countries": ["US"] } },
      "status": "PAUSED"
    }
  ],
  "ads": [
    {
      "name": "string - ad name",
      "adset_index": 0,
      "creative": {
        "name": "string - creative name",
        "title": "headline from variant",
        "body": "body from variant",
        "link_url": "landing page URL",
        "call_to_action_type": "CTA from variant"
      },
      "status": "PAUSED"
    }
  ]
}

Respond with two JSON blocks:
1. The variants array (as above)
2. The full adpilot template JSON`;
  }

  return prompt;
}

function validateAdVariant(variant: any, index: number): string[] {
  const errors: string[] = [];

  if (!variant.headline || typeof variant.headline !== 'string') {
    errors.push(`Variant ${index + 1}: missing or invalid "headline"`);
  }
  if (!variant.body || typeof variant.body !== 'string') {
    errors.push(`Variant ${index + 1}: missing or invalid "body"`);
  }
  if (!variant.cta || typeof variant.cta !== 'string') {
    errors.push(`Variant ${index + 1}: missing or invalid "cta"`);
  }

  return errors;
}

function buildTemplateFromVariants(opts: {
  product: string;
  url: string;
  country: string;
  dailyBudget: number;
  variants: LlmAdVariant[];
}): AdPilotTemplate {
  const template: AdPilotTemplate = {
    name: `${opts.product} - AI Generated Test`,
    description: `AI-generated ad copy test for ${opts.product} with ${opts.variants.length} variant(s).`,
    campaign: {
      name: `${opts.product} - AI Generated Test`,
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: [],
    },
    adsets: [
      {
        name: `${opts.product} - ${opts.country} Broad`,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        daily_budget: opts.dailyBudget,
        targeting: {
          geo_locations: {
            countries: [opts.country],
          },
        },
        status: 'PAUSED',
      },
    ],
    ads: opts.variants.map((variant, i) => ({
      name: `${opts.product} - Variant ${i + 1} (${variant.cta})`,
      adset_index: 0,
      creative: {
        name: `Creative - ${opts.product} V${i + 1}`,
        title: variant.headline,
        body: variant.body,
        link_url: opts.url,
        call_to_action_type: variant.cta,
      },
      status: 'PAUSED',
    })),
  };

  return template;
}

// ── Command Registration ────────────────────────────────────────────────────

export function registerAiCommands(program: Command): void {
  const ai = program
    .command('ai')
    .description('AI-assisted ad copy generation and feedback tools');

  // ── ai generate-copy ──────────────────────────────────────────────────
  ai
    .command('generate-copy')
    .description('Generate an LLM prompt for ad copy, or prepare a template-format prompt')
    .requiredOption('--product <name>', 'Product/IP name')
    .requiredOption('--description <text>', 'Product description')
    .option('--audience <text>', 'Target audience description')
    .option(
      '--tone <tone>',
      `Brand tone: ${VALID_TONES.join(', ')}`,
      'professional'
    )
    .option('--variants <n>', 'Number of variants to generate', '5')
    .option(
      '--output-format <fmt>',
      'Output format: prompt (LLM prompt) or template (includes template schema)',
      'prompt'
    )
    .option('--output <file>', 'Output file path')
    .option('--json', 'Output as JSON')
    .action(async (opts: GenerateCopyOptions) => {
      try {
        // Validate tone
        const tone = opts.tone.toLowerCase();
        if (!VALID_TONES.includes(tone as Tone)) {
          error(`Invalid tone "${opts.tone}". Must be one of: ${VALID_TONES.join(', ')}`);
          process.exit(1);
        }

        // Validate variants count
        const variantCount = parseInt(opts.variants, 10);
        if (isNaN(variantCount) || variantCount < 1 || variantCount > 20) {
          error('Variants must be a number between 1 and 20.');
          process.exit(1);
        }

        // Validate output format
        const outputFormat = opts.outputFormat.toLowerCase();
        if (outputFormat !== 'prompt' && outputFormat !== 'template') {
          error('Output format must be "prompt" or "template".');
          process.exit(1);
        }

        const prompt = buildLlmPrompt({
          product: opts.product,
          description: opts.description,
          audience: opts.audience,
          tone,
          variants: variantCount,
          includeTemplateSchema: outputFormat === 'template',
        });

        // Output
        if (opts.json) {
          printJson({
            product: opts.product,
            description: opts.description,
            audience: opts.audience || null,
            tone,
            variants: variantCount,
            outputFormat,
            prompt,
          });
        } else if (opts.output) {
          const outputPath = path.resolve(opts.output);
          fs.writeFileSync(outputPath, prompt + '\n');
          success(`LLM prompt written to ${outputPath}`);
          info(`Copy the contents and paste into your preferred LLM.`);
        } else {
          console.log(chalk.bold.cyan('\n--- LLM Ad Copy Prompt ---\n'));
          console.log(prompt);
          console.log(chalk.bold.cyan('\n--- End Prompt ---\n'));
          info('Copy the prompt above and paste it into your preferred LLM (ChatGPT, Claude, etc.).');
          info('Then use `adpilot ai parse-copy --input <file>` to convert the LLM response into a deployable template.');
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── ai parse-copy ─────────────────────────────────────────────────────
  ai
    .command('parse-copy')
    .description('Parse LLM-generated ad copy JSON into a deployable adpilot template')
    .requiredOption('--input <file>', 'Path to JSON file with LLM-generated variants')
    .requiredOption('--product <name>', 'Product/IP name')
    .requiredOption('--url <url>', 'Landing page URL')
    .option('--country <code>', 'Target country code', 'US')
    .option('--daily-budget <cents>', 'Daily budget per ad set in cents', '1500')
    .option('--output <file>', 'Output template file path')
    .option('--deploy', 'Deploy immediately after parsing')
    .option('--dry-run', 'Show deployment plan without deploying')
    .option('--account-id <id>', 'Ad account ID override')
    .option('--json', 'Output as JSON')
    .action(async (opts: ParseCopyOptions) => {
      try {
        // 1. Read and parse input file
        const inputPath = path.resolve(opts.input);
        if (!fs.existsSync(inputPath)) {
          error(`Input file not found: ${inputPath}`);
          process.exit(1);
        }

        const rawContent = fs.readFileSync(inputPath, 'utf-8');
        let variants: LlmAdVariant[];

        try {
          variants = JSON.parse(rawContent);
        } catch (parseErr: any) {
          error(`Failed to parse input JSON: ${parseErr.message}`);
          info('The input file should contain a JSON array of ad copy variants.');
          process.exit(1);
          return; // unreachable but helps TS
        }

        if (!Array.isArray(variants)) {
          error('Input JSON must be an array of ad copy variants.');
          process.exit(1);
          return;
        }

        if (variants.length === 0) {
          error('Input JSON array is empty. Provide at least one variant.');
          process.exit(1);
          return;
        }

        // 2. Validate each variant
        const validationErrors: string[] = [];
        for (let i = 0; i < variants.length; i++) {
          validationErrors.push(...validateAdVariant(variants[i], i));
        }

        if (validationErrors.length > 0) {
          error('Variant validation errors:');
          for (const msg of validationErrors) {
            console.error(chalk.red(`  - ${msg}`));
          }
          process.exit(1);
        }

        info(`Parsed ${variants.length} ad copy variant(s) from ${inputPath}`);

        // 3. Build template
        const dailyBudget = parseInt(opts.dailyBudget, 10);
        if (isNaN(dailyBudget) || dailyBudget <= 0) {
          error('Daily budget must be a positive number (in cents).');
          process.exit(1);
        }

        const template = buildTemplateFromVariants({
          product: opts.product,
          url: opts.url,
          country: opts.country.toUpperCase(),
          dailyBudget,
          variants,
        });

        // Summary
        if (!opts.json) {
          console.log(chalk.bold.cyan('\n--- Parsed Ad Copy Template ---\n'));
          console.log(`  Product:   ${opts.product}`);
          console.log(`  URL:       ${opts.url}`);
          console.log(`  Country:   ${opts.country.toUpperCase()}`);
          console.log(`  Budget:    $${(dailyBudget / 100).toFixed(2)}/day`);
          console.log(`  Variants:  ${variants.length}`);
          variants.forEach((v, i) => {
            console.log(chalk.gray(`\n  [${i + 1}] "${v.headline}"`));
            console.log(chalk.gray(`      ${v.body}`));
            console.log(chalk.gray(`      CTA: ${v.cta}${v.hook ? ` | Hook: ${v.hook}` : ''}`));
          });
          console.log(chalk.bold.cyan('\n--- End Summary ---\n'));
        }

        // 4. Dry run?
        if (opts.dryRun) {
          printDryRun(template);
          return;
        }

        // 5. Write to file?
        if (opts.output) {
          const outputPath = path.resolve(opts.output);
          fs.writeFileSync(outputPath, JSON.stringify(template, null, 2) + '\n');
          success(`Template written to ${outputPath}`);
        }

        // 6. Deploy?
        if (opts.deploy) {
          const accountId = opts.accountId || getAdAccountId();
          const spinner = createSpinner('Deploying AI-generated template...');
          spinner.start();

          try {
            const result = await executeDeploy(template, accountId);
            spinner.stop();
            printDeployResult(result, template, !!opts.json);
          } catch (deployErr: any) {
            spinner.stop();
            error(`Deploy failed: ${deployErr.message}`);
            printPartialResult(
              { adset_ids: [], creative_ids: [], ad_ids: [] },
              template
            );
            process.exit(1);
          }
          return;
        }

        // 7. Otherwise, output as JSON to stdout
        if (!opts.output) {
          printJson(template);
        }
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── ai feedback ───────────────────────────────────────────────────────
  ai
    .command('feedback')
    .description('Generate a performance feedback report to feed back to an LLM for improved copy')
    .requiredOption('--campaign <id>', 'Campaign ID to analyze')
    .option(
      '--date-preset <preset>',
      `Date preset: ${DATE_PRESETS.join(', ')}`,
      'last_7d'
    )
    .option('--output <file>', 'Write feedback report to file')
    .option('--json', 'Output as JSON')
    .action(async (opts: FeedbackOptions) => {
      const spinner = createSpinner('Fetching campaign performance data...');
      spinner.start();

      try {
        // 1. Fetch campaign info
        const campaignData = await apiGet(opts.campaign, {
          fields: 'name,status,objective',
        });
        const campaignName = campaignData.name || opts.campaign;

        // 2. Fetch ad-level insights
        const insightsData = await apiGet(`${opts.campaign}/insights`, {
          fields: 'ad_name,impressions,clicks,spend,cpc,ctr,reach,actions',
          level: 'ad',
          date_preset: opts.datePreset,
        });

        const insightRows = insightsData.data || [];

        if (insightRows.length === 0) {
          spinner.stop();
          warn(`No insight data found for campaign ${opts.campaign} in the "${opts.datePreset}" period.`);
          return;
        }

        // 3. Fetch ad creative details
        const adsData = await apiGet(`${opts.campaign}/ads`, {
          fields: 'name,creative{title,body,call_to_action_type}',
        });
        const adsRows = adsData.data || [];

        // Build a map of ad name -> creative details
        const creativeMap: Record<string, { title: string; body: string; cta: string }> = {};
        for (const ad of adsRows) {
          const title = ad.creative?.title || ad.name || 'Unknown';
          const body = ad.creative?.body || '';
          const cta = ad.creative?.call_to_action_type || 'UNKNOWN';
          creativeMap[ad.name] = { title, body, cta };
        }

        // 4. Process insights
        interface AdPerformance {
          adName: string;
          headline: string;
          body: string;
          cta: string;
          impressions: number;
          clicks: number;
          spend: number;
          ctr: number;
          cpc: number;
          reach: number;
        }

        const adPerformances: AdPerformance[] = insightRows.map((row: any) => {
          const creative = creativeMap[row.ad_name] || {
            title: row.ad_name || 'Unknown',
            body: '',
            cta: 'UNKNOWN',
          };
          return {
            adName: row.ad_name || 'Unknown',
            headline: creative.title,
            body: creative.body,
            cta: creative.cta,
            impressions: parseInt(row.impressions || '0', 10),
            clicks: parseInt(row.clicks || '0', 10),
            spend: parseFloat(row.spend || '0'),
            ctr: parseFloat(row.ctr || '0'),
            cpc: parseFloat(row.cpc || '0'),
            reach: parseInt(row.reach || '0', 10),
          };
        });

        // Sort by CTR descending
        const sorted = [...adPerformances].sort((a, b) => b.ctr - a.ctr);
        const midpoint = Math.ceil(sorted.length / 2);
        const topPerformers = sorted.slice(0, midpoint);
        const underPerformers = sorted.slice(midpoint);

        // 5. Compute CTA performance
        const ctaStats: Record<string, { totalCtr: number; count: number }> = {};
        for (const ad of adPerformances) {
          if (!ctaStats[ad.cta]) {
            ctaStats[ad.cta] = { totalCtr: 0, count: 0 };
          }
          ctaStats[ad.cta].totalCtr += ad.ctr;
          ctaStats[ad.cta].count += 1;
        }

        let bestCta = 'N/A';
        let bestCtaAvgCtr = 0;
        for (const [cta, stats] of Object.entries(ctaStats)) {
          const avgCtr = stats.totalCtr / stats.count;
          if (avgCtr > bestCtaAvgCtr) {
            bestCtaAvgCtr = avgCtr;
            bestCta = cta;
          }
        }

        // Analyze top headline patterns
        const topHeadlines = topPerformers.map((a) => `"${a.headline}"`).join(', ');
        const bottomHeadlines = underPerformers.map((a) => `"${a.headline}"`).join(', ');

        spinner.stop();

        // 6. Build report
        const formatAdLine = (ad: AdPerformance, rank: number): string =>
          `${rank}. Headline: "${ad.headline}" | Body: "${ad.body}" | CTA: ${ad.cta} | CTR: ${ad.ctr.toFixed(2)}% | CPC: $${ad.cpc.toFixed(2)} | Clicks: ${ad.clicks}`;

        const report = `# Campaign Performance Feedback
Campaign: ${campaignName}
Period: ${opts.datePreset}

## Top Performers
${topPerformers.map((a, i) => formatAdLine(a, i + 1)).join('\n')}

## Underperformers
${underPerformers.length > 0 ? underPerformers.map((a, i) => formatAdLine(a, i + 1)).join('\n') : 'N/A - not enough data for comparison'}

## Insights
- Best performing CTA: ${bestCta} (avg CTR: ${bestCtaAvgCtr.toFixed(2)}%)
- Total ads analyzed: ${adPerformances.length}
- Total spend: $${adPerformances.reduce((s, a) => s + a.spend, 0).toFixed(2)}
- Total clicks: ${adPerformances.reduce((s, a) => s + a.clicks, 0)}

## Prompt for Next Iteration
Based on these results, generate ${adPerformances.length} new variants that:
- Build on the winning themes: ${topHeadlines}
- Avoid patterns from losers: ${bottomHeadlines || 'N/A'}
- Try new angles that combine the best CTA (${bestCta}) with fresh headlines
- Maintain the same character limits (headline: 40 chars, body: 125 chars)
`;

        // Output
        if (opts.json) {
          printJson({
            campaign: campaignName,
            campaignId: opts.campaign,
            period: opts.datePreset,
            topPerformers: topPerformers.map((a) => ({
              headline: a.headline,
              body: a.body,
              cta: a.cta,
              ctr: a.ctr,
              cpc: a.cpc,
              clicks: a.clicks,
            })),
            underPerformers: underPerformers.map((a) => ({
              headline: a.headline,
              body: a.body,
              cta: a.cta,
              ctr: a.ctr,
              cpc: a.cpc,
              clicks: a.clicks,
            })),
            bestCta,
            bestCtaAvgCtr,
            nextIterationPrompt: report,
          });
        } else if (opts.output) {
          const outputPath = path.resolve(opts.output);
          fs.writeFileSync(outputPath, report);
          success(`Feedback report written to ${outputPath}`);
          info('Feed this report back into your LLM to generate improved ad copy.');
        } else {
          console.log(chalk.bold.cyan('\n--- Campaign Performance Feedback ---\n'));
          console.log(report);
          console.log(chalk.bold.cyan('--- End Feedback ---\n'));
          info('Copy the report above (especially the "Prompt for Next Iteration") and paste it into your LLM.');
        }
      } catch (err: any) {
        spinner.stop();
        error(err.message);
        process.exit(1);
      }
    });
}
