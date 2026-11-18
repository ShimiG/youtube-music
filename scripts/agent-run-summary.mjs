#!/usr/bin/env node
// Says why a Claude run in a workflow ended, without printing its tool output.
//
// claude-code-action hides the run ("full output hidden for security"): tool
// results can hold anything a command printed. When a run fails, the log says
// only "is_error: true". This reads the action's execution file and prints
// what is safe and useful: how the run ended, the error the API or Claude
// Code gave, and Claude's own last words. Never the tool results.
//
// Usage: node scripts/agent-run-summary.mjs <execution-file.json>
import { readFileSync } from 'node:fs';

const MAX_CHARS = 1500;
const cut = (text) => {
    const s = String(text ?? '').trim();
    return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)} …` : s;
};

function textOf(message) {
    const content = message && message.message && message.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n');
}

function main() {
    const file = process.argv[2];
    if (!file) {
        console.log('No execution file: Claude did not start.');
        return;
    }
    let messages;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
        console.log(`The execution file could not be read: ${err.message}`);
        return;
    }

    const result = [...messages].reverse().find((m) => m && m.type === 'result');
    if (result) {
        const parts = [
            `ended: ${result.subtype}${result.is_error ? ' (is_error)' : ''}`,
            result.num_turns !== undefined ? `turns: ${result.num_turns}` : null,
            result.duration_ms !== undefined ? `time: ${Math.round(result.duration_ms / 1000)} s` : null,
            result.total_cost_usd !== undefined ? `cost: $${Number(result.total_cost_usd).toFixed(2)}` : null,
            result.permission_denials_count ? `permission denials: ${result.permission_denials_count}` : null
        ].filter(Boolean);
        console.log(parts.join(' | '));
        if (Array.isArray(result.errors) && result.errors.length) console.log(`errors: ${cut(result.errors.join(' / '))}`);
        if (result.result) console.log(`final message:\n${cut(result.result)}`);
    } else {
        console.log('The run has no result: it was cut off.');
    }

    // An API error ends a run with a short assistant message flagged as such
    // (rate limit, credit, an overloaded or refused request).
    const apiErrors = messages
        .filter((m) => m && m.type === 'assistant' && (m.isApiErrorMessage || m.error || /^API Error/i.test(textOf(m))))
        .map((m) => cut(m.error ? `${m.error}: ${textOf(m)}` : textOf(m)));
    for (const text of [...new Set(apiErrors)].slice(-3)) console.log(`API error: ${text}`);

    if (!result || !result.result) {
        const last = [...messages].reverse().find((m) => m && m.type === 'assistant' && textOf(m).trim());
        if (last) console.log(`Claude's last words:\n${cut(textOf(last))}`);
    }
}

main();
