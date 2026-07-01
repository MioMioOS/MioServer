/**
 * messageClassifier — Slock-style server-side message → task classifier.
 *
 * Purpose: when a user/agent posts a message, ask Doubao whether it should be
 * auto-promoted to a task. Returns { is_task, assignee_handle, task_title }.
 * If the classifier cannot decide (missing key, network failure, parse error,
 * shape mismatch, self-loop), the contract is to return is_task=false so the
 * existing message flow proceeds unchanged.
 *
 * SECURITY:
 *   - Uses `config.doubaoApiKey` (low-privilege Ark explanation-tier key) — the
 *     same key already wired into doubaoProvider.ts. NEVER logged.
 *   - `temperature: 0`, `max_tokens: 100`, 6s timeout — bounded cost.
 *   - Strict JSON response_format. ANY shape problem → fallback (is_task=false).
 *   - Self-loop guard: assignee_handle === senderHandle → force is_task=false.
 *
 * This module does NOT call any other classifier infra; it talks to
 * /chat/completions directly (per spec "DO NOT route through doubaoProvider").
 */

import { config } from '@/config';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ClassifyMessageArgs {
  content: string;
  channelName: string;
  channelMembers: Array<{ handle: string; role: string; kind: 'user' | 'agent' }>;
  recentMessages: Array<{ sender_handle: string; preview: string }>; // last 5
  senderHandle: string;
  // Fix 5 (handoff-task policy): set true ONLY when the caller has already
  // confirmed this message is an explicit cross-agent @-mention (delegation)
  // that was deliberately kept on the main channel instead of auto-routed.
  // When true AND the deterministic heuristic gate passes, an LLM verdict of
  // is_task=false is overridden to is_task=true so the delegated work reliably
  // becomes a task instead of evaporating. The heuristic gate is NEVER
  // bypassed, so greetings ("@UI hi") still cannot become tasks. The self-loop
  // guard is also still enforced after the override.
  forceTaskOnHandoff?: boolean;
}

export interface ClassifyMessageResult {
  is_task: boolean;
  assignee_handle: string | null;
  task_title: string | null;
}

const FALLBACK: ClassifyMessageResult = {
  is_task: false,
  assignee_handle: null,
  task_title: null,
};

// Classifier endpoint id. seed-2-0-mini-260215 is the smallest 260215-family
// Doubao that still supports `response_format: json_object` AND `thinking:
// disabled` — ~1.0–1.5s p50 vs ~2–3s on -pro on the curl benchmark, with
// identical accuracy on the design-task test set. Flash/lite-1.6 tier would
// be faster (~300–500ms) but the prod Ark account doesn't have them activated.
const CLASSIFIER_MODEL = 'doubao-seed-2-0-mini-260215';
const CLASSIFIER_TIMEOUT_MS = 6000;
const CLASSIFIER_MAX_TOKENS = 100;

// ── Prompt composition ───────────────────────────────────────────────────────

// Terse rules. JSON shape spelled in the system prompt (no separate wrapper
// instructions in the user message) — Doubao with response_format=json_object
// doesn't need redundant scaffolding.
const SYSTEM_PROMPT =
  '分类 Slack 消息是否为 task。返回 JSON：' +
  '{"is_task":bool,"assignee_handle":"@xxx"|null,"task_title":"<60字"|null}。' +
  '只有「要求产出/实现/制作/修复一个具体交付物」的单次请求→true（assignee 是被 @ 的成员 handle）；' +
  '状态汇报/确认/闲聊/反馈→false。' +
  '提问/询问信息/请人答复（如「现在几点」「频道里有几个人」「你觉得呢」「进度如何」）→false——' +
  '这类是要在频道里直接口头回答的问题，不是需要建 task 的交付工作。' +
  ' CRITICAL: task_title 必须只从 new_message 文本本身提炼，' +
  '绝对不能从 recent 历史里抽内容来填 title。' +
  'recent 只用来辅助判断 new_message 是不是「收到」「好的」这类回应（→false），' +
  '不是 task 内容的来源。' +
  'new_message 自身没有清晰可执行内容时（如「hi」「你好」「在吗」「ok」「👍」），' +
  'is_task 必须为 false，title 必须为 null。';

const RECENT_MESSAGES_LIMIT = 3;
const RECENT_PREVIEW_CHARS = 60;

