import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

/** Server-only helper: one Claude call that returns JSON matching a Zod schema. */

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export class ExtractionError extends Error {
  constructor(
    message: string,
    public status = 500
  ) {
    super(message);
  }
}

/** Builds the content block for an uploaded image or PDF (base64, no data: prefix). */
function fileBlock(fileBase64: string, mimeType: string): Anthropic.Beta.BetaContentBlockParam {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } };
  }
  if ((IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType as ImageType, data: fileBase64 } };
  }
  throw new ExtractionError(
    `Claude can read JPEG, PNG, GIF, WebP or PDF files, not "${mimeType || 'unknown'}". Take a screenshot of it instead.`,
    415
  );
}

export async function extractWithClaude<Schema extends z.ZodType>(opts: {
  instructions: string;
  schema: Schema;
  fileBase64?: string;
  mimeType?: string;
  extraText?: string;
}): Promise<z.infer<Schema>> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ExtractionError('ANTHROPIC_API_KEY is not configured on the server', 500);
  }
  const client = new Anthropic();

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (opts.fileBase64) content.push(fileBlock(opts.fileBase64, opts.mimeType || ''));
  if (opts.extraText) content.push({ type: 'text', text: opts.extraText });
  content.push({ type: 'text', text: opts.instructions });

  try {
    const response = await client.beta.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      // If a safety classifier declines, the API retries on a suitable fallback model in the same call
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(opts.schema) },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') {
      throw new ExtractionError('Claude declined to read this file. Try a different screenshot or type it in.', 422);
    }
    if (response.stop_reason === 'max_tokens' || response.parsed_output == null) {
      throw new ExtractionError('Claude could not finish reading this file. Try a smaller or clearer image.', 502);
    }
    return response.parsed_output;
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    if (err instanceof Anthropic.AuthenticationError) {
      throw new ExtractionError('Claude: the ANTHROPIC_API_KEY is not valid.', 500);
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      throw new ExtractionError(`Claude: this API key can't use ${CLAUDE_MODEL}.`, 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new ExtractionError('Claude is busy or the usage limit was reached. Try again in a minute.', 429);
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new ExtractionError(`Claude: ${err.message}`, 400);
    }
    if (err instanceof Anthropic.APIError) {
      throw new ExtractionError(`Claude error ${err.status ?? ''}: ${err.message}`, 502);
    }
    throw err;
  }
}
