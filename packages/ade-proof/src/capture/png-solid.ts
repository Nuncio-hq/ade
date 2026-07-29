import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bytesPerPixel(colorType: number): number | undefined {
  if (colorType === 0) return 1; // grayscale
  if (colorType === 2) return 3; // RGB
  if (colorType === 4) return 2; // grayscale + alpha
  if (colorType === 6) return 4; // RGBA
  return undefined;
}

/** Quick PNG scan: return true if every pixel is identical (filter 0 rows only). */
export async function isSolidImage(filePath: string): Promise<boolean> {
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch {
    return false;
  }
  if (
    buf.length < PNG_SIGNATURE.length ||
    !buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return false;
  }

  let pos = PNG_SIGNATURE.length;
  let ihdr: Buffer | undefined;
  const idatChunks: Buffer[] = [];

  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idatChunks.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }

  if (!ihdr || idatChunks.length === 0) return false;

  if (ihdr.length < 13) return false;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth === undefined || colorType === undefined || interlace === undefined) return false;
  if (interlace !== 0) return false;
  if (bitDepth !== 8) return false;

  const bpp = bytesPerPixel(colorType);
  if (!bpp) return false;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return false;
  }

  const rowSize = 1 + width * bpp;
  if (raw.length < rowSize * height) return false;

  const firstPixel = raw.subarray(1, 1 + bpp);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    if (raw[rowStart] !== 0) return false; // only filter 0 (None) supported
    for (let x = 0; x < width; x++) {
      const pixel = raw.subarray(rowStart + 1 + x * bpp, rowStart + 1 + (x + 1) * bpp);
      if (!pixel.equals(firstPixel)) return false;
    }
  }
  return true;
}
