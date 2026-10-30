/**
 * Longest edge worth sending. Anthropic downsamples past ~1568px and OpenAI
 * tiles at 768px, so anything larger costs upload time and tokens for detail
 * the model never sees.
 */
const MAX_EDGE = 1568;
const QUALITY = 0.8;

/** Scale factor that fits w×h inside a square of `max`, never upscaling. */
export function fitScale(width: number, height: number, max = MAX_EDGE): number {
  return Math.min(1, max / Math.max(width, height));
}

/**
 * Image file → downscaled JPEG data URL.
 *
 * A phone screenshot pasted raw is several megabytes of base64 that buys no
 * accuracy — it would blow both the request body and the transcript quota.
 */
export async function toAttachment(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = fitScale(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
    return await blobToDataUrl(blob);
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}
