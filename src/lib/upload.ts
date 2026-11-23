/**
 * Helpers for sending receipt / screenshot files to the AI routes.
 *
 * Vercel rejects request bodies over 4.5 MB (HTTP 413), and base64 makes a file ~33% bigger, so
 * anything sent inline must stay under ~3 MB. Photos are shrunk in the browser first; files that
 * are still too big (e.g. a long PDF) go to Supabase Storage and the server fetches them there.
 */

/** Max raw file size we send inline as base64 (≈4 MB after encoding, under Vercel's 4.5 MB). */
export const INLINE_LIMIT_BYTES = 3 * 1024 * 1024;

/**
 * Downscales a photo to at most `maxDim` px on its long side and re-encodes it as JPEG.
 * Returns the original file for non-images, files that can't be decoded (e.g. HEIC in some
 * browsers) or when the result wouldn't be smaller.
 */
export async function shrinkImage(file: File, maxDim = 2400, quality = 0.85): Promise<File> {
  if (!file.type.startsWith('image/') || /gif|svg/.test(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1.5 * 1024 * 1024) {
      bitmap.close();
      return file;
    }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff'; // transparent PNG areas become white, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export function fileExtension(file: File): string {
  const fromName = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fromName && fromName !== file.name.toLowerCase()) return fromName;
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('image/')) return file.type.slice(6).replace(/[^a-z0-9]/g, '') || 'img';
  return 'bin';
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
