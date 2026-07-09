import Anthropic from '@anthropic-ai/sdk';
import { CATEGORY_NAMES } from '../schemas/budget';
import type { LlmClassifier } from './categorizer';

/**
 * Production LlmClassifier backed by the Anthropic API. The API key comes
 * from ANTHROPIC_API_KEY in the server's environment only - never the repo.
 *
 * The prompt constrains the answer space hard (respond with ONLY a number),
 * but the categorizer service still validates the result - prompts are
 * instructions, not guarantees.
 */

const CATEGORY_LIST = Object.entries(CATEGORY_NAMES)
  .map(([id, name]) => `${id}. ${name}`)
  .join('\n');

const SYSTEM_PROMPT = `You classify merchant strings from card transactions into exactly one category.

Categories:
${CATEGORY_LIST}

Rules:
- Respond with ONLY the category number (1-10). No words, no punctuation.
- Merchant strings are noisy bank-feed text (store numbers, city names, abbreviations).
- If genuinely ambiguous, answer 10 (Other).`;

export function anthropicClassifier(model = 'claude-opus-4-8'): LlmClassifier {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  return async (merchantRaw: string) => {
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: merchantRaw }],
    });
    const text = response.content.find((block) => block.type === 'text')?.text ?? '';
    // parseInt tolerates stray whitespace; anything non-numeric becomes NaN,
    // which the categorizer's validation rejects into the fallback path.
    return Number.parseInt(text.trim(), 10);
  };
}
