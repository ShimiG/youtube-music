#!/usr/bin/env node
// Turns an agent's findings JSON into GitHub Issues, one issue per finding.
//
// Used by the scheduled workflows (.github/workflows/security-review.yml and
// product-discovery.yml). Each agent writes a findings file alongside its
// Markdown report; this script opens a tracked issue for every finding that
// passes the status/priority filter.
//
// Idempotent: every issue body carries a hidden `<!-- fingerprint: ... -->`
// marker derived from the agent name and the finding's stable id. Before
// creating an issue the script searches existing issues (any state) for that
// fingerprint and skips it if one exists, so re-runs and double-triggers never
// duplicate a task.
//
// Usage:
//   node scripts/report-to-issues.mjs --input <findings.json> --label <base>
//        [--extra-label <l> ...] [--report-url <url>] [--dry-run]
//
// Auth: uses `gh`, which reads GITHUB_TOKEN / GH_TOKEN from the environment.
// Set DRY_RUN=1 (or pass --dry-run) to print planned actions without calling gh.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// --- args --------------------------------------------------------------------
function parseArgs(argv) {
    const args = { extraLabels: [], dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--input') args.input = argv[++i];
        else if (a === '--label') args.label = argv[++i];
        else if (a === '--extra-label') args.extraLabels.push(argv[++i]);
        else if (a === '--report-url') args.reportUrl = argv[++i];
        else if (a === '--dry-run') args.dryRun = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    if (!args.input) throw new Error('--input <findings.json> is required');
    // --label is optional: it falls back to run.agent / run.labels in the file,
    // so the workflow can process any findings file without per-path config.
    return args;
}

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

// Findings whose status/priority is below this are reported but not turned into
// tasks. Exploiter statuses: confirmed | potential | attempted-failed | info.
// Discovery priorities: high | medium | low.
const ISSUE_WORTHY_STATUS = new Set(['confirmed', 'potential', 'vulnerable', 'high', 'medium']);
const NON_TASK_STATUS = new Set(['attempted-failed', 'not-vulnerable', 'info', 'low']);

// severity/priority -> label suffix, so issues sort and filter by importance.
const LEVEL_LABELS = {
    critical: 'severity:critical', high: 'severity:high', medium: 'severity:medium',
    low: 'severity:low', info: 'severity:info'
};

function gh(args, { allowFail = false } = {}) {
    if (DRY_RUN) {
        console.log(`[dry-run] gh ${args.join(' ')}`);
        return '';
    }
    try {
        return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) {
        if (allowFail) return '';
        throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(err.stderr || err.message).toString().trim()}`);
    }
}

function fingerprint(agent, finding) {
    const stable = finding.id || finding.slug || finding.title || JSON.stringify(finding);
    return createHash('sha1').update(`${agent}:${stable}`).digest('hex').slice(0, 16);
}

function isIssueWorthy(finding) {
    const level = String(finding.status || finding.priority || finding.severity || 'confirmed').toLowerCase();
    if (NON_TASK_STATUS.has(level)) return false;
    if (ISSUE_WORTHY_STATUS.has(level)) return true;
    // Unknown status: default to creating the task rather than dropping it.
    return true;
}

function ensureLabel(name, color, description) {
    // --force makes this idempotent (create or update).
    gh(['label', 'create', name, '--color', color, '--description', description, '--force'], { allowFail: true });
}

// An issue already exists for this fingerprint (any state)?
function issueExists(fp) {
    if (DRY_RUN) {
        console.log(`[dry-run] gh search issues fingerprint ${fp}`);
        return false;
    }
    const out = gh([
        'issue', 'list', '--state', 'all', '--search', `${fp} in:body`,
        '--json', 'number,body', '--limit', '50'
    ], { allowFail: true });
    if (!out) return false;
    try {
        return JSON.parse(out).some(i => (i.body || '').includes(`fingerprint: ${fp}`));
    } catch {
        return false;
    }
}

function buildBody(finding, fp, meta) {
    const lines = [];
    const level = finding.severity || finding.priority || finding.status;
    if (level) lines.push(`**Severity / priority:** ${level}`);
    if (finding.status && finding.status !== level) lines.push(`**Status:** ${finding.status}`);
    if (finding.category) lines.push(`**Category:** ${finding.category}`);
    if (finding.location) lines.push(`**Location:** \`${finding.location}\``);
    if (level || finding.category || finding.location) lines.push('');

    if (finding.description) lines.push('### Description', finding.description, '');
    if (finding.evidence) lines.push('### Evidence / how it was tested', finding.evidence, '');
    if (finding.rationale) lines.push('### Rationale', finding.rationale, '');
    if (finding.suggested_fix) lines.push('### Suggested fix', finding.suggested_fix, '');
    if (finding.size) lines.push(`**Estimated size:** ${finding.size}`, '');

    lines.push('---');
    lines.push(`Filed automatically by the **${meta.agent}** agent on ${meta.date}.`);
    if (meta.reportUrl) lines.push(`Full report: ${meta.reportUrl}`);
    lines.push('');
    lines.push(`<!-- fingerprint: ${fp} -->`);
    return lines.join('\n');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const doc = JSON.parse(readFileSync(args.input, 'utf8'));
    const findings = Array.isArray(doc) ? doc : (doc.findings || []);
    const agent = (doc.run && doc.run.agent) || args.label || 'agent';
    const date = (doc.run && doc.run.date) || new Date().toISOString().slice(0, 10);
    const reportUrl = args.reportUrl || (doc.run && doc.run.report_url) || null;

    // The base label defaults to the agent name; extra labels come from both the
    // command line and the findings file, so a report can declare its own.
    const baseLabel = args.label || agent;
    const fileLabels = (doc.run && Array.isArray(doc.run.labels)) ? doc.run.labels : [];
    const extraLabels = [...new Set([...args.extraLabels, ...fileLabels])].filter(l => l && l !== baseLabel);

    if (!findings.length) {
        console.log('No findings in input; nothing to file.');
        return;
    }

    // Labels used across the board.
    ensureLabel(baseLabel, 'B60205', `Filed by the ${agent} agent`);
    for (const l of extraLabels) ensureLabel(l, '5319E7', l);
    for (const lbl of Object.values(LEVEL_LABELS)) ensureLabel(lbl, 'BFD4F2', lbl);

    let created = 0, skipped = 0, notTask = 0;
    for (const finding of findings) {
        if (!isIssueWorthy(finding)) { notTask++; continue; }

        const fp = fingerprint(agent, finding);
        if (issueExists(fp)) {
            console.log(`skip (exists): ${finding.title}`);
            skipped++;
            continue;
        }

        const labels = [baseLabel, ...extraLabels];
        const level = String(finding.severity || finding.priority || '').toLowerCase();
        if (LEVEL_LABELS[level]) labels.push(LEVEL_LABELS[level]);

        const title = `[${agent}] ${finding.title}`.slice(0, 250);
        const body = buildBody(finding, fp, { agent, date, reportUrl });

        const createArgs = ['issue', 'create', '--title', title, '--body', body];
        for (const l of labels) createArgs.push('--label', l);

        const url = gh(createArgs);
        console.log(`created: ${title}${url ? ` -> ${url}` : ''}`);
        created++;
    }

    console.log(`\nDone. created=${created} skipped=${skipped} not-a-task=${notTask} total=${findings.length}`);
}

main();
