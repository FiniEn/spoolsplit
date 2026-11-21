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
        text: `Extract the 3D print job details (model title, total duration in minutes, and filament grams used per slot/color) from this Bambu Handy screenshot, Bambu Studio slice preview, or MakerWorld page text/URL.
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
      model: 'gemini-2.5-flash',
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
          required: ['title', 'filament_usages'],
        },
      },
    });

    const data = JSON.parse(response.text || '{}');
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to parse print info' },
      { status: 500 }
    );
  }
}
