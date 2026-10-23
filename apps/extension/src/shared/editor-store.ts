/** Where the background keeps finished resumes for the editor page (session storage), and that page's URL. */

/** Ordered job ids (oldest first) whose resumes are kept in session storage for the editor. */
export const EDITOR_JOBS_KEY = 'seer_editor_jobs';

/** The editor page's query parameter naming the job to show. */
export const EDITOR_JOB_PARAM = 'job';

export function editorPayloadKey(jobId: string): string {
  return `seer_editor_${jobId}`;
}

/** The editor page for `jobId`, relative to the extension's root (for chrome.runtime.getURL). */
export function editorPagePath(jobId: string): string {
  return `editor.html?${EDITOR_JOB_PARAM}=${encodeURIComponent(jobId)}`;
}
