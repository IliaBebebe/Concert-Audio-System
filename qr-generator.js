/**
 * Zero-dependency self-contained QR Code Generator (SVG output)
 * Compliant with ISO/IEC 18004 specification.
 * Supports Byte Mode, Error Correction Level M, Versions 1-10.
 */

class QRCode {
    static generateSVG(text, options = {}) {
        const size = options.size || 220;
        const margin = options.margin !== undefined ? options.margin : 2;
        const color = options.color || '#000000';
        const background = options.background || '#ffffff';

        const matrix = QRCode.createMatrix(text);
        const moduleCount = matrix.length;
        const totalSize = moduleCount + margin * 2;
        const cellSize = size / totalSize;

        let path = '';
        for (let r = 0; r < moduleCount; r++) {
            for (let c = 0; c < moduleCount; c++) {
                if (matrix[r][c]) {
                    const x = ((c + margin) * cellSize).toFixed(2);
                    const y = ((r + margin) * cellSize).toFixed(2);
                    const w = cellSize.toFixed(2);
                    path += `M${x},${y}h${w}v${w}h-${w}z `;
                }
            }
        }

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="${background}" rx="10" />
  <path d="${path.trim()}" fill="${color}" />
</svg>`;
    }

    static createMatrix(text) {
        const bytes = new TextEncoder().encode(text);
        const version = QRCode._selectVersion(bytes.length);
        const moduleCount = version * 4 + 17;

        // Initialize empty matrix
        const matrix = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(null));
        const isFunction = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(false));

        // 1. Finder patterns
        QRCode._drawFinderPattern(matrix, isFunction, 0, 0);
        QRCode._drawFinderPattern(matrix, isFunction, moduleCount - 7, 0);
        QRCode._drawFinderPattern(matrix, isFunction, 0, moduleCount - 7);

        // 2. Alignment patterns
        const alignPos = QRCode.ALIGNMENT_PATTERNS[version];
        if (alignPos) {
            for (const r of alignPos) {
                for (const c of alignPos) {
                    if (isFunction[r][c]) continue;
                    QRCode._drawAlignmentPattern(matrix, isFunction, r, c);
                }
            }
        }

        // 3. Timing patterns
        for (let i = 8; i < moduleCount - 8; i++) {
            if (!isFunction[6][i]) {
                matrix[6][i] = i % 2 === 0 ? 1 : 0;
                isFunction[6][i] = true;
            }
            if (!isFunction[i][6]) {
                matrix[i][6] = i % 2 === 0 ? 1 : 0;
                isFunction[i][6] = true;
            }
        }

        // 4. Dark module
        matrix[moduleCount - 8][8] = 1;
        isFunction[moduleCount - 8][8] = true;

        // 5. Reserve format info areas
        for (let i = 0; i < 9; i++) {
            if (i !== 6) {
                isFunction[8][i] = true;
                isFunction[i][8] = true;
            }
        }
        for (let i = 0; i < 8; i++) {
            isFunction[8][moduleCount - 8 + i] = true;
            isFunction[moduleCount - 8 + i][8] = true;
        }

        // 6. Generate data codewords
        const dataBits = QRCode._encodeData(bytes, version);
        const totalDataCodewords = QRCode.TOTAL_DATA_CODEWORDS[version];
        const ecCodewordsPerBlock = QRCode.EC_CODEWORDS_PER_BLOCK[version];
        const numBlocks = QRCode.NUM_BLOCKS[version];

        // Pad data bits to 8-bit boundary
        while (dataBits.length % 8 !== 0) dataBits.push(0);

        // Add pad bytes
        const padBytes = [0xEC, 0x11];
        let padIndex = 0;
        while (dataBits.length < totalDataCodewords * 8) {
            const pb = padBytes[padIndex % 2];
            for (let b = 7; b >= 0; b--) {
                dataBits.push((pb >> b) & 1);
            }
            padIndex++;
        }

        // Group into blocks and calculate Reed-Solomon EC
        const dataBytes = [];
        for (let i = 0; i < dataBits.length; i += 8) {
            let val = 0;
            for (let b = 0; b < 8; b++) {
                val = (val << 1) | dataBits[i + b];
            }
            dataBytes.push(val);
        }

        const blocks = [];
        const baseBlockLen = Math.floor(totalDataCodewords / numBlocks);
        const extraBlocks = totalDataCodewords % numBlocks;

        let byteOffset = 0;
        for (let b = 0; b < numBlocks; b++) {
            const blockLen = baseBlockLen + (b >= numBlocks - extraBlocks ? 1 : 0);
            const blockData = dataBytes.slice(byteOffset, byteOffset + blockLen);
            byteOffset += blockLen;
            const ecData = QRCode._computeReedSolomon(blockData, ecCodewordsPerBlock);
            blocks.push({ data: blockData, ec: ecData });
        }

        // Interleave codewords
        const interleavedBits = [];
        const maxDataLen = Math.max(...blocks.map(b => b.data.length));
        for (let i = 0; i < maxDataLen; i++) {
            for (const blk of blocks) {
                if (i < blk.data.length) {
                    for (let bit = 7; bit >= 0; bit--) {
                        interleavedBits.push((blk.data[i] >> bit) & 1);
                    }
                }
            }
        }
        for (let i = 0; i < ecCodewordsPerBlock; i++) {
            for (const blk of blocks) {
                for (let bit = 7; bit >= 0; bit--) {
                    interleavedBits.push((blk.ec[i] >> bit) & 1);
                }
            }
        }

        // Remainder bits (if any for version)
        const remainderBits = QRCode.REMAINDER_BITS[version] || 0;
        for (let i = 0; i < remainderBits; i++) interleavedBits.push(0);

        // 7. Place data bits using zigzag traversal
        let bitIndex = 0;
        let upwards = true;
        for (let rightCol = moduleCount - 1; rightCol > 0; rightCol -= 2) {
            if (rightCol === 6) rightCol--; // Skip vertical timing column
            const cols = [rightCol, rightCol - 1];
            const rows = upwards
                ? Array.from({ length: moduleCount }, (_, i) => moduleCount - 1 - i)
                : Array.from({ length: moduleCount }, (_, i) => i);

            for (const r of rows) {
                for (const c of cols) {
                    if (!isFunction[r][c]) {
                        const bit = bitIndex < interleavedBits.length ? interleavedBits[bitIndex++] : 0;
                        matrix[r][c] = bit;
                    }
                }
            }
            upwards = !upwards;
        }

        // 8. Apply mask (Pattern 0: (r + c) % 2 === 0)
        const maskPattern = 0;
        for (let r = 0; r < moduleCount; r++) {
            for (let c = 0; c < moduleCount; c++) {
                if (!isFunction[r][c]) {
                    if ((r + c) % 2 === 0) {
                        matrix[r][c] ^= 1;
                    }
                }
            }
        }

        // 9. Draw format info (ECC Level M = 00, Mask 0 = 000 -> 00000 -> XOR with 0x5412 = 0x5412)
        // Precomputed 15-bit format strings for Level M:
        // Mask 0: 00 000 -> BCH code: 101010000010010 (0x5412) -> after mask 0x5412 = 000000000000000 -> 101010000010010
        const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
        QRCode._drawFormatInfo(matrix, formatBits);

        return matrix;
    }

    static _selectVersion(byteLength) {
        // Capacities for ECC Level M in byte mode
        const capacities = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
        for (let v = 1; v <= 10; v++) {
            if (byteLength <= capacities[v]) return v;
        }
        return 10;
    }

    static _encodeData(bytes, version) {
        const bits = [];
        // Mode indicator for Byte Mode: 0100
        bits.push(0, 1, 0, 0);

        // Character count indicator: 8 bits for versions 1-9, 16 bits for version 10
        const countBits = version <= 9 ? 8 : 16;
        for (let b = countBits - 1; b >= 0; b--) {
            bits.push((bytes.length >> b) & 1);
        }

        // Data bytes
        for (let i = 0; i < bytes.length; i++) {
            const byte = bytes[i];
            for (let b = 7; b >= 0; b--) {
                bits.push((byte >> b) & 1);
            }
        }

        // Terminator (up to 4 zeros)
        const totalDataBits = QRCode.TOTAL_DATA_CODEWORDS[version] * 8;
        const termLen = Math.min(4, Math.max(0, totalDataBits - bits.length));
        for (let i = 0; i < termLen; i++) bits.push(0);

        return bits;
    }

    static _drawFinderPattern(matrix, isFunction, row, col) {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const mr = row + r;
                const mc = col + c;
                if (mr < 0 || mr >= matrix.length || mc < 0 || mc >= matrix.length) continue;
                isFunction[mr][mc] = true;
                if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
                    if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
                        matrix[mr][mc] = 1;
                    } else {
                        matrix[mr][mc] = 0;
                    }
                } else {
                    matrix[mr][mc] = 0; // Separator
                }
            }
        }
    }

    static _drawAlignmentPattern(matrix, isFunction, centerRow, centerCol) {
        for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
                const mr = centerRow + r;
                const mc = centerCol + c;
                isFunction[mr][mc] = true;
                if (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) {
                    matrix[mr][mc] = 1;
                } else {
                    matrix[mr][mc] = 0;
                }
            }
        }
    }

    static _drawFormatInfo(matrix, bits) {
        const n = matrix.length;
        // Top-left finder area
        const coords1 = [
            [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
            [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
        ];
        // Split around other finders
        const coords2 = [
            [n - 1, 8], [n - 2, 8], [n - 3, 8], [n - 4, 8], [n - 5, 8], [n - 6, 8], [n - 7, 8],
            [8, n - 8], [8, n - 7], [8, n - 6], [8, n - 5], [8, n - 4], [8, n - 3], [8, n - 2], [8, n - 1]
        ];

        for (let i = 0; i < 15; i++) {
            matrix[coords1[i][0]][coords1[i][1]] = bits[i];
            matrix[coords2[i][0]][coords2[i][1]] = bits[i];
        }
    }

    static _computeReedSolomon(data, ecCount) {
        // Galois Field GF(256) arithmetic
        const exp = new Uint8Array(512);
        const log = new Uint8Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) {
            exp[i] = x;
            exp[i + 255] = x;
            log[x] = i;
            x = (x << 1) ^ (x >= 128 ? 0x11D : 0);
        }

        const mul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);

        // Generator polynomial
        let gen = [1];
        for (let i = 0; i < ecCount; i++) {
            const next = new Uint8Array(gen.length + 1);
            for (let j = 0; j < gen.length; j++) {
                next[j] ^= mul(gen[j], exp[i]);
                next[j + 1] ^= gen[j];
            }
            gen = next;
        }

        // Polynomial division
        const res = new Uint8Array(ecCount);
        for (let i = 0; i < data.length; i++) {
            const factor = data[i] ^ res[0];
            for (let j = 0; j < ecCount - 1; j++) {
                res[j] = res[j + 1] ^ mul(gen[ecCount - 1 - j], factor);
            }
            res[ecCount - 1] = mul(gen[0], factor);
        }

        return Array.from(res);
    }
}

// Version metadata for Level M
QRCode.TOTAL_DATA_CODEWORDS = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
QRCode.EC_CODEWORDS_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
QRCode.NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
QRCode.REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];
QRCode.ALIGNMENT_PATTERNS = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50]
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { QRCode };
}
