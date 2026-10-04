/**
 * Supervised records for a Nova fine-tune.
 *
 * Each user turn is the decide packet Dot Race already posts to Laya
 * (`state` + `questions.move`, instructions included). The assistant turn is
 * the choice id of the asphalt step tagged `best`, or `back` when the car is
 * off the track. Inference sends this same packet.
 */
import { LAYA_DECIDE_MODEL, LAYA_MOVE_INSTRUCTIONS, layaDecideBody, type LayaScene } from './laya-scene';

/** Output contract only. The racing prompt is the Laya packet in the user turn. */
export const BEDROCK_LAYA_SYSTEM = 'Reply with only the choice id from questions.move.';

/**
 * Nova rejects a training row whose prompt contains these tokens.
 * https://docs.aws.amazon.com/nova/latest/userguide/fine-tune-prepare-data-understanding.html
 */
const NOVA_RESERVED = ['User:', 'Bot:', 'Assistant:', 'System:', '[EOS]'] as const;

export function layaPromptText(scene: LayaScene): string {
  const body = layaDecideBody(scene, LAYA_DECIDE_MODEL);
  return JSON.stringify({
    state: body.state,
    questions: body.questions,
  });
}

/** Label the fine-tune should emit for this scene. Null when neither tag exists. */
export function supervisedChoice(scene: LayaScene): string | null {
  const best = scene.options.find((option) => !option.illegal && option.detail.startsWith('best '));
  if (best) return best.label;
  const back = scene.options.find((option) => !option.illegal && option.detail.startsWith('back '));
  if (back) return back.label;
  return null;
}

export interface BedrockConversationRecord {
  schemaVersion: 'bedrock-conversation-2024';
  system: [{ text: string }];
  messages: [
    { role: 'user'; content: [{ text: string }] },
    { role: 'assistant'; content: [{ text: string }] },
  ];
}

export function bedrockConversationRecord(
  scene: LayaScene,
  choice: string
): BedrockConversationRecord | null {
  const text = layaPromptText(scene);
  const banned = NOVA_RESERVED.find((token) => text.includes(token) || BEDROCK_LAYA_SYSTEM.includes(token));
  if (banned) return null;
  if (!text.includes(LAYA_MOVE_INSTRUCTIONS)) return null;
  return {
    schemaVersion: 'bedrock-conversation-2024',
    system: [{ text: BEDROCK_LAYA_SYSTEM }],
    messages: [
      { role: 'user', content: [{ text }] },
      { role: 'assistant', content: [{ text: choice }] },
    ],
  };
}
