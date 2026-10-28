'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const config = require('./config');

const INCH = 72;

// Draws the QR code as vector squares (sharp on any printer), runs of dark modules merged per row.
function drawQr(doc, text, x, y, size, ecc = 'M') {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: ecc });
  const n = modules.size;
  const cell = size / n;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!modules.get(row, col)) continue;
      let end = col;
      while (end + 1 < n && modules.get(row, end + 1)) end++;
      // A hair of overlap avoids white seams between squares in some viewers.
      doc.rect(x + col * cell, y + row * cell, (end - col + 1) * cell + 0.05, cell + 0.05);
      col = end;
    }
  }
  doc.fill('#000');
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// Largest font size (down to min) that fits the text in the box.
function fitText(doc, text, font, width, height, max, min) {
  doc.font(font);
  for (let size = max; size > min; size -= 0.5) {
    doc.fontSize(size);
    if (doc.heightOfString(text, { width, lineGap: 0 }) <= height) return size;
  }
  return min;
}

// Largest font size (down to min) that fits the text on one line.
function fitLine(doc, text, font, width, max, min) {
  doc.font(font);
  for (let size = max; size > min; size -= 0.5) {
    if (doc.fontSize(size).widthOfString(text) <= width) return size;
  }
  return min;
}

// Thermal label (3 × 1 in by default): QR on the left, title, text and address on the right.
// One label per page: print `copies` pages.
function labelPdf(copies = 1) {
  const w = config.LABEL_WIDTH_IN * INCH;
  const h = config.LABEL_HEIGHT_IN * INCH;
  const doc = new PDFDocument({ size: [w, h], margin: 0, autoFirstPage: false, info: { Title: `${config.SITE_NAME} – étiquette` } });
  const pad = Math.min(w, h) * 0.08; // also the QR's quiet zone and the printer's margin
  const qr = Math.min(h, w * 0.45) - 2 * pad;
  const textX = pad + qr + pad * 1.4;
  const textW = w - textX - pad;
  const textH = h - 2 * pad;

  for (let i = 0; i < copies; i++) {
    doc.addPage();
    drawQr(doc, config.QR_URL, pad, (h - qr) / 2, qr, 'M');

    // Title, text and address share the height: title ~38 %, text ~42 %, address ~20 %.
    const titleSize = fitText(doc, config.LABEL_TITLE, 'Helvetica-Bold', textW, textH * 0.38, h * 0.2, 5);
    const titleH = doc.font('Helvetica-Bold').fontSize(titleSize).heightOfString(config.LABEL_TITLE, { width: textW });
    const bodySize = fitText(doc, config.LABEL_TEXT, 'Helvetica', textW, textH * 0.42, Math.min(titleSize * 0.8, h * 0.13), 4);
    const bodyH = doc.font('Helvetica').fontSize(bodySize).heightOfString(config.LABEL_TEXT, { width: textW });
    const urlSize = fitText(doc, config.QR_TEXT, 'Helvetica-Bold', textW, textH * 0.2, Math.min(bodySize * 1.1, h * 0.13), 4);
    const urlH = doc.font('Helvetica-Bold').fontSize(urlSize).heightOfString(config.QR_TEXT, { width: textW });
    const gap = Math.max(1, (textH - titleH - bodyH - urlH) / 4);

    let y = pad + gap;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(titleSize).text(config.LABEL_TITLE, textX, y, { width: textW, lineGap: 0 });
    y += titleH + gap;
    doc.font('Helvetica').fontSize(bodySize).text(config.LABEL_TEXT, textX, y, { width: textW, lineGap: 0 });
    y += bodyH + gap;
    doc.font('Helvetica-Bold').fontSize(urlSize).text(config.QR_TEXT, textX, y, { width: textW, lineGap: 0 });
  }
  return toBuffer(doc);
}

// Poster: the same block (title, big QR, text, address) 4 times on one sheet, with cut marks.
function posterPdf() {
  const doc = new PDFDocument({ size: config.POSTER_PAGE, margin: 0, info: { Title: `${config.SITE_NAME} – affiche` } });
  const { width, height } = doc.page;
  const cw = width / 2;
  const ch = height / 2;
  const pad = 0.35 * INCH;

  for (let i = 0; i < 4; i++) {
    const x0 = (i % 2) * cw;
    const y0 = Math.floor(i / 2) * ch;
    const innerW = cw - 2 * pad;

    const titleSize = fitLine(doc, config.POSTER_TITLE, 'Helvetica-Bold', innerW, 26, 12);
    const titleH = doc.font('Helvetica-Bold').fontSize(titleSize).heightOfString(config.POSTER_TITLE, { width: innerW, align: 'center' });
    const bodySize = fitText(doc, config.POSTER_TEXT, 'Helvetica', innerW, ch * 0.16, 13, 7);
    const bodyH = doc.font('Helvetica').fontSize(bodySize).heightOfString(config.POSTER_TEXT, { width: innerW, align: 'center' });
    const urlSize = 14;
    const urlH = doc.font('Helvetica-Bold').fontSize(urlSize).heightOfString(config.QR_TEXT, { width: innerW });
    const gap = 10;
    const qr = Math.min(innerW, ch - 2 * pad - titleH - bodyH - urlH - 3 * gap);

    let y = y0 + (ch - (titleH + qr + bodyH + urlH + 3 * gap)) / 2;
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(titleSize)
      .text(config.POSTER_TITLE, x0 + pad, y, { width: innerW, align: 'center' });
    y += titleH + gap;
    drawQr(doc, config.QR_URL, x0 + (cw - qr) / 2, y, qr, 'Q');
    y += qr + gap;
    doc.fillColor('#000').font('Helvetica').fontSize(bodySize).text(config.POSTER_TEXT, x0 + pad, y, { width: innerW, align: 'center' });
    y += bodyH + gap;
    doc.font('Helvetica-Bold').fontSize(urlSize).text(config.QR_TEXT, x0 + pad, y, { width: innerW, align: 'center' });
  }

  // Dashed cut lines between the 4 copies.
  doc.save().lineWidth(0.5).strokeColor('#999').dash(4, { space: 4 })
    .moveTo(cw, 0).lineTo(cw, height).moveTo(0, ch).lineTo(width, ch).stroke().restore();
  return toBuffer(doc);
}

module.exports = { labelPdf, posterPdf };
