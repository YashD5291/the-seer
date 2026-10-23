import { isSameJobPage } from '../shared/job-page.js';

/**
 * Whether an analysis may be shown on the tab it was started from. It may only when the tab is
 * still on that page: job boards swap the job without reloading, and a result for the old job
 * must not be drawn over the new one. `currentTabUrl` is undefined when the tab cannot be read.
 */
export function shouldDeliverAnalysis(extractionUrl: string, currentTabUrl: string | undefined): boolean {
  return currentTabUrl !== undefined && isSameJobPage(extractionUrl, currentTabUrl);
}

/**
 * Whether a tab's toolbar badge (the score of its stored job) is out of date once the tab has
 * moved to `newTabUrl`. With no stored job URL there is nothing to compare, so it is left alone.
 */
export function isBadgeStale(storedJobUrl: string | undefined, newTabUrl: string): boolean {
  return storedJobUrl !== undefined && !isSameJobPage(storedJobUrl, newTabUrl);
}
