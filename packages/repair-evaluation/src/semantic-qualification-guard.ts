/** Research-only campaign boundary. Call after realization/scoring and again on resume.
 * No provider/runtime imports: dispatch and durable persistence are supplied by the caller. */
export interface QualificationResponse {
  serviceValidation: 'PASS' | 'FAIL';
  score: {
    status: string;
    qualificationEligible: boolean;
    metrics: unknown;
    operations: readonly { attributionStatus?: string }[];
  };
  fixtureValid: boolean;
  contextValid: boolean;
  privacyValid: boolean;
  integrityValid: boolean;
}
export function qualificationResponseFailure(r: QualificationResponse): string | null {
  if (r.serviceValidation !== 'PASS') return 'SERVICE_VALIDATION_FAILED';
  if (r.score.status !== 'SCORED') return `SCORE_${r.score.status}`;
  if (!r.score.qualificationEligible || r.score.metrics === null) return 'SCORE_INELIGIBLE';
  if (
    r.score.operations.some(
      (o) => !['EXACT', 'FRACTIONAL_CLIPPED'].includes(o.attributionStatus ?? ''),
    )
  )
    return 'UNSUPPORTED_READY_ATTRIBUTION';
  if (!r.fixtureValid) return 'INVALID_FIXTURE';
  if (!r.contextValid) return 'INVALID_CONTEXT';
  if (!r.privacyValid) return 'PRIVACY_FAILED';
  if (!r.integrityValid) return 'INTEGRITY_FAILED';
  return null;
}
export interface CompletedResponse {
  id: string;
  response: QualificationResponse;
}
export interface CampaignStop {
  status: 'INFRASTRUCTURE_STOP';
  firstAffectedCase: string;
  reason: string;
  attemptsAlreadyMade: number;
  undispatchedCases: string[];
  truckDispatched: boolean;
}
/** Persist each completed response before a next dispatch; persist stop before returning. */
export async function runQualificationCampaign(options: {
  primary: readonly string[];
  truck: string | null;
  completed: readonly CompletedResponse[];
  priorAttempts: number;
  dispatch: (id: string) => Promise<QualificationResponse>;
  persistCompleted: (record: CompletedResponse) => Promise<void>;
  persistStop: (stop: CampaignStop) => Promise<void>;
}): Promise<CampaignStop | { status: 'COMPLETE'; attemptsAlreadyMade: number }> {
  const all = [...options.primary, ...(options.truck ? [options.truck] : [])];
  const completed = new Set(options.completed.map((r) => r.id));
  let attempts = options.priorAttempts;
  const attempted = new Set(completed);
  const stop = async (id: string, reason: string): Promise<CampaignStop> => {
    const record: CampaignStop = {
      status: 'INFRASTRUCTURE_STOP',
      firstAffectedCase: id,
      reason,
      attemptsAlreadyMade: attempts,
      undispatchedCases: all.filter((c) => !completed.has(c) && c !== id),
      truckDispatched: options.truck !== null && attempted.has(options.truck),
    };
    await options.persistStop(record);
    return record;
  };
  if (
    new Set(all).size !== all.length ||
    options.completed.some((r) => !all.includes(r.id)) ||
    completed.size !== options.completed.length ||
    !Number.isInteger(attempts) ||
    attempts < completed.size
  )
    return stop('CAMPAIGN', 'INVALID_LEDGER');
  for (const prior of options.completed) {
    const reason = qualificationResponseFailure(prior.response);
    if (reason) return stop(prior.id, `RESUME_REFUSED:${reason}`);
  }
  // Unresolved dispatches cannot be silently skipped or retried by a resume.
  if (attempts !== completed.size) return stop('CAMPAIGN', 'UNRESOLVED_PRIOR_ATTEMPT');
  for (const id of all) {
    if (completed.has(id)) continue;
    attempts++;
    attempted.add(id);
    let response: QualificationResponse;
    try {
      response = await options.dispatch(id);
    } catch (error) {
      return stop(id, `DISPATCH_OR_REALIZATION_FAILED:${String(error)}`);
    }
    await options.persistCompleted({ id, response });
    completed.add(id);
    const reason = qualificationResponseFailure(response);
    if (reason) return stop(id, reason);
  }
  return { status: 'COMPLETE', attemptsAlreadyMade: attempts };
}
