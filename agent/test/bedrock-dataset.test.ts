import { getTrackById } from '../../shared/tracks';
import { createInitialState, createLobbyPlayer } from '../../shared/ws-types';
import {
  BEDROCK_LAYA_SYSTEM,
  bedrockConversationRecord,
  layaPromptText,
  supervisedChoice,
} from '../src/bedrock-dataset';
import { collectFinetuneRecords } from '../src/bedrock-samples';
import { LAYA_MOVE_INSTRUCTIONS, buildLayaScene } from '../src/laya-scene';

describe('bedrock fine-tune records', () => {
  it('uses the Laya decide packet and the best choice id', () => {
    const track = getTrackById('monza')!;
    const me = createLobbyPlayer('tune', 'Tune', false, 1, '#3B82F6');
    me.position = { x: 140, y: 118 };
    me.velocity = { x: -2, y: 0 };
    const state = createInitialState([me], 'tune');
    state.phase = 'GAME_ROUND';
    state.trackId = track.id;
    state.round = 1;
    const scene = buildLayaScene(me, state, track);
    const choice = supervisedChoice(scene);
    expect(choice).toMatch(/^d(m1|0|p1)_(m1|0|p1)$/);
    const record = bedrockConversationRecord(scene, choice!);
    expect(record).not.toBeNull();
    expect(record!.schemaVersion).toBe('bedrock-conversation-2024');
    expect(record!.system[0].text).toBe(BEDROCK_LAYA_SYSTEM);
    expect(record!.messages[0].content[0].text).toBe(layaPromptText(scene));
    expect(record!.messages[0].content[0].text).toContain(LAYA_MOVE_INSTRUCTIONS);
    expect(record!.messages[1].content[0].text).toBe(choice);
  });

  it('samples every circuit without Nova reserved tokens', () => {
    const records = collectFinetuneRecords();
    expect(records.length).toBeGreaterThanOrEqual(200);
    expect(records.length).toBeLessThanOrEqual(20_000);
    const tracks = new Set<string>();
    for (const record of records) {
      const text = record.messages[0].content[0].text;
      expect(text).toContain(LAYA_MOVE_INSTRUCTIONS);
      expect(text).not.toMatch(/User:|Bot:|Assistant:|System:|\[EOS\]/);
      expect(record.messages[1].content[0].text).toMatch(/^d(m1|0|p1)_(m1|0|p1)$/);
      const state = JSON.parse(text) as { state?: { kind?: string } };
      expect(state.state?.kind).toBe('vector race');
      tracks.add(text);
    }
    expect(tracks.size).toBe(records.length);
  });
});
