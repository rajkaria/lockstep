import type { AuditData } from '../audit.js';
import { AUDIT_MARKER, auditMarkdown } from '../format/audit.js';
import type { InstallationClient } from './github-app.js';

/**
 * `[app] audit-issue = true`: the Action's audit issue, kept by the App's daily cron. One
 * open issue whose body starts with the audit marker: opened when something needs fixing,
 * updated while it does, closed with an "All clear" comment when nothing is left. Docs
 * references count as something to fix too (the 0.4 audit lists them).
 */

export interface AuditIssueResult {
  action: 'opened' | 'updated' | 'closed' | 'none';
  number?: number;
  title: string;
}

/** What needs fixing, and the issue title for it (the Action's wording). */
export function auditIssueTitle(d: AuditData): { title: string; todo: number } {
  const mismatched = d.examples.mismatched;
  const failing = d.runCounts.fail;
  const refs = (d.findingCounts?.errors ?? 0) + (d.findingCounts?.warnings ?? 0);
  const title = mismatched
    ? `Docs health ${d.score}/100: ${mismatched} example(s) no longer fit the code`
    : failing
      ? `Docs health ${d.score}/100: ${failing} example(s) fail when run`
      : refs
        ? `Docs health ${d.score}/100: ${refs} docs reference(s) no longer match the repository`
        : `Docs health ${d.score}/100`;
  return { title, todo: mismatched + failing + refs };
}

export async function keepAuditIssue(client: InstallationClient, repo: string, audit: { data: AuditData; summary: string }): Promise<AuditIssueResult> {
  const body = auditMarkdown(audit.data, audit.summary);
  const { title, todo } = auditIssueTitle(audit.data);
  const open = await client.paginate<{ number: number; body?: string | null; pull_request?: unknown }>(`/repos/${repo}/issues?state=open`, { max: 500 });
  const existing = open.find((i) => !i.pull_request && (i.body ?? '').startsWith(AUDIT_MARKER));
  if (existing) {
    await client.patch(`/repos/${repo}/issues/${existing.number}`, { title, body });
    if (todo === 0) {
      await client.post(`/repos/${repo}/issues/${existing.number}/comments`, { body: 'All clear: every docs example and docs reference fits the code again. Closing.' });
      await client.patch(`/repos/${repo}/issues/${existing.number}`, { state: 'closed' });
      return { action: 'closed', number: existing.number, title };
    }
    return { action: 'updated', number: existing.number, title };
  }
  if (!todo) return { action: 'none', title };
  const created = await client.post<{ number: number }>(`/repos/${repo}/issues`, { title, body });
  return { action: 'opened', number: created.number, title };
}
