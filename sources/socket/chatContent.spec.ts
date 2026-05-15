import { describe, it, expect } from 'vitest';
import {
    extractMessageSummary,
    extractPhaseSummary,
    extractLatestQAndA,
} from './chatContent';

describe('chatContent', () => {
    it('extracts assistant text from Codex response_item messages', () => {
        const content = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'output_text', text: 'Codex assistant reply' },
                ],
            },
        });

        expect(extractMessageSummary(content)).toEqual({
            type: 'assistant',
            text: 'Codex assistant reply',
            toolName: undefined,
            toolStatus: undefined,
            phase: undefined,
        });
    });

    it('extracts assistant text from Codex event_msg agent messages', () => {
        const content = JSON.stringify({
            type: 'event_msg',
            payload: {
                type: 'agent_message',
                message: 'Progress update from Codex',
                phase: 'commentary',
            },
        });

        expect(extractMessageSummary(content)).toEqual({
            type: 'assistant',
            text: 'Progress update from Codex',
            toolName: undefined,
            toolStatus: undefined,
            phase: 'commentary',
        });
    });

    it('extracts latest q and a from mixed legacy and Codex messages', () => {
        const messages = [
            JSON.stringify({ type: 'assistant', text: 'old assistant reply' }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'latest user prompt' }],
                },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'latest assistant reply' }],
                },
            }),
        ];

        expect(extractLatestQAndA(messages)).toEqual({
            userText: 'latest user prompt',
            assistantText: 'latest assistant reply',
        });
    });

    it('falls back to old phase summary fields for legacy phase payloads', () => {
        const content = JSON.stringify({
            type: 'phase',
            phase: 'waiting_approval',
            toolName: 'Bash',
            lastUserMessage: 'Need approval',
            lastAssistantSummary: 'Waiting...',
        });

        expect(extractPhaseSummary(content)).toEqual({
            phase: 'waiting_approval',
            toolName: 'Bash',
            lastUserMessage: 'Need approval',
            lastAssistantSummary: 'Waiting...',
        });
    });
});
