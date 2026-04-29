import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY is not set. Add it to agent/.env');
}

const client = new Anthropic({ apiKey });

async function main() {
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    // @ts-expect-error — SDK 0.40.0 types lack 'adaptive'; supported by API. Remove after SDK upgrade.
    thinking: { type: 'adaptive' },
    system:
      'You are an assistant that classifies Microsoft Teams chat messages into one of: NEW_TASK, UPDATE_TASK, ISSUE, QUERY, REPORT, SCHEDULE. Respond with only the label.',
    messages: [
      {
        role: 'user',
        content:
          'AAA: 로봇 목록을 출력하는 기능 만들어야 하는데 BBB씨가 맡아주세요. 30일까지.',
      },
    ],
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      console.log(block.text);
    }
  }

  console.log(
    `\n[usage] input=${response.usage.input_tokens} output=${response.usage.output_tokens} stop=${response.stop_reason}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
