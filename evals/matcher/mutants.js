#!/usr/bin/env node
// Does the eval notice when the engine breaks?
//
// Each mutant below is one small, plausible bug planted in the engine's source
// as it is loaded (nothing on disk changes). The eval is then run against the
// broken engine in a process of its own. A mutant is "caught" when the results
// differ from baseline.json, which is exactly what `npm run eval` and the test
// suite fail on. A mutant that survives is a bug the eval would let through.
//
//   npm run eval:mutants
const { spawnSync } = require('child_process');
const path = require('path');

const MUTANTS = [
    { name: 'duration tolerance 5 s -> 15 s', file: 'services/matcher/score.js',
        find: 'const DEFAULT_TOLERANCE_SEC = 5;', replace: 'const DEFAULT_TOLERANCE_SEC = 15;' },
    { name: 'unofficial uploads accepted', file: 'services/matcher/score.js',
        find: "reasons.push('unofficial');", replace: '' },
    { name: 'artist not checked', file: 'services/matcher/score.js',
        find: "reasons.push('artist');", replace: '' },
    { name: 'live streams accepted', file: 'services/matcher/score.js',
        find: "reasons.push('live');", replace: '' },
    { name: 'variants ignored (live = studio)', file: 'services/matcher/normalize.js',
        find: 'return a.core === b.core && setsEqual(a.variants, b.variants);', replace: 'return a.core === b.core;' },
    { name: 'remaster tag treated as part of the title', file: 'services/matcher/normalize.js',
        find: 'if (/remaster/.test(norm)) {', replace: 'if (false) {' },
    { name: 'accents not folded', file: 'services/matcher/normalize.js',
        find: ".normalize('NFKD').replace(/\\p{M}+/gu, '').toLowerCase()", replace: '.toLowerCase()' },
    { name: 'official videos never searched', file: 'services/matcher/index.js',
        find: 'consider(await videos(rawQuery));', replace: '' },
    { name: 'yt-dlp fallback runs during a rate limit', file: 'services/matcher/index.js',
        find: 'ytsearch.isEnabled() && !rateLimited &&', replace: 'ytsearch.isEnabled() &&' },
    { name: 'ISRC copy ignores the length check', file: 'services/matcher/index.js',
        find: 'return Math.abs(stored - wanted) <= durationTolerance();', replace: 'return true;' },
    { name: 'bare-title retry skipped', file: 'services/matcher/index.js',
        find: 'if (isNew(coreQuery)) consider(await songs(coreQuery));', replace: '' },
    { name: 'guest credits in a video title not parsed', file: 'services/matcher/normalize.js',
        find: 'const trailing = TRAILING_FEAT.exec(base);', replace: 'const trailing = null;' }
];

function plant(mutant) {
    const Module = require('module');
    const target = path.join(__dirname, '..', '..', mutant.file);
    const compile = Module.prototype._compile;
    let planted = false;
    Module.prototype._compile = function (content, filename) {
        if (filename === target) {
            if (!content.includes(mutant.find)) throw new Error(`mutant "${mutant.name}": the text to change is no longer in ${mutant.file}`);
            content = content.replace(mutant.find, mutant.replace);
            planted = true;
        }
        return compile.call(this, content, filename);
    };
    return () => planted;
}

async function runOne(index) {
    process.env.NODE_ENV = 'test';
    process.env.YTDLP_AUTO_UPDATE = 'false';
    const wasPlanted = plant(MUTANTS[index]);
    const { runAll, loadCases, compare, compareRobustness, readBaseline } = require('./lib');
    const { runRobustness } = require('./robustness');
    const cases = loadCases();
    const run = await runAll(cases);
    const robustness = await runRobustness(cases, run.results);
    if (!wasPlanted()) throw new Error('the mutant was never loaded');
    const baseline = readBaseline();
    const count = (diff) => Object.values(diff).reduce((n, list) => n + list.length, 0);
    const labelled = compare(run.results, baseline);
    const robust = compareRobustness(robustness, baseline);
    console.log(JSON.stringify({
        labelled: count(labelled),
        robustness: count(robust),
        wrongVideo: run.summary.outcomes.wrong_match
    }));
}

function main() {
    const one = process.argv.indexOf('--one');
    if (one !== -1) {
        runOne(Number(process.argv[one + 1])).catch((err) => { console.error(err); process.exitCode = 2; });
        return;
    }
    let caught = 0;
    console.log(`\nPlanting ${MUTANTS.length} bugs in the match engine, one at a time\n`);
    MUTANTS.forEach((mutant, index) => {
        const child = spawnSync(process.execPath, [path.join(__dirname, 'mutants.js'), '--one', String(index)], { encoding: 'utf8' });
        if (child.status !== 0) {
            console.log(`  ERROR   ${mutant.name}\n${child.stderr}`);
            process.exitCode = 2;
            return;
        }
        const out = JSON.parse(child.stdout.trim().split('\n').pop());
        const hit = out.labelled + out.robustness > 0;
        if (hit) caught += 1;
        console.log(`  ${hit ? 'caught ' : 'MISSED '} ${mutant.name.padEnd(46)} labelled cases changed: ${String(out.labelled).padStart(3)}   robustness checks changed: ${String(out.robustness).padStart(4)}`);
    });
    console.log(`\n${caught}/${MUTANTS.length} planted bugs caught.`);
    if (caught < MUTANTS.length) process.exitCode = 1;
}

main();
