'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const _merge = require('lodash.merge');
const transliterate = require('transliteration').transliterate;

/**
 * Invoice
 * This is the constructor that creates a new instance containing the needed
 * methods.
 *
 * @name Invoice
 * @function
 * @param {Object} options The options for creating the new invoice:
 */
module.exports = class MicroinvoiceOrder {
  constructor(options) {
    this.defaultOptions = {
      style: {
        document: {
          marginLeft: 20,
          marginRight: 20,
          marginTop: 20,
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
          height: 112,
          image: null,
          qr: {
            left: 465,
            width: 120,
            height: 120,
          },
          textPosition: 330,
          textPositionSeller: 430,
          textPositionProvider: 330,
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
        },
        text: {
          primaryColor: '#8F8F8F',
          secondaryColor: '#000100',
          headingSize: 18,
          regularSize: 12,
          bigSize: 16,
          smallSize: 8,
        },
      },

      data: {
        pages: 1,
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
            total: [],
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
      provider: {
        height: 0,
      },
      transfer: {
        height: 0,
      },
      notes: {
        height: 0,
      },
      detalls: {
        height: 0,
      },
      fonts: {
        fallback: {
          loaded: false,
        },
      },
      document: null,
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

    return transliterate(value);
  }

  /**
   * Generates the header
   *
   * @private
   * @return void
   */
  generateHeader(pageNumber) {
    // Background Rectangle
    // this.document
    //   .rect(
    //     0,
    //     0,
    //     this.document.page.width,
    //     this.options.style.header.height
    //   )
    //   .fill(this.options.style.header.backgroundColor);

    // Add an image to the header if any
    // if (this.options.style.header.image &&
    //   this.options.style.header.image.path) {
    //   this.document.image(
    //     this.options.style.header.image.path,
    //     this.options.style.document.marginLeft,
    //     this.options.style.document.marginTop, {
    //       width  : this.options.style.header.image.width,
    //       height : this.options.style.header.image.height
    //     }
    //   );
    // }

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
    }

    let _fontMargin = 4;

    // Write header details
    this.setCursor('x', this.options.style.header.textPosition);
    this.setCursor('y', this.options.style.document.marginTop + 2);

    this.setText(`CAIXA:`, {
      fontSize: 'heading',
      fontWeight: 'bold',
      color: this.options.style.header.regularColor,
    });

    this.setCursor('y', this.options.style.document.marginTop + 2);
    this.setCursor('x', this.options.style.header.textPosition + 74);

    this.setText(`${pageNumber + 1}/${this.options.data.pages}`, {
      fontSize: 'heading',
      fontWeight: 'bold',
      color: this.options.style.text.secondaryColor,
    });

    this.setCursor('y', this.options.style.document.marginTop + 30);

    const lines = [...this.options.data.invoice.header];

    this.setCursor('x', this.options.style.header.textPosition);

    lines.forEach((line) => {
      line.label &&
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
          fontSize: line.fontSize,
        });
      });
    });

    // this.setCursor("x", this.options.style.document.marginLeft);
    // this.setCursor("y", this.options.style.document.marginTop + 50);

    // const line = { label: 'CAIXA', value: `${pageNumber + 1} / ${this.options.data.pages}`}

    // this.setText(`${line.label}:`, {
    //   fontWeight : "bold",
    //   color      : this.options.style.header.regularColor,
    //   marginTop  : _fontMargin
    // });
    // this.setText(line.value, {
    //   colorCode : "secondary",
    //   color     : this.options.style.header.secondaryColor,
    //   marginTop : _fontMargin
    // });
  }

  /**
   * Generates customer and seller
   *
   * @private
   * @return void
   */
  generateDetails(type) {
    let _maxWidth = 290;
    let _fontMargin = 4;

    let _fontSize = 'regular';

    this.setCursor('y', this.options.style.header.height + 1);
    // Use a different left position
    if (type === 'customer') {
      this.setCursor('y', this.options.style.document.marginTop);
      this.setCursor('x', this.options.style.document.marginLeft);
      _fontSize = 'big';
    } else if (type === 'provider') {
      this.setCursor('y', this.options.style.header.height + 1 - 20);
      this.setCursor('x', this.options.style.header.textPositionProvider);
      // Adjust maxWidth to prevent text overflow: pageWidth(595) - textPosition(330) - marginRight(20) - extraMargin(8)
      _maxWidth = 237;
      _fontSize = 'regular';
    } else if (type === 'transfer') {
      // Start from where provider ended
      this.setCursor('y', this.storage.provider.height);
      this.setCursor('x', this.options.style.header.textPositionProvider);
      // Same width adjustment for transfer section
      _maxWidth = 237;
      _fontSize = 'regular';
    } else if (type === 'notes') {
      // Start from where transfer ended (or provider if no transfer)
      this.setCursor(
        'y',
        this.storage.transfer.height > 0 ? this.storage.transfer.height : this.storage.provider.height,
      );
      this.setCursor('x', this.options.style.header.textPositionProvider);
      _maxWidth = 237;
      _fontSize = 'regular';
    } else if (type === 'detalls') {
      // Start from where notes ended (or transfer/provider if no notes)
      const startY =
        this.storage.notes.height > 0
          ? this.storage.notes.height
          : this.storage.transfer.height > 0
            ? this.storage.transfer.height
            : this.storage.provider.height;
      this.setCursor('y', startY);
      this.setCursor('x', this.options.style.header.textPositionProvider);
      _maxWidth = 237;
      _fontSize = 'regular';
    } else {
      this.setCursor('x', this.options.style.header.textPositionSeller);
    }

    this.options.data.invoice[type].forEach((line) => {
      line.label &&
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
          fontSize: line.fontSize || _fontSize,
        });
      });
    });

    this.storage[type].height = this.storage.cursor.y;
  }

  /**
   * Generates a row
   *
   * @private
   * @param  {string} type
   * @param  {array} columns
   * @return void
   */
  generateTableRow(type, columns) {
    let _fontWeight = 'normal',
      _colorCode = 'secondary';

    this.storage.cursor.y = this.document.y;

    this.storage.cursor.y += 8;

    if (type === 'header') {
      _fontWeight = 'bold';
      _colorCode = 'primary';
    }

    let _start = this.options.style.document.marginLeft;
    let _maxY = this.storage.cursor.y;

    // Computes columns by giving an extra space for the last column \
    //   It is used to keep a perfect alignement
    const totalMaxWidth =
      this.document.page.width -
      this.options.style.document.marginRight -
      this.options.style.document.marginLeft -
      (columns.length - 1) * 10; //this.options.style.header.textPosition -
    // _start -
    // this.options.style.document.marginRight

    let _maxWidth = totalMaxWidth / (columns.length - 2);

    columns.forEach((column, index) => {
      let _value;
      _maxWidth = totalMaxWidth * column.width;
      this.setCursor('x', _start);

      _value = column.value;

      if (column.price === true) {
        _value = this.prettyPrice(_value);
      }

      this.setText(_value, {
        colorCode: _colorCode,
        maxWidth: _maxWidth,
        fontWeight: _fontWeight,
        align: index === 0 ? 'left' : 'right',
        skipDown: true,
      });

      _start += _maxWidth + 10;

      // Increase y position in case of a line return
      if (this.document.y >= _maxY) {
        _maxY = this.document.y;
      }
    });

    const largeColumn = columns.find(
      (column) => column.value && Math.ceil(column.value.toString().length / 55) > 1,
    );
    if (largeColumn) {
      const rowLen = columns.length < 5 ? 55 : 40;
      this.storage.cursor.y += 12.5 * (Math.ceil(largeColumn.value.toString().length / rowLen) - 1);
      if (largeColumn.value.includes('\n')) {
        this.storage.cursor.y += 12.5 * 2;
      }
      // const contains = largeColumn.value.includes('\n')
      // console.log('contains', contains)

      this.setText(' ', {
        colorCode: _colorCode,
        maxWidth: _maxWidth,
        fontWeight: _fontWeight,
        skipDown: false,
      });
    }

    // Set y to the max y position
    this.setCursor('y', _maxY);

    if (type === 'header') {
      this.generateLine();
    }
  }

  /**
   * Generates a line separator
   *
   * @private
   * @return void
   */
  generateLine() {
    this.storage.cursor.y += this.options.style.text.regularSize - 5;

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

    this.setText('\n');

    this.storage.cursor.y += -25;
  }

  /**
   * Generates invoice parts
   *
   * @private
   * @return void
   */
  generatePartsLines(pageNumber) {
    // get details.parts and show only the index of details.parts[pageNumber]
    const part = this.options.data.invoice.details.parts[pageNumber] || [];
    if (part) {
      this.setText(part.value, {
        colorCode: 'secondary',
      });
      // this.storage.cursor.y += 10 * parts.length;
    } else {
      // this.storage.cursor.y = this.document.y;
    }
  }

  /**
   * Generates legal terms
   *
   * @private
   * @return void
   */
  generateLegal() {
    this.storage.cursor.y += 40;

    (this.options.data.invoice.legal || []).forEach((legal) => {
      // this.generateLine();
      this.storage.cursor.y += 8;
      this.setCursor('x', this.options.style.document.marginLeft);

      this.setText(legal.value, {
        fontWeight: legal.weight,
        colorCode: legal.color || 'primary',
        align: 'left',
        marginTop: 0,
        maxWidth: 290,
      });
    });
  }

  generateRectangle(x, y, width, height, color) {
    this.document.rect(x, y, width, height).stroke(color);
  }

  generateFooter() {
    this.storage.cursor.y = 366;
    this.generateLine();
    let _fontMargin = 0;

    this.storage.cursor.y = 376;
    this.setCursor('x', this.options.style.document.marginLeft);
    this.setCursor('y', this.storage.cursor.y);

    let text = this.options.data.invoice['seller'][0].value.join(' · ');

    this.setText(text, {
      colorCode: 'secondary',
      marginTop: _fontMargin,
      fontSize: 'small',
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
    } else if (_fontSize === 'small') {
      _fontSizeValue = this.options.style.text.smallSize;
    } else if (_fontSize === 'big') {
      _fontSizeValue = this.options.style.text.bigSize || 10;
    } else if (_fontSize === 'heading') {
      _fontSizeValue = this.options.style.text.headingSize || 20;
    } else {
      _fontSizeValue = _fontSize;
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
      size: 'A5',
      layout: 'landscape',
      margins: {
        top: 20,
        bottom: 0,
        left: 20,
        right: 20,
      },
    });

    this.loadCustomFonts();
    for (let i = 0; i < this.options.data.pages; i++) {
      this.generateHeader(i);
      this.generateDetails('customer');
      this.generateDetails('provider');
      if (this.options.data.invoice.transfer) {
        this.generateDetails('transfer');
      }
      if (this.options.data.invoice.notes) {
        this.generateDetails('notes');
      }
      if (this.options.data.invoice.detalls) {
        this.generateDetails('detalls');
      }
      this.generateLegal();
      this.generatePartsLines(i);
      this.generateRectangle(20, 260, 222, 80, this.options.style.text.primaryColor);
      this.generateFooter();
      if (i < this.options.data.pages - 1) {
        this.storage.cursor.y = 0;
        this.document.addPage({
          size: 'A5',
          layout: 'landscape',
          margins: {
            top: 20,
            bottom: 0,
            left: 20,
            right: 20,
          },
        });
      }
    }
    //this.generateHeader();

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