function buildUserMessage(args: ClassifyMessageArgs): string {
  // Compact one-liners per member to minimize tokens. The new message is
  // emitted as a final JSON-escaped string (still framed as DATA so a hostile
  // body cannot reinterpret as instructions).
  const lines: string[] = [];
  lines.push(`channel: ${args.channelName}`);
  lines.push(`sender: ${args.senderHandle}`);
  lines.push('members:');
  for (const m of args.channelMembers) {
    lines.push(`  ${m.handle} (${m.role})`);
  }
  if (args.recentMessages.length > 0) {
    lines.push('recent:');
    for (const r of args.recentMessages.slice(-RECENT_MESSAGES_LIMIT)) {
      const preview = r.preview.slice(0, RECENT_PREVIEW_CHARS);
      lines.push(`  ${r.sender_handle}: ${preview}`);
    }
  }
  // Encode the new message as a JSON string so embedded quotes/newlines can't
  // break the framing.
  lines.push(`new_message: ${JSON.stringify(args.content)}`);
  return lines.join('\n');
}

// ── Main API ─────────────────────────────────────────────────────────────────

// Heuristic gate: messages that cannot reasonably be tasks should never reach
// the LLM. Cheap + deterministic + prevents the small-model context-contamination
// hallucination we saw with "hi" → "design a logo". Industry pattern.
const GREETING_WHITELIST = new Set([
  'hi', 'hello', 'hey', 'yo', '你好', '在吗', '哈喽', '哈罗',
  'ok', 'okay', '好', '好的', '好滴', '收到', '了解', '明白', 'got it', 'gotcha',
  '嗯', '嗯嗯', '哦', '哦哦', '哈哈', '嘿', '哇', '666', 'cool', 'nice',
  '👍', '👌', '🙏', '❤️', '✅', '🎉',
  'thanks', 'thank you', '谢谢', '感谢', '辛苦了', '多谢',
]);

function passesHeuristicGate(content: string): boolean {
  const trimmed = content.trim();
  // Empty / too short → never a task.
  if (trimmed.length < 5) return false;
  // No @-mention → never a task (Slock-style: tasks require an assignee).
  if (!/@\S/.test(trimmed)) return false;
  // Strip @-mentions and check what's left.
  const rest = trimmed.replace(/@\S+/g, '').trim().toLowerCase();
  // If after removing @-mentions the body is empty or a pure greeting → not a task.
  if (rest.length === 0) return false;
  if (GREETING_WHITELIST.has(rest)) return false;
  // Pure emoji / pure punctuation → not a task.
  if (!/[\p{L}\p{N}]/u.test(rest)) return false;
  return true;
}

