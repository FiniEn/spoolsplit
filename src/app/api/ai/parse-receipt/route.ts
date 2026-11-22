import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

export async function POST(request: Request) {
  try {
    const { fileBase64, mimeType, rawText } = await request.json();
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

    const parts: any[] = [
      {
        text: `You are an expert 3D printing invoice parser. Extract every item from this receipt into two lists:
        - 'spools': filament spools/refills.
        - 'parts': EVERY other item on the receipt, one entry per product line — printer parts (nozzles, hotends, PTFE tubes, build plates, AMS parts), maintenance items (lubricant, cleaning, desiccant), and anything else (tools, magnets, glue, accessories, personal items). Use category 'other' for anything that isn't a printer part or maintenance item. Do NOT list tax, shipping, discounts or gift cards as items.
        Proportionally distribute any tax, shipping, and discounts across ALL items (spools and parts) so 'unit_landed_cost' reflects the true out-of-pocket cost of ONE unit.
        If a line item has quantity > 1, return the 'unit_landed_cost' for ONE unit and set 'quantity' accordingly.
        For spools, estimate a 6-character hex code (e.g. #FFFFFF) for 'estimated_color_hex' based on the filament color name.
        Either list may be empty.`,
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
      parts.push({ text: `Order text:\n${rawText}` });
    }

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            vendor: { type: Type.STRING },
            order_date: { type: Type.STRING, description: 'Order/invoice date as YYYY-MM-DD, empty if not shown' },
            grand_total: { type: Type.NUMBER },
            spools: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  brand: { type: Type.STRING },
                  material: { type: Type.STRING },
                  color_name: { type: Type.STRING },
                  estimated_color_hex: { type: Type.STRING },
                  weight_grams: { type: Type.NUMBER },
                  quantity: { type: Type.INTEGER },
                  unit_landed_cost: { type: Type.NUMBER },
                },
                required: [
                  'brand',
                  'material',
                  'color_name',
                  'estimated_color_hex',
                  'weight_grams',
                  'quantity',
                  'unit_landed_cost',
                ],
              },
            },
            parts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  category: {
                    type: Type.STRING,
                    enum: ['nozzle', 'hotend', 'ptfe_tube', 'build_plate', 'ams_part', 'maintenance', 'other'],
                  },
                  quantity: { type: Type.INTEGER },
                  unit_landed_cost: { type: Type.NUMBER },
                },
                required: ['name', 'category', 'quantity', 'unit_landed_cost'],
              },
            },
          },
          required: ['vendor', 'spools', 'parts', 'grand_total'],
        },
      },
    });

    const data = JSON.parse(response.text || '{}');
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to parse receipt' },
      { status: 500 }
    );
  }
}
