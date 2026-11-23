import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { ExtractionError, extractWithClaude } from '@/lib/claude';

// Long receipts / PDFs can take Claude a while; allow up to a minute on Vercel.
export const maxDuration = 60;

/** Files bigger than this are rejected before being sent to Claude. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;

const ReceiptSchema = z.object({
  vendor: z.string(),
  order_date: z.string(),
  grand_total: z.number(),
  spools: z.array(
    z.object({
      brand: z.string(),
      material: z.string(),
      color_name: z.string(),
      estimated_color_hex: z.string(),
      weight_grams: z.number(),
      quantity: z.number().int(),
      unit_landed_cost: z.number(),
    })
  ),
  parts: z.array(
    z.object({
      name: z.string(),
      category: z.enum(['nozzle', 'hotend', 'ptfe_tube', 'build_plate', 'ams_part', 'maintenance', 'other']),
      quantity: z.number().int(),
      unit_landed_cost: z.number(),
    })
  ),
});

const INSTRUCTIONS = `You are an expert 3D printing invoice parser. Extract every item from this receipt into two lists:
- 'spools': filament spools/refills.
- 'parts': EVERY other item on the receipt, one entry per product line — printer parts (nozzles, hotends, PTFE tubes, build plates, AMS parts), maintenance items (lubricant, cleaning, desiccant), and anything else (tools, magnets, glue, accessories, personal items). Use category 'other' for anything that isn't a printer part or maintenance item. Do NOT list tax, shipping, discounts or gift cards as items.
Proportionally distribute any tax, shipping, and discounts across ALL items (spools and parts) so 'unit_landed_cost' reflects the true out-of-pocket cost of ONE unit.
If a line item has quantity > 1, return the 'unit_landed_cost' for ONE unit and set 'quantity' accordingly.
For spools, estimate a 6-character hex code (e.g. #FFFFFF) for 'estimated_color_hex' based on the filament color name, and use 1000 for 'weight_grams' if the weight isn't shown.
'vendor' = the store name. 'order_date' = the order or invoice date as YYYY-MM-DD, or an empty string if not shown. 'grand_total' = the total charged, or 0 if not shown.
Either list may be empty.`;

export async function POST(request: Request) {
  try {
    const { fileBase64: inlineBase64, mimeType, rawText, storagePath } = await request.json();
    let fileBase64: string | undefined = inlineBase64;
    // Large files are uploaded to Supabase Storage by the browser first (Vercel caps request
    // bodies at 4.5 MB); fetch them from there.
    if (!fileBase64 && storagePath) {
      if (typeof storagePath !== 'string' || !/^uploads\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/.test(storagePath)) {
        return NextResponse.json({ error: 'Invalid upload path' }, { status: 400 });
      }
      const { data, error } = await supabase.storage.from('receipts').download(storagePath);
      if (error || !data) {
        return NextResponse.json(
          { error: `Could not read the uploaded receipt from storage: ${error?.message || 'not found'}` },
          { status: 502 }
        );
      }
      if (data.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: 'File is too large (max 15 MB)' }, { status: 413 });
      }
      fileBase64 = Buffer.from(await data.arrayBuffer()).toString('base64');
    }
    if (!fileBase64 && !rawText) {
      return NextResponse.json({ error: 'Provide a file or some text to parse' }, { status: 400 });
    }
    if (fileBase64 && fileBase64.length > (MAX_FILE_BYTES * 4) / 3) {
      return NextResponse.json({ error: 'File is too large (max 15 MB)' }, { status: 413 });
    }

    const data = await extractWithClaude({
      schema: ReceiptSchema,
      fileBase64,
      mimeType,
      extraText: rawText ? `Order text:\n${rawText}` : undefined,
      instructions: INSTRUCTIONS,
    });
    return NextResponse.json(data);
  } catch (err: any) {
    const status = err instanceof ExtractionError ? err.status : 500;
    return NextResponse.json({ error: err?.message || 'Failed to parse receipt' }, { status });
  }
}