export async function classifyMessageForTask(
  args: ClassifyMessageArgs,
): Promise<ClassifyMessageResult> {
  console.info(
    `[messageClassifier] fire channel=${args.channelName} sender=${args.senderHandle} content_len=${args.content.length} members=${args.channelMembers.length} recent=${args.recentMessages.length}`,
  );
  // Heuristic pre-filter: reject obvious non-tasks BEFORE spending an LLM call.
  if (!passesHeuristicGate(args.content)) {
    console.info(
      `[messageClassifier] heuristic-gate skip is_task=false (no LLM call)`,
    );
    return FALLBACK;
  }

  // No key → classifier disabled. Log once-per-call info (no secrets).
  if (!config.doubaoApiKey) {
    console.info('[messageClassifier] classifier disabled, no DOUBAO_API_KEY');
    return FALLBACK;
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const res = await fetch(`${config.doubaoBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // SECURITY: key used ONLY here. Never log this header.
        authorization: `Bearer ${config.doubaoApiKey}`,
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        temperature: 0,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(args) },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(
        `[messageClassifier] non-2xx status=${res.status} duration_ms=${Date.now() - started}`,
      );
      return FALLBACK;
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    if (json.usage) {
      console.info(
        `[messageClassifier] tokens prompt=${json.usage.prompt_tokens ?? '?'} completion=${json.usage.completion_tokens ?? '?'} total=${json.usage.total_tokens ?? '?'} model=${CLASSIFIER_MODEL} duration_ms=${Date.now() - started}`,
      );
    }
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      console.warn(
        `[messageClassifier] empty content duration_ms=${Date.now() - started}`,
      );
      return FALLBACK;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(
        `[messageClassifier] parse error duration_ms=${Date.now() - started}`,
      );
      return FALLBACK;
    }

    const result = validateShape(parsed);
    if (!result) {
      console.warn(
        `[messageClassifier] shape mismatch duration_ms=${Date.now() - started}`,
      );
      return FALLBACK;
    }

    // Fix 5 override: explicit cross-agent handoff that the LLM declined.
    // The heuristic gate (above) already guaranteed a real @-mention plus a
    // non-greeting, non-trivial body, so this is conservative: we only rescue
    // messages that ALREADY look like tasks structurally but that the
    // probabilistic LLM gate happened to score as is_task=false. We do NOT
    // touch greetings (they never reach here) and the self-loop guard below
    // still applies.
    if (args.forceTaskOnHandoff && !result.is_task) {
      const assignee = result.assignee_handle ?? firstMentionHandle(args.content);
      const title = result.task_title ?? deriveTaskTitle(args.content);
      if (assignee && title) {
        console.info(
          `[messageClassifier] handoff-force override is_task=false→true assignee=${assignee}`,
        );
        result.is_task = true;
        result.assignee_handle = assignee;
        result.task_title = title;
      } else {
        console.info(
          `[messageClassifier] handoff-force skipped (no assignee/title) assignee=${assignee ?? 'null'} title=${title ? 'present' : 'null'}`,
        );
      }
    }

    // Self-loop guard: never let the sender create a task assigned to themselves.
    // Sender and assignee handles can differ in casing and leading-'@' form
    // (Doubao normalizes inconsistently; resolveSenderHandle always prefixes
    // '@'), so compare on a normalized key: trim → enforce a single leading
    // '@' → lowercase. Without this, "@Tester" (assignee) vs "@tester"
    // (sender) slipped past the guard and created a self-assigned task.
    let finalResult = result;
    if (finalResult.is_task && finalResult.assignee_handle !== null) {
      const normalizeHandle = (h: string): string => {
        const t = h.trim().toLowerCase();
        return t.startsWith('@') ? t : '@' + t;
      };
      if (normalizeHandle(finalResult.assignee_handle) === normalizeHandle(args.senderHandle)) {
        finalResult = { is_task: false, assignee_handle: null, task_title: null };
      }
    }

    console.info(
      `[messageClassifier] result is_task=${finalResult.is_task} ` +
        `assignee=${finalResult.assignee_handle ?? 'null'} ` +
        `task_title=${finalResult.task_title ? JSON.stringify(finalResult.task_title) : 'null'} ` +
        `duration_ms=${Date.now() - started}`,
    );
    return finalResult;
  } catch (err) {
    // Aborted (timeout) or network error.
    const errName = err instanceof Error ? err.name : 'unknown';
    console.warn(
      `[messageClassifier] error name=${errName} duration_ms=${Date.now() - started}`,
    );
    return FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the first @-mention handle from raw content (Unicode-safe; matches
 * CJK names). Returns "@<name>" or null. Used only by the handoff-force path
 * when the LLM declined to emit an assignee.
 */
function firstMentionHandle(content: string): string | null {
  const m = content.match(/@[\p{L}\p{N}_]+/u);
  return m ? m[0] : null;
}

/**
 * Derive a task title from raw content when the LLM declined to emit one
 * (handoff-force path only). Trims to the classifier's 200-char downstream
 * cap. Conservative: just the verbatim message text, not an LLM rephrase.
 */
function deriveTaskTitle(content: string): string | null {
  const t = content.trim();
  if (t.length === 0) return null;
  return t.slice(0, 200);
}

function validateShape(value: unknown): ClassifyMessageResult | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  if (typeof obj.is_task !== 'boolean') return null;

  const assignee = obj.assignee_handle;
  if (assignee !== null && typeof assignee !== 'string') return null;

  const title = obj.task_title;
  if (title !== null && typeof title !== 'string') return null;

  // Soft normalize empty strings to null.
  const assigneeFinal = typeof assignee === 'string' && assignee.length > 0 ? assignee : null;
  const titleFinal = typeof title === 'string' && title.length > 0 ? title.slice(0, 200) : null;

  return {
    is_task: obj.is_task,
    assignee_handle: assigneeFinal,
    task_title: titleFinal,
  };
}
