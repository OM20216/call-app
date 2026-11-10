import qrcode from 'qrcode-generator';

/*
 * SVG QR code. The Node version used the `qrcode` package to make a PNG,
 * but PNG needs a canvas/encoder. SVG is pure string work, scales perfectly
 * in <img> tags and prints cleanly, and every phone camera reads it.
 */
export function qrSvg(text, size = 360) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  let path = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  );
}
