#!/usr/bin/env node
// One-shot CLI wrapper. Posts a question to the running ai-service container
// and pretty-prints the transcript + final insight.
//
// Usage (from the host):
//   docker compose exec ai-service npm run --silent cli -- "anything unusual in the last 15 min?"
// or, against an externally exposed port:
//   curl -s -X POST localhost:8088/investigate -H 'content-type: application/json' \
//     -d '{"question":"why is payment slow?"}' | jq

const url = process.env['AI_SERVICE_URL'] ?? 'http://localhost:8088/investigate';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('usage: cli "<your question>"');
    process.exit(2);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('investigation failed:', body);
    process.exit(1);
  }

  console.log(`\n— Investigation transcript (${(body as any).iterations} tool calls, model=${(body as any).model}) —\n`);
  for (const step of (body as any).transcript ?? []) {
    if (step.type === 'tool_call') {
      console.log(`  → ${step.tool_name}(${JSON.stringify(step.tool_arguments)})`);
    } else if (step.type === 'tool_result') {
      const preview = JSON.stringify(step.tool_result).slice(0, 240);
      console.log(`    ↳ ${preview}${preview.length === 240 ? '…' : ''}`);
    } else if (step.type === 'assistant_message' && step.content) {
      console.log(`\n  [thinking] ${step.content}\n`);
    }
  }
  console.log('\n— Insight —\n');
  console.log((body as any).answer);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
