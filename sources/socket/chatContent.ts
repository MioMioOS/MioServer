export interface MessageSummary {
    type: string;
    text: string;
    toolName?: string;
    toolStatus?: string;
    phase?: string;
}

export interface PhaseSummary {
    phase: string;
    toolName?: string;
    lastUserMessage?: string;
    lastAssistantSummary?: string;
}

export function extractMessageSummary(content: string): MessageSummary {
    let parsed: any;
    try {
        parsed = JSON.parse(content);
    } catch {
        return { type: 'user', text: content };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { type: 'unknown', text: '' };
    }

    const type = asString(parsed.type);
    switch (type) {
        case 'user':
        case 'assistant':
        case 'thinking':
        case 'tool':
        case 'interrupted':
        case 'terminal_output':
        case 'phase':
        case 'heartbeat':
        case 'key':
            return {
                type,
                text: asString(parsed.text) ?? '',
                toolName: asString(parsed.toolName),
                toolStatus: asString(parsed.toolStatus),
                phase: asString(parsed.phase),
            };
        case 'response_item':
            return extractFromResponseItem(parsed.payload);
        case 'event_msg':
            return extractFromEventMsg(parsed.payload);
        default:
            return {
                type: type ?? 'unknown',
                text: asString(parsed.text) ?? '',
                toolName: asString(parsed.toolName),
                toolStatus: asString(parsed.toolStatus),
                phase: asString(parsed.phase),
            };
    }
}

export function extractLatestQAndA(messages: string[]): { userText: string; assistantText: string } {
    let userText = '';
    let assistantText = '';

    for (const content of [...messages].reverse()) {
        if (userText && assistantText) break;
        const summary = extractMessageSummary(content);
        if (summary.type === 'user' && summary.text && !userText) {
            userText = summary.text;
        } else if (summary.type === 'assistant' && summary.text && !assistantText) {
            assistantText = summary.text;
        }
    }

    return { userText, assistantText };
}

export function extractPhaseSummary(content: string): PhaseSummary | null {
    try {
        const parsed = JSON.parse(content);
        if (!parsed || parsed.type !== 'phase') return null;

        return {
            phase: asString(parsed.phase) ?? 'idle',
            toolName: asString(parsed.toolName),
            lastUserMessage: asString(parsed.lastUserMessage),
            lastAssistantSummary: asString(parsed.lastAssistantSummary),
        };
    } catch {
        return null;
    }
}

function extractFromResponseItem(payload: any): MessageSummary {
    const payloadType = asString(payload?.type);
    switch (payloadType) {
        case 'message': {
            const role = asString(payload?.role) === 'user' ? 'user' : 'assistant';
            return {
                type: role,
                text: extractContentText(payload?.content, role),
                phase: asString(payload?.phase),
            };
        }
        case 'custom_tool_call':
        case 'function_call':
            return {
                type: 'tool',
                text: stringifyValue(payload?.input) ?? '',
                toolName: asString(payload?.name),
                toolStatus: asString(payload?.status),
            };
        case 'custom_tool_call_output':
        case 'function_call_output':
            return {
                type: 'terminal_output',
                text: asString(payload?.output) ?? '',
                toolStatus: asString(payload?.status),
            };
        case 'reasoning':
            return {
                type: 'thinking',
                text: asString(payload?.text) ?? stringifyValue(payload?.summary) ?? '',
            };
        default:
            return {
                type: payloadType ?? 'unknown',
                text: asString(payload?.text) ?? asString(payload?.output) ?? '',
                toolName: asString(payload?.name),
                toolStatus: asString(payload?.status),
                phase: asString(payload?.phase),
            };
    }
}

function extractFromEventMsg(payload: any): MessageSummary {
    const payloadType = asString(payload?.type);
    switch (payloadType) {
        case 'user_message':
            return { type: 'user', text: asString(payload?.message) ?? '', phase: asString(payload?.phase) };
        case 'agent_message':
            return { type: 'assistant', text: asString(payload?.message) ?? '', phase: asString(payload?.phase) };
        case 'exec_command_begin':
            return {
                type: 'tool',
                text: joinCommand(payload?.command) ?? '',
                toolName: 'exec_command',
                toolStatus: 'running',
            };
        case 'exec_command_end':
            return {
                type: 'terminal_output',
                text: firstNonEmpty(
                    asString(payload?.aggregated_output),
                    asString(payload?.stdout),
                    asString(payload?.stderr)
                ) ?? '',
                toolName: 'exec_command',
                toolStatus: asString(payload?.status),
            };
        case 'turn_aborted':
            return { type: 'interrupted', text: asString(payload?.reason) ?? '' };
        case 'token_count':
            return { type: 'heartbeat', text: '' };
        default:
            return {
                type: 'assistant',
                text: asString(payload?.message) ?? asString(payload?.output) ?? '',
                phase: asString(payload?.phase),
            };
    }
}

function extractContentText(content: unknown, role: 'user' | 'assistant'): string {
    if (!Array.isArray(content)) return '';
    const preferredTypes = role === 'user'
        ? new Set(['input_text', 'text'])
        : new Set(['output_text', 'text']);

    const preferred = content
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const type = asString((item as any).type);
            const text = asString((item as any).text);
            if (!type || !text || !preferredTypes.has(type)) return null;
            return text.trim();
        })
        .filter((value): value is string => Boolean(value));

    if (preferred.length > 0) {
        return preferred.join('\n');
    }

    return content
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const text = asString((item as any).text);
            return text?.trim() || null;
        })
        .filter((value): value is string => Boolean(value))
        .join('\n');
}

function joinCommand(command: unknown): string | undefined {
    if (Array.isArray(command)) {
        const parts = command.filter((part): part is string => typeof part === 'string');
        return parts.length > 0 ? parts.join(' ') : undefined;
    }
    return asString(command);
}

function stringifyValue(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return undefined;
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
    return values.find((value) => value && value.length > 0);
}
