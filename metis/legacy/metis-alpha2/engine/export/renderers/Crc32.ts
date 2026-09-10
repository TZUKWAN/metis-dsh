/**
 * CRC-32 implementation (IEEE 802.3 polynomial 0xEDB88320 reversed form).
 * Required by the ZIP file format for per-entry checksums.
 *
 * This is a dependency-free, deterministic implementation that produces
 * identical results to Node's `zlib.crc32` (available in newer Node versions)
 * but works on any Node.js version.
 */

const CRC32_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let crc = i;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc & 1) !== 0 ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  CRC32_TABLE[i] = crc >>> 0;
}

/**
 * Compute the CRC-32 checksum of a byte array.
 * Returns an unsigned 32-bit integer.
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xFF]! ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
