import docJson from '../harness/fixtures/doc.json';
import reportJson from '../harness/fixtures/study-report.json';
import type { StudyReport } from '../src/lib/report';
import type { DocSnapshot } from '../src/lib/types';

/** The fixture prototype: Dashboard to Bank connected, with a few flaws on purpose. */
export function fixtureDoc(): DocSnapshot {
  return JSON.parse(JSON.stringify(docJson)) as DocSnapshot;
}

export function fixtureReport(): StudyReport {
  return JSON.parse(JSON.stringify(reportJson)) as StudyReport;
}

export const PROTO = 'https://www.figma.com/proto/AbCdEfGh1234567890XyZ/Farside-billing';
export const protoAt = (dash: string) => `${PROTO}?node-id=${dash}&starting-point-node-id=1%3A2&scaling=scale-down`;
