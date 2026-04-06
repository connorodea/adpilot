import Conf from 'conf';
import path from 'path';
import os from 'os';

export interface SavedReport {
  name: string;
  description?: string;
  level: 'account' | 'campaign' | 'adset' | 'ad';
  objectId?: string;
  fields: string;
  datePreset?: string;
  breakdowns?: string;
  createdAt: string;
}

interface ReportsStore {
  reports: SavedReport[];
}

const configDir = path.join(os.homedir(), '.adpilot');

const reportsConfig = new Conf<ReportsStore>({
  projectName: 'adpilot-reports',
  cwd: configDir,
  configName: 'reports',
  defaults: {
    reports: [],
  },
});

/**
 * List all saved report templates.
 */
export function listSavedReports(): SavedReport[] {
  return reportsConfig.get('reports') || [];
}

/**
 * Get a saved report by name.
 */
export function getSavedReport(name: string): SavedReport | undefined {
  const reports = listSavedReports();
  return reports.find((r) => r.name === name);
}

/**
 * Save a new report template (overwrites if name exists).
 */
export function saveReport(report: SavedReport): void {
  const reports = listSavedReports().filter((r) => r.name !== report.name);
  reports.push(report);
  reportsConfig.set('reports', reports);
}

/**
 * Delete a saved report by name. Returns true if found and deleted.
 */
export function deleteReport(name: string): boolean {
  const reports = listSavedReports();
  const filtered = reports.filter((r) => r.name !== name);
  if (filtered.length === reports.length) return false;
  reportsConfig.set('reports', filtered);
  return true;
}
