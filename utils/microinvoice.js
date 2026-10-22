'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const _merge = require('lodash.merge');
const { printableText } = require('./pdf-text');

/**
 * Invoice
 * This is the constructor that creates a new instance containing the needed
 * methods.
 *
 * @name Invoice
 * @function
 * @param {Object} options The options for creating the new invoice:
 */
module.exports = class Microinvoice {
  constructor(options) {
    this.defaultOptions = {
      style: {
        document: {
          marginLeft: 30,
          marginRight: 30,
          marginTop: 30,
        },

        fonts: {
          normal: {
            name: 'Rubik',
            range: /[^\u0000-\u0500]/m,
            path: path.join(__dirname, '', 'Rubik-Regular.ttf'),
          },
          bold: {
            name: 'Rubik-Medium',
            path: path.join(__dirname, '', 'Rubik-Medium.ttf'),
          },
          fallback: {
            name: 'Rubik',
            path: path.join(__dirname, '', 'Rubik-Regular.ttf'),
            enabled: true,
            range: /[^\u0000-\u0500]/m,
            transliterate: true,
          },
        },
        header: {
          backgroundColor: '#F8F8FA',
          height: 135,
          image: null,
          qr: {
            left: 460,
          },
          textPosition: 330,
        },
        table: {
          quantity: {
            position: 330,
            maxWidth: 140,
          },
          total: {
            position: 490,
            maxWidth: 80,
          },
          lineHeight: 9,
        },
        text: {
          primaryColor: '#000100',
          secondaryColor: '#8F8F8F',
          headingSize: 14,
          regularSize: 8,
        },
      },

      data: {
        invoice: {
          name: 'Invoice for Acme',
          header: [
            {
              label: 'Invoice Number',
              value: 1,
            },
          ],
          customer: [
            {
              label: 'Bill To',
              value: [],
            },
          ],
          seller: [
            {
              label: 'Bill From',
              value: [],
            },
          ],
          details: {
            header: [
              {
                value: 'Description',
              },
              {
                value: 'Quantity',
              },
              {
                value: 'Subtotal',
              },
            ],
            parts: [],
            total: [
              {
                label: 'Total',
                value: 0,
              },
            ],
          },
          legal: [],
        },
      },
    };

    this.options = _merge(this.defaultOptions, options);

    this.storage = {
      header: {
        image: null,
        qr: null,
      },
      cursor: {
        x: 0,
        y: 0,
      },
      customer: {
        height: 0,
      },
      seller: {
        height: 0,
      },
      fonts: {
        fallback: {
          loaded: false,
        },
      },
      document: null,
      table: {
        inTableSection: false,
        headerHeight: 0,
      },
    };
  }

  /**
   * Load custom fonts
   *
   * @private
   * @return void
   */
  loadCustomFonts() {
    // Register custom fonts
    if (this.options.style.fonts.normal.path) {
      this.document.registerFont(this.options.style.fonts.normal.name, this.options.style.fonts.normal.path);
    }

    if (this.options.style.fonts.bold.path) {
      this.document.registerFont(this.options.style.fonts.bold.name, this.options.style.fonts.bold.path);
    }
  }

  /**
   * Load fallback font (unicode chars)
   *
   * @private
   * @return void
   */
  getFontOrFallback(type, value) {
    let _normalRange = this.options.style.fonts.normal.range;
    let _fallbackRange = this.options.style.fonts.fallback.range;

    if (type !== 'normal' && type !== 'bold') {
      type = 'normal';
    }

    // Return default font
    if (this.options.style.fonts.fallback.enabled === false) {
      return this.options.style.fonts[type].name;
    }

    // Return default font if not special chars are found
    if (!_normalRange.test((value || '').toString())) {
      return this.options.style.fonts[type].name;
    }

    // Return default font if fallback font if range not supported
    if (_fallbackRange.test((value || '').toString())) {
      return this.options.style.fonts[type].name;
    }

    if (this.storage.fonts.fallback.loaded === false) {
      this.document.registerFont(
        this.options.style.fonts.fallback.name,
        this.options.style.fonts.fallback.path,
      );
      this.storage.fonts.fallback.loaded = true;
    }

    // Return fallback font
    return this.options.style.fonts.fallback.name;
  }

  /**
   * Show value or transliterate
   *
   * @private
   * @param  {string} value
   * @return void
   */
  valueOrTransliterate(value) {
    let _fallbackRange = this.options.style.fonts.fallback.range;

    // Return default font
    if (this.options.style.fonts.fallback.enabled === false) {
      return value;
    }

    // Return default font if not special chars are found
    if (!_fallbackRange.test((value || '').toString())) {
      return value;
    }

    return printableText(value, this.options.style.fonts.fallback.path);
  }

  /**
   * Generates the header
   *
   * @private
   * @return void
   */
  generateHeader() {
    // Background Rectangle
    this.document
      .rect(0, 0, this.document.page.width, this.options.style.header.height)
      .fill(this.options.style.header.backgroundColor);

    // Add an image to the header if any
    if (this.options.style.header.image && this.options.style.header.image.path) {
      this.document.image(
        this.options.style.header.image.path,
        this.options.style.document.marginLeft,
        this.options.style.document.marginTop,
        {
          width: this.options.style.header.image.width,
          height: this.options.style.header.image.height,
        },
      );
    }

    if (this.options.style.header.qr && this.options.style.header.qr.path) {
      this.document.image(
        this.options.style.header.qr.path,
        this.options.style.header.qr.left,
        this.options.style.document.marginTop,
        {
          width: this.options.style.header.qr.width,
          height: this.options.style.header.qr.height,
        },
      );

      if (this.options.style.header.qr.verifactu) {
        // Add text VER*FACTU at the bottom of the QR code
        this.setCursor('x', this.options.style.header.qr.left + 7);
        this.setCursor('y', this.options.style.document.marginTop + 65);
        this.setText('VERI*FACTU', {
          // fontSize   : "heading",
          fontWeight: 'bold',
          color: this.options.style.header.regularColor,
        });
      }
    }

    let _fontMargin = 4;

    // Write header details
    this.setCursor('x', this.options.style.header.textPosition);
    this.setCursor('y', this.options.style.document.marginTop);

    this.setText(this.options.data.invoice.name, {
      fontSize: 'heading',
      fontWeight: 'bold',
      color: this.options.style.header.regularColor,
    });

    this.options.data.invoice.header.forEach((line) => {
      this.setText(`${line.label}:`, {
        fontWeight: 'bold',
        color: this.options.style.header.regularColor,
        marginTop: _fontMargin,
      });

      let _values = [];

      if (Array.isArray(line.value)) {
        _values = line.value;
      } else {
        _values = [line.value];
      }

      _values.forEach((value) => {
        this.setText(value, {
          colorCode: 'secondary',
          color: this.options.style.header.secondaryColor,
          marginTop: _fontMargin,
        });
      });
    });
  }

  /**
   * Generates customer and seller
   *
   * @private
   * @return void
   */
  generateDetails(type) {
    let _maxWidth = 250;
    let _fontMargin = 4;

    this.setCursor('y', this.options.style.header.height + 18);

    // Use a different left position
    if (type === 'customer') {
      this.setCursor('x', this.options.style.document.marginLeft);
    } else {
      this.setCursor('x', this.options.style.header.textPosition);
    }

    this.options.data.invoice[type].forEach((line) => {
      this.setText(`${line.label}:`, {
        colorCode: 'primary',
        fontWeight: 'bold',
        marginTop: 8,
        maxWidth: _maxWidth,
      });

      let _values = [];

      if (Array.isArray(line.value)) {
        _values = line.value;
      } else {
        _values = [line.value];
      }

      _values.forEach((value) => {
        this.setText(value, {
          colorCode: 'secondary',
          marginTop: _fontMargin,
          maxWidth: _maxWidth,
        });
      });
    });

    this.storage[type].height = this.storage.cursor.y;
  }

  /**
   * Generates table headers only
   *
   * @private
   * @return void
   */
  generateTableHeader() {
    // Add some spacing before the header
    this.setText('\n');
    this.generateTableRow('header', this.options.data.invoice.details.header);
    this.storage.table.headerHeight = this.storage.cursor.y;
  }

  /**
   * Check if we need to add a new page and headers
   *
   * @private
   * @param  {number} requiredSpace - Space needed for the next content
   * @return void
   */
  checkPageBreakAndAddHeaders(requiredSpace = 50) {
    // pdfkit breaks pages by itself at its bottom margin (page.maxY()); breaking
    // before it keeps a row or section whole on one page (issues/318)
    if (this.storage.cursor.y + requiredSpace > this.document.page.maxY()) {
      this.document.addPage();
      this.setCursor('y', this.options.style.document.marginTop);
      this.document.y = this.storage.cursor.y;

      // Add table headers on the new page
      if (this.storage.table.inTableSection) {
        this.generateTableHeader();
      }
    }
  }

  /**
   * Height of a text drawn with setText's options, without drawing it
   *
   * @private
   */
  measureText(text, { fontWeight = 'normal', maxWidth } = {}) {
    this.document.font(this.getFontOrFallback(fontWeight, text));
    this.document.fontSize(this.options.style.text.regularSize);
    return this.document.heightOfString(this.valueOrTransliterate(text), { width: maxWidth });
  }

  /**
   * Generates a row
   *
   * Every cell is measured first: the row is as tall as its tallest cell, the
   * next row starts below it (a wrapped discount overlapped the next row), and
   * a row that does not fit goes whole to the next page (issues/318).
   *
   * @private
   * @param  {string} type
   * @param  {array} columns
   * @return void
   */
  generateTableRow(type, columns) {
    const header = type === 'header';
    const _fontWeight = header ? 'bold' : 'normal';
    const _colorCode = header ? 'primary' : 'secondary';

    const totalMaxWidth =
      this.document.page.width -
      this.options.style.document.marginRight -
      this.options.style.document.marginLeft -
      (columns.length - 1) * 10;

    const cells = columns.map((column) => {
      let value = column.value;
      if (column.price === true) value = this.prettyPrice(value);
      value = value === null || value === undefined ? '' : String(value);
      const maxWidth = totalMaxWidth * column.width;
      return { value, maxWidth, height: this.measureText(value, { fontWeight: _fontWeight, maxWidth }) };
    });
    const rowHeight = Math.max(...cells.map((c) => c.height));
    const lineHeight = this.options.style.table.lineHeight;

    if (!header) {
      // the header's separator line takes ~10 pt more below the row
      this.checkPageBreakAndAddHeaders(lineHeight + rowHeight);
    }

    this.storage.cursor.y += lineHeight;
    const top = this.storage.cursor.y;

    let _start = this.options.style.document.marginLeft;
    cells.forEach((cell, index) => {
      this.setCursor('x', _start);
      this.setCursor('y', top);
      this.setText(cell.value, {
        colorCode: _colorCode,
        maxWidth: cell.maxWidth,
        fontWeight: _fontWeight,
        align: index === 0 ? 'left' : 'right',
      });
      _start += cell.maxWidth + 10;
    });

    const bottom = top + rowHeight;
    if (header) {
      this.setCursor('y', bottom - 5);
      this.generateLine();
    }
    this.setCursor('y', bottom);
    this.document.y = bottom;
  }

  /**
   * Generates a line separator
   *
   * @private
   * @return void
   */
  generateLine() {
    this.storage.cursor.y += this.options.style.text.regularSize + 2;

    this.document
      .strokeColor('#F0F0F0')
      .lineWidth(1)
      .moveTo(this.options.style.document.marginRight, this.storage.cursor.y)
      .lineTo(this.document.page.width - this.options.style.document.marginRight, this.storage.cursor.y)
      .stroke();
  }

  /**
   * Generates invoice parts
   *
   * @private
   * @return void
   */
  generateParts() {
    let _startY = Math.max(this.storage.customer.height, this.storage.seller.height);

    let _fontMargin = 4;
    let _leftMargin = 15;

    this.setCursor('y', _startY);

    // The invoice's concept, above the lines (issues/312)
    const concept = this.options.data.invoice.details.concept;
    if (concept) {
      this.setCursor('x', this.options.style.document.marginLeft);
      this.setText('\n');
      this.setText(`Concepte: ${concept}`, {
        fontWeight: 'bold',
        colorCode: 'primary',
        maxWidth: this.document.page.width - this.options.style.document.marginLeft - this.options.style.document.marginRight,
      });
    }

    // Mark that we're entering the table section
    this.storage.table.inTableSection = true;

    // Generate the initial table header
    this.generateTableHeader();

    (this.options.data.invoice.details.parts || []).forEach((part) => {
      this.generateTableRow('row', part);
    });

    // Mark that we're leaving the table section
    this.storage.table.inTableSection = false;

    // Check if we have enough space for the totals section
    const totalsSectionHeight = (this.options.data.invoice.details.total || []).length * 20 + 50;
    this.checkPageBreakAndAddHeaders(totalsSectionHeight);

    this.storage.cursor.y += 50;

    (this.options.data.invoice.details.total || []).forEach((total, index) => {
      let _mainRatio = 0.6,
        _secondaryRatio = 0.3;
      let _margin = 30;
      let _value = total.value;

      this.setCursor('x', this.options.style.table.quantity.position);
      this.setText(total.label, {
        colorCode: 'primary',
        fontWeight: 'bold',
        marginTop: 6,
        maxWidth: this.options.style.table.quantity.maxWidth,
        skipDown: true,
      });

      this.setCursor('x', this.options.style.table.total.position);

      if (total.price === true) {
        _value = this.prettyPrice(total.value);
      }

      if (this.options.data.invoice.details.total.length - 1 === index) {
        this.setText(_value, {
          colorCode: 'primary',
          fontWeight: 'bold',
          maxWidth: this.options.style.table.total.maxWidth - 4,
          fontWeight: 'bold',
          align: 'right',
        });
      } else {
        this.setText(_value, {
          colorCode: 'secondary',
          maxWidth: this.options.style.table.total.maxWidth - 4,
          fontWeight: 'normal',
          align: 'right',
        });
      }

      // this.setText(_value, {
      //   colorCode : "secondary",
      //   maxWidth  : this.options.style.table.total.maxWidth,
      //   fontWeight : "bold",
      // });
    });
  }

  /**
   * Generates legal terms
   *
   * @private
   * @return void
   */
  generateLegal() {
    // Check if we have enough space for the legal section
    const legalSectionHeight =
      40 +
      (this.options.data.invoice.legal || []).reduce(
        (sum, legal) =>
          sum +
          20 +
          this.measureText(legal.value, {
            fontWeight: legal.weight,
            maxWidth:
              this.document.page.width -
              this.options.style.document.marginLeft -
              this.options.style.document.marginRight,
          }),
        0,
      );
    this.checkPageBreakAndAddHeaders(legalSectionHeight);

    this.storage.cursor.y += 40;

    (this.options.data.invoice.legal || []).forEach((legal) => {
      this.generateLine();
      this.storage.cursor.y += 10;
      this.setCursor('x', this.options.style.document.marginLeft);

      this.setText(legal.value, {
        fontWeight: legal.weight,
        colorCode: legal.color || 'primary',
        align: 'left',
        marginTop: 0,
      });
    });
  }

  /**
   * Moves the internal cursor
   *
   * @private
   * @param  {string} axis
   * @param  {number} value
   * @return void
   */
  setCursor(axis, value) {
    this.storage.cursor[axis] = value;
  }

  /**
   * Convert numbers to fixed value and adds currency
   *
   * @private
   * @param  {string | number} value
   * @return string
   */
  prettyPrice(value) {
    if (typeof value === 'number') {
      value = this.formatCurrency(value);
    }

    if (this.options.data.invoice.currency) {
      value = `${value} ${this.options.data.invoice.currency}`;
    }

    return value;
  }

  formatCurrency(val) {
    if (!val) {
      return '-';
    }
    return val
      .toFixed(2)
      .replace(/\d(?=(\d{3})+\.)/g, '$&;')
      .replace(/\./g, ',')
      .replace(/;/g, '.');
  }

  /**
   * Adds text on the invoice with specified optons
   *
   * @private
   * @param  {string} text
   * @param  {object} options
   * @return void
   */
  setText(text, options = {}) {
    let _fontWeight = options.fontWeight || 'normal';
    let _colorCode = options.colorCode || 'primary';
    let _fontSize = options.fontSize || 'regular';
    let _textAlign = options.align || 'left';
    let _color = options.color || '';
    let _marginTop = options.marginTop || 0;
    let _maxWidth = options.maxWidth;
    let _fontSizeValue = 0;

    this.storage.cursor.y += _marginTop;

    if (!_color) {
      if (_colorCode === 'primary') {
        this.document.fillColor(this.options.style.text.primaryColor);
      } else {
        this.document.fillColor(this.options.style.text.secondaryColor);
      }
    }

    if (_fontSize === 'regular') {
      _fontSizeValue = this.options.style.text.regularSize;
    } else {
      _fontSizeValue = this.options.style.text.headingSize;
    }

    this.document.font(this.getFontOrFallback(_fontWeight, text));

    this.document.fillColor(_color);
    this.document.fontSize(_fontSizeValue);

    this.document.text(this.valueOrTransliterate(text), this.storage.cursor.x, this.storage.cursor.y, {
      align: _textAlign,
      width: _maxWidth,
    });

    let _diff = this.document.y - this.storage.cursor.y;

    this.storage.cursor.y = this.document.y;

    // Do not move down
    if (options.skipDown === true) {
      if (_diff > 0) {
        this.storage.cursor.y -= _diff;
      } else {
        this.storage.cursor.y -= 11.5;
      }
    }
  }

  /**
   * Generates a PDF invoide
   *
   * @public
   * @param  {string|object} output
   * @return Promise
   */
  generate(output) {
    let _stream = null;

    this.document = new PDFDocument({
      size: 'A4',
    });

    this.loadCustomFonts();
    this.generateHeader();
    this.generateDetails('customer');
    this.generateDetails('seller');
    this.generateParts();
    this.generateLegal();

    if (typeof output === 'string' || (output || {}).type === 'file') {
      let _path = '';

      if (typeof output === 'string') {
        _path = output;
      } else {
        _path = output.path;
      }

      _stream = fs.createWriteStream(output);

      this.document.pipe(_stream);
      this.document.end();
    } else {
      this.document.end();
      return this.document;
    }

    return new Promise((resolve, reject) => {
      this.document.on('end', () => {
        return resolve();
      });

      this.document.on('error', () => {
        return reject();
      });
    });
  }
};
