import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js';
import { config } from './config.js';
import { buildSystemPrompt } from './prompt.js';
import { runTool, toolSchemas } from './tools.js';

export interface TranscriptStep {
  iteration: number;
  type: 'assistant_message' | 'tool_call' | 'tool_result' | 'final_answer' | 'error';
  content?: string;
  tool_name?: string;
  tool_arguments?: unknown;
  tool_result?: unknown;
  truncated?: boolean;
}

export interface InvestigationResult {
  answer: string;
  iterations: number;
  transcript: TranscriptStep[];
  model: string;
  finish_reason: string;
}

const TOOL_RESULT_MAX_CHARS = 6000;

function truncateForLLM(value: unknown): { text: string; truncated: boolean } {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (json.length <= TOOL_RESULT_MAX_CHARS) return { text: json, truncated: false };
  return {
    text: json.slice(0, TOOL_RESULT_MAX_CHARS) + `\n…[truncated: ${json.length - TOOL_RESULT_MAX_CHARS} chars omitted]`,
    truncated: true,
  };
}

// Multi-turn tool-use loop:
//   - Seed messages with system prompt + user question.
//   - Ask the model. If it returns tool_calls, execute each, append a
//     `role: 'tool'` message per call, loop.
//   - If it returns a plain assistant message with no tool_calls, that's the
//     final answer.
//   - Cap iterations to prevent runaway loops; if we hit the cap, ask the
//     model for a forced summary using the evidence it has.
export async function investigate(
  question: string,
  opts: { maxIterations?: number } = {}
): Promise<InvestigationResult> {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set; cannot run an investigation.');
  }

  const client = new OpenAI({ apiKey: config.openai.apiKey });
  const maxIterations = opts.maxIterations ?? config.maxToolIterations;
  const transcript: TranscriptStep[] = [];

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: await buildSystemPrompt() },
    { role: 'user', content: question },
  ];

  let finishReason = 'stop';
  let finalAnswer = '';

  for (let i = 1; i <= maxIterations; i++) {
    const completion = await client.chat.completions.create({
      model: config.openai.model,
      messages,
      tools: toolSchemas,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const choice = completion.choices[0];
    if (!choice) {
      transcript.push({ iteration: i, type: 'error', content: 'no choices returned' });
      break;
    }
    finishReason = choice.finish_reason ?? 'stop';
    const message = choice.message;

    if (message.content) {
      transcript.push({ iteration: i, type: 'assistant_message', content: message.content });
    }

    const toolCalls = (message.tool_calls ?? []) as ChatCompletionMessageToolCall[];
    if (toolCalls.length === 0) {
      finalAnswer = message.content ?? '';
      transcript.push({ iteration: i, type: 'final_answer', content: finalAnswer });
      messages.push({ role: 'assistant', content: finalAnswer });
      break;
    }

    // Important: the assistant turn that announces tool_calls must be on the
    // message list before the corresponding `role: 'tool'` results, otherwise
    // OpenAI rejects the next request.
    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    });

    for (const tc of toolCalls) {
      const args = tc.function.arguments;
      transcript.push({
        iteration: i,
        type: 'tool_call',
        tool_name: tc.function.name,
        tool_arguments: safeParse(args),
      });
      const result = await runTool(tc.function.name, args);
      const { text, truncated } = truncateForLLM(result);
      transcript.push({
        iteration: i,
        type: 'tool_result',
        tool_name: tc.function.name,
        tool_result: result,
        truncated,
      });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
    }
  }

  if (!finalAnswer) {
    // Hit the iteration cap without a clean stop. Force one more turn that
    // disables tools so the model must produce a written summary from what
    // it has so far.
    transcript.push({
      iteration: maxIterations,
      type: 'error',
      content: `iteration cap (${maxIterations}) reached, forcing summary`,
    });
    const forced = await client.chat.completions.create({
      model: config.openai.model,
      messages: [
        ...messages,
        {
          role: 'user',
          content: 'You have hit the tool-call cap. Without calling any more tools, write the best insight you can from the evidence gathered so far. Be explicit about what you could not verify.',
        },
      ],
      temperature: 0.2,
    });
    finalAnswer = forced.choices[0]?.message?.content ?? '(no answer produced)';
    finishReason = 'iteration_cap';
    transcript.push({ iteration: maxIterations + 1, type: 'final_answer', content: finalAnswer });
  }

  return {
    answer: finalAnswer,
    iterations: transcript.filter((s) => s.type === 'tool_call').length,
    transcript,
    model: config.openai.model,
    finish_reason: finishReason,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
