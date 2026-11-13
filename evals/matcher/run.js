#!/usr/bin/env node
// Runs the match engine eval and prints what it found.
//
//   npm run eval                 report, and fail if the results differ from baseline.json
//   npm run eval -- --update     accept the current results as the new baseline
//   npm run eval -- --json       the full results as JSON (for scripts)
//   npm run eval -- --case <id>  one case, with the engine's whole decision
//
// See evals/matcher/README.md for what a case is and how to add one.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.YTDLP_AUTO_UPDATE = 'false';

const fs = require('fs');
const { runAll, loadCases, compare, compareRobustness, mergeDiffs, isClean, toBaseline, readBaseline, BASELINE_FILE } = require('./lib');
const { runRobustness } = require('./robustness');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

const pct = (n) => (n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const pad = (text, width) => String(text).padEnd(width);

function printReport({ results, summary }) {
    const o = summary.outcomes;
    console.log(`\nMatch engine eval: ${summary.cases} cases`);
    console.log(`  passed            ${summary.passed}/${summary.cases} (${pct(summary.passRate)})`);
    console.log(`  right video       ${o.correct_match}`);
    console.log(`  rightly refused   ${o.correct_reject}`);
    console.log(`  WRONG VIDEO       ${o.wrong_match}`);
    console.log(`  missed            ${o.miss}`);
    if (o.error || o.wrong_status) console.log(`  error/other       ${o.error + o.wrong_status}`);
    console.log(`  precision         ${pct(summary.precision)}   (of what it played, how much was right)`);
    console.log(`  recall            ${pct(summary.recall)}   (of what could be found, how much it found)`);
    if (summary.preferredPicked) {
        console.log(`  best of several   ${summary.preferredPicked.picked}/${summary.preferredPicked.of}`);
    }

    const cost = summary.cost;
    console.log('\nCost');
    console.log(`  YouTube Music searches  ${cost.innertubeSearches} (${cost.searchesPerCase} per case, ${cost.searchesPerSearchedCase} per case that searched)`);
    console.log(`  yt-dlp runs             ${cost.ytdlpRuns}`);
    console.log(`  cases by search count   ${Object.entries(cost.casesBySearchCount).map(([n, cases]) => `${n} search${n === '1' ? '' : 'es'}: ${cases}`).join(', ')}`);

    for (const [status, t] of Object.entries(cost.byStatus)) {
        console.log(`  ${pad(`ended ${status}`, 23)} ${t.searchesPerCase} searches per case over ${t.cases} cases${t.ytdlpRuns ? `, ${t.ytdlpRuns} yt-dlp runs` : ''}`);
    }

    console.log('\nBy origin');
    for (const [origin, t] of Object.entries(summary.origins)) {
        console.log(`  ${pad(origin, 14)} ${t.passed}/${t.cases}`);
    }
    console.log('\nBy tag');
    for (const [tag, t] of Object.entries(summary.tags).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${pad(tag, 14)} ${pad(`${t.passed}/${t.cases}`, 7)}${t.wrongMatch ? ` wrong video: ${t.wrongMatch}` : ''}`);
    }

    const failed = results.filter((r) => !r.pass);
    if (failed.length) {
        console.log('\nNot passing');
        for (const r of failed) {
            const why = Object.entries(r.reasons).map(([label, reasons]) => `${label}: ${reasons.join('+') || 'ranked lower'}`).join('; ');
            console.log(`  ${pad(r.id, 40)} ${pad(r.outcome, 12)} ${r.picked ? `played "${r.picked}"` : `status ${r.status}`}${why ? `   [${why}]` : ''}`);
        }
    }
}

function printRobustness(r) {
    console.log(`\nRobustness: ${r.checks} generated checks over ${r.pairs} (track, right video) pairs`);
    console.log(`  pairs             ${Object.entries(r.pairOrigins).map(([origin, n]) => `${n} ${origin}`).join(', ')}; ${r.basePassed}/${r.pairs} match as they stand`);
    console.log(`  passed            ${r.passed}/${r.checks} (${pct(r.passed / r.checks)})`);
    for (const kind of ['invariant', 'sensitive']) {
        const rows = Object.entries(r.rewrites).filter(([, t]) => t.kind === kind);
        const total = rows.reduce((n, [, t]) => n + t.checks, 0);
        const ok = rows.reduce((n, [, t]) => n + t.passed, 0);
        console.log(`\n  ${kind === 'invariant' ? 'Must still match' : 'Must stop matching'}: ${ok}/${total}`);
        for (const [name, t] of rows) console.log(`    ${pad(name, 38)} ${t.passed}/${t.checks}`);
    }
    if (r.failures.length) {
        console.log('\n  Not passing');
        for (const f of r.failures) console.log(`    ${f.id}   ${f.outcome}${f.reasons.length ? ` [${f.reasons.join('+')}]` : ''}`);
    }
}

function printDiff(diff) {
    const sections = [
        ['REGRESSIONS (passed before, not now)', diff.regressions],
        ['Improvements (failed before, pass now)', diff.improvements],
        ['Changed (same verdict, different pick or cost)', diff.changed],
        ['New cases (not in the baseline)', diff.added],
        ['Removed cases (still in the baseline)', diff.removed]
    ];
    for (const [title, list] of sections) {
        if (!list.length) continue;
        console.log(`\n${title}`);
        for (const line of list) console.log(`  ${line}`);
    }
}

async function showCase(id) {
    const item = loadCases().find((c) => c.id === id);
    if (!item) {
        console.error(`No case "${id}"`);
        return 2;
    }
    const journal = require('../../services/matcher/journal');
    const { runCase } = require('./lib');
    const initDB = require('../../config/db');
    const db = await initDB(':memory:');
    // runCase restores the sink it found, so this one sees every entry.
    const entries = [];
    journal.hooks.sink = (entry) => entries.push(entry);
    const result = await runCase(db, item);
    journal.hooks.sink = null;
    await db.close();
    console.log(JSON.stringify({ case: item, result }, null, 2));
    return result.pass ? 0 : 1;
}

async function main() {
    if (valueOf('--case')) return showCase(valueOf('--case'));

    const cases = loadCases();
    const run = await runAll(cases);
    run.robustness = await runRobustness(cases, run.results);
    if (has('--json')) {
        console.log(JSON.stringify(run, null, 2));
        return 0;
    }
    printReport(run);
    printRobustness(run.robustness);

    if (has('--update')) {
        fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(toBaseline(run), null, 2)}\n`);
        console.log(`\nBaseline written: ${run.summary.cases} cases, ${run.robustness.checks} robustness checks.`);
        return 0;
    }

    const baseline = readBaseline();
    if (!baseline) {
        console.log('\nNo baseline yet. Run with --update to write one.');
        return 1;
    }
    const diff = mergeDiffs(compare(run.results, baseline), compareRobustness(run.robustness, baseline));
    if (isClean(diff)) {
        console.log('\nSame as the baseline.');
        return 0;
    }
    printDiff(diff);
    console.log(diff.regressions.length
        ? '\nThe engine got worse on the cases above. Fix it, or if the new behaviour is intended, run with --update and say why in the commit.'
        : '\nThe results differ from the baseline. Run with --update to accept them.');
    return 1;
}

main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err);
    process.exitCode = 2;
});
