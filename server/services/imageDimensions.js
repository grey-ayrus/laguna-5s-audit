/**
 * Read the natural (pixel) width & height from an image buffer without
 * pulling in a native dependency. Supports JPEG and PNG, which is what
 * the audit flow actually writes / receives.
 *
 * Returns { width, height } or null if the buffer is not recognised.
 */

function readJpegDimensions(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    let marker = buffer[offset + 1];
    // Skip fill bytes 0xFF 0xFF ...
    while (marker === 0xff && offset + 1 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    offset += 2;

    // Standalone markers without a length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);

    // SOF0..SOF15 except 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC).
    if (
      marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      if (offset + 7 > buffer.length) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!width || !height) return null;
      return { width, height };
    }

    offset += segmentLength;
  }

  return null;
}

function readPngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50
    || buffer[2] !== 0x4e || buffer[3] !== 0x47
  ) return null;
  // IHDR follows the 8-byte signature + 4-byte length + 4-byte "IHDR" marker.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export function getImageDimensions(buffer) {
  if (!buffer || !buffer.length) return null;
  return readJpegDimensions(buffer) || readPngDimensions(buffer) || null;
}
