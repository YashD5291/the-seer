import { canLeaveFilesStep } from '../setup/files.js';
import { allGreen, checkRows } from '../setup/checks.js';
import type { CheckInput } from '../setup/checks.js';

/** The popup says "Ready" when every setup check is green, Claude has a file it can read and My files has no problem. */
export function isReady(input: CheckInput): boolean {
  return (
    input.status !== null &&
    allGreen(checkRows(input)) &&
    canLeaveFilesStep(input.status.files, input.status.profileProblem)
  );
}
