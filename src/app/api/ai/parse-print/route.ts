import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ExtractionError, extractWithClaude } from '@/lib/claude';

// Claude may take a while on a detailed screenshot; allow up to a minute on Vercel.
export const maxDuration = 60;

const PrintSchema = z.object({
  title: z.string(),
  duration_minutes: z.number().int(),
  filament_usages: z.array(
    z.object({
      detected_material: z.string(),
      detected_color_name: z.string(),
      grams_used: z.number(),
      matched_spool_id: z.string(),
    })
  ),
});

export async function POST(request: Request) {
  try {
    const { fileBase64, mimeType, rawText, activeSpools } = await request.json();
    if (!fileBase64 && !rawText) {
      return NextResponse.json({ error: 'Provide a file or some text to parse' }, { status: 400 });
    }

    const spoolContext = JSON.stringify(
      (activeSpools || []).map((s: any) => ({
        id: s.id,
        brand: s.brand,
        material: s.material,
        color_name: s.color_name,
        color_hex: s.color_hex,
      }))
    );

    const data = await extractWithClaude({
      schema: PrintSchema,
      fileBase64,
      mimeType,
      extraText: rawText ? `Model/page info:\n${rawText}` : undefined,
      instructions: `Extract the details of ONE 3D print job from this Bambu Handy screenshot, Bambu Studio slice preview, or MakerWorld page text/URL.

'title' = the name of the printed MODEL:
- Bambu Handy: the large model/project name on the printing or print-history screen.
- Bambu Studio: the project / plate name shown in the title bar or slice preview.
- MakerWorld: the model's title on the page.
Clean it up: remove file extensions (.3mf, .gcode, .gcode.3mf, .stl), "Plate 1"/"plate_1" suffixes and underscores, and never use the printer's name (e.g. "X1C", "P1S", "A1 mini") as the title. If no name is visible at all, return an empty string.

'duration_minutes' = total print time in whole minutes (convert e.g. "2h 35m" to 155, "1d 3h" to 1620). Prefer the total/estimated time over the remaining time. If no time is visible, return 0.

'filament_usages' = grams used per filament slot/color.
Our current active spool inventory (JSON): ${spoolContext}
For each filament used in the print, set 'matched_spool_id' to the id of the best matching spool from the inventory (by color and material), or an empty string if none fits.`,
    });
    return NextResponse.json(data);
  } catch (err: any) {
    const status = err instanceof ExtractionError ? err.status : 500;
    return NextResponse.json({ error: err?.message || 'Failed to parse print info' }, { status });
  }
}
