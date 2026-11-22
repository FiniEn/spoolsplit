import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

export async function POST(request: Request) {
  try {
    const { fileBase64, mimeType, rawText, activeSpools } = await request.json();
    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: 'GEMINI_API_KEY is not configured on the server' }, { status: 500 });
    }
    if (!fileBase64 && !rawText) {
      return NextResponse.json({ error: 'Provide a file or some text to parse' }, { status: 400 });
    }
    // ~10 MB of base64 is plenty for a screenshot or receipt PDF
    if (fileBase64 && fileBase64.length > 14_000_000) {
      return NextResponse.json({ error: 'File is too large (max ~10 MB)' }, { status: 413 });
    }
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const spoolContext = JSON.stringify(
      (activeSpools || []).map((s: any) => ({
        id: s.id,
        brand: s.brand,
        material: s.material,
        color_name: s.color_name,
        color_hex: s.color_hex,
      }))
    );

    const parts: any[] = [
      {
        text: `Extract the details of ONE 3D print job from this Bambu Handy screenshot, Bambu Studio slice preview, or MakerWorld page text/URL.

        'title' = the name of the printed MODEL:
        - Bambu Handy: the large model/project name on the printing or print-history screen.
        - Bambu Studio: the project / plate name shown in the title bar or slice preview.
        - MakerWorld: the model's title on the page.
        Clean it up: remove file extensions (.3mf, .gcode, .gcode.3mf, .stl), "Plate 1"/"plate_1" suffixes and underscores, and never use the printer's name (e.g. "X1C", "P1S", "A1 mini") as the title. If no name is visible at all, return an empty string.

        'duration_minutes' = total print time in whole minutes (convert e.g. "2h 35m" to 155, "1d 3h" to 1620). Prefer the total/estimated time over the remaining time. If no time is visible, return 0.

        'filament_usages' = grams used per filament slot/color.
        Here is our current active spool inventory: ${spoolContext}.
        For each filament used in the print, set 'matched_spool_id' to the UUID of the best matching spool from our inventory (matching by color & material).`,
      },
    ];

    if (fileBase64 && mimeType) {
      parts.push({
        inlineData: {
          data: fileBase64,
          mimeType,
        },
      });
    }
    if (rawText) {
      parts.push({ text: `Model/Page Info:\n${rawText}` });
    }

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            duration_minutes: { type: Type.INTEGER },
            filament_usages: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  detected_material: { type: Type.STRING },
                  detected_color_name: { type: Type.STRING },
                  grams_used: { type: Type.NUMBER },
                  matched_spool_id: { type: Type.STRING },
                },
                required: ['detected_material', 'detected_color_name', 'grams_used'],
              },
            },
          },
          required: ['title', 'duration_minutes', 'filament_usages'],
        },
      },
    });

    const data = JSON.parse(response.text || '{}');
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      { error: readableError(err) || 'Failed to parse print info' },
      { status: 500 }
    );
  }
}

/** Gemini errors arrive as a JSON string; pull out the human-readable message. */
function readableError(err: any): string {
  const raw = String(err?.message || '');
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message || parsed?.message;
    if (msg) return `Gemini: ${msg}`;
  } catch {
    // not JSON
  }
  return raw;
}
