import cache from './cache';
import { Context } from './interfaces';
import { ISupportee } from './db';
import * as db from './db';
import * as llm from './addons/llm';
import * as triage from './triage';
import { sendMessage } from './middleware';
import * as log from './logger';

/**
 * Generate staff-only AI suggestions for one user message.
 * This function never sends anything to the user and never mutates ticket
 * lifecycle, owner, queue, category or priority.
 */
export async function createAIDraft(ticket: ISupportee, ctx: Context): Promise<void> {
  const { config } = cache;
  if (!config.use_llm && !config.auto_triage) return;

  let replyDraft: string | null = null;
  let triageDraft: triage.TriageResult | null = null;

  try {
    if (config.auto_triage) {
      // No ticketId is passed: analyzeMessage must not persist the suggestion.
      triageDraft = await triage.analyzeMessage(ctx.message.text);
    }
    if (config.use_llm) {
      replyDraft = await llm.getResponseFromLLM(ctx);
    }
  } catch (error) {
    log.error(`AI draft generation failed for #T${ticket.ticketId}`, error);
    return;
  }

  if (!replyDraft && !triageDraft) return;

  const parts: string[] = [
    `🤖 AI DRAFT #T${ticket.ticketId.toString().padStart(6, '0')} — review before sending`,
  ];

  if (triageDraft) {
    parts.push([
      'Triage suggestion:',
      `priority: ${triageDraft.priority}`,
      `category: ${triageDraft.category || '-'}`,
      `summary: ${triageDraft.summary || '-'}`,
      `sentiment: ${triageDraft.sentimentScore}/5`,
    ].join('\n'));
  }

  if (replyDraft) {
    parts.push(`Reply draft:\n${replyDraft}`);
    await db.addTicketMessage(ticket.ticketId, 'ai', 'draft', replyDraft);
  }

  // Plain text on purpose: model output must not inject Telegram markup.
  await sendMessage(
    config.staffchat_id,
    config.staffchat_type,
    parts.join('\n\n'),
    {},
  );

  await db.recordAnalyticsEvent('ai.draft_created', ticket.ticketId, null, {
    reply: Boolean(replyDraft),
    triage: Boolean(triageDraft),
  });
}
